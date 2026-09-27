import { Router, type Request, type Response } from 'express';
import * as z from 'zod';
import { OAUTH_COOKIE, SESSION_COOKIE } from '../auth/sessions.js';
import { AppError, invalid } from '../lib/errors.js';
import { randomSecret, safeEqual } from '../lib/ids.js';
import { log } from '../lib/log.js';
import type { Services } from '../services/index.js';
import { clearCookie, ok, parseCookies, RateLimiter, requireActor, setCookie } from './util.js';

interface OAuthState {
  nonce: string;
  device?: string;
  joinKeyId?: string;
  returnTo?: string;
  exp: number;
}

const safeReturn = (value: unknown) => (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/');

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) throw invalid(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return result.data;
}

export function authRoutes(services: Services, version: string): Router {
  const router = Router();
  const config = services.deps.config;
  const strict = new RateLimiter(20, 15 * 60_000); // brute-force guard for key checks and logins
  const polling = new RateLimiter(120, 60_000);

  const startSession = async (req: Request, res: Response, developerId: string) => {
    const cookie = await services.sessions.create(developerId, { userAgent: req.header('user-agent'), ip: req.ip });
    setCookie(res, SESSION_COOKIE, cookie, { secure: config.cookieSecure, maxAgeSeconds: Math.floor(config.sessionTtlMs / 1000), sameSite: 'Lax' });
  };

  const githubEnabled = () => !!(config.github.oauthClientId && config.github.oauthClientSecret);

  const beginOAuth = (res: Response, state: Omit<OAuthState, 'nonce' | 'exp'>): string => {
    if (!githubEnabled()) throw new AppError('unavailable', 'GitHub login is not configured on this server (GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET).');
    const nonce = randomSecret(18);
    const cookie = services.sessions.signState({ ...state, nonce, exp: services.deps.clock.now() + 10 * 60_000 });
    setCookie(res, OAUTH_COOKIE, cookie, { secure: config.cookieSecure, maxAgeSeconds: 600, sameSite: 'Lax' });
    const params = new URLSearchParams({
      client_id: config.github.oauthClientId!,
      redirect_uri: `${config.publicUrl}/auth/github/callback`,
      scope: 'read:user',
      state: nonce,
      allow_signup: 'false',
    });
    return `https://github.com/login/oauth/authorize?${params}`;
  };

  // ---- public server info & join keys -----------------------------------------------------------

  router.get('/api/server-info', (_req, res) => {
    ok(res, { name: config.serverName, version, githubLogin: githubEnabled(), keyLogin: true, product: 'sbox-collaborator' });
  });

  router.post('/api/auth/server-key/check', strict.middleware(), async (req, res) => {
    const { serverKey } = parse(z.object({ serverKey: z.string().max(200) }), req.body);
    const key = await services.accounts.checkJoinKey(serverKey);
    if (!key) throw new AppError('invalid_server_key', 'That server key is not valid (wrong, expired, revoked or already used).');
    ok(res, { valid: true, serverName: config.serverName, boundTo: key.githubLogin });
  });

  // ---- device sign-in (s&box editor) --------------------------------------------------------------

  router.post('/api/auth/device', strict.middleware(), async (req, res) => {
    const body = parse(z.object({ clientName: z.string().min(1).max(80), clientType: z.string().min(1).max(40), serverKey: z.string().max(200).nullable().optional() }), req.body);
    ok(res, await services.device.start(body));
  });

  router.post('/api/auth/device/token', polling.middleware(), async (req, res) => {
    const { deviceCode } = parse(z.object({ deviceCode: z.string().min(10).max(200) }), req.body);
    const { token, key, developerId } = await services.device.poll(deviceCode);
    const developer = await services.directory.get(developerId);
    ok(res, { token, key, developer });
  });

  router.get('/api/auth/device/:code', async (req, res) => {
    const row = await services.device.pending(String(req.params.code));
    if (!row) throw new AppError('expired_token', 'This sign-in code expired or was already used.');
    ok(res, { userCode: row.userCode, clientName: row.clientName, clientType: row.clientType, hasServerKey: !!row.joinKeyId, expiresAt: new Date(row.expiresAt).toISOString() });
  });

  router.post('/api/auth/device/approve', async (req, res) => {
    const actor = requireActor(req);
    const { userCode } = parse(z.object({ userCode: z.string().min(4).max(20) }), req.body);
    await services.device.approve(userCode, actor.developerId);
    ok(res, { approved: true });
  });

  router.post('/api/auth/device/deny', async (req, res) => {
    requireActor(req);
    const { userCode } = parse(z.object({ userCode: z.string().min(4).max(20) }), req.body);
    await services.device.deny(userCode);
    ok(res, { denied: true });
  });

  // ---- GitHub OAuth ----------------------------------------------------------------------------------

  router.post('/api/auth/github/start', strict.middleware(), async (req, res) => {
    const body = parse(z.object({ serverKey: z.string().max(200).nullable().optional(), device: z.string().max(20).optional(), returnTo: z.string().max(300).optional() }), req.body);
    let joinKeyId: string | undefined;
    if (body.serverKey) {
      const key = await services.accounts.checkJoinKey(body.serverKey);
      if (!key) throw new AppError('invalid_server_key', 'That server key is not valid (wrong, expired, revoked or already used).');
      joinKeyId = key.id;
    }
    const url = beginOAuth(res, { ...(body.device ? { device: body.device.toUpperCase() } : {}), ...(joinKeyId ? { joinKeyId } : {}), returnTo: safeReturn(body.returnTo) });
    ok(res, { url });
  });

  router.get('/auth/github/login', (req, res) => {
    try {
      const device = typeof req.query.device === 'string' ? req.query.device.toUpperCase() : undefined;
      res.redirect(beginOAuth(res, { ...(device ? { device } : {}), returnTo: safeReturn(req.query.returnTo) }));
    } catch (error) {
      res.redirect(`/login?error=${encodeURIComponent((error as Error).message)}`);
    }
  });

  router.get('/auth/github/callback', async (req, res) => {
    const cookies = parseCookies(req.header('cookie'));
    const state = services.sessions.readState<OAuthState>(cookies[OAUTH_COOKIE]);
    clearCookie(res, OAUTH_COOKIE, config.cookieSecure);
    const fail = (message: string, device?: string) =>
      res.redirect(`${device ? `/device?code=${encodeURIComponent(device)}&` : '/login?'}error=${encodeURIComponent(message)}`);
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const nonce = typeof req.query.state === 'string' ? req.query.state : '';
    if (!state || !code || !nonce || !safeEqual(state.nonce, nonce)) return fail('GitHub login expired or was tampered with. Try again.');
    try {
      const accessToken = await services.github.exchangeOAuthCode(config.github.oauthClientId!, config.github.oauthClientSecret!, code, `${config.publicUrl}/auth/github/callback`);
      const user = await services.github.getAuthenticatedUser(accessToken); // the OAuth token is dropped after this call
      let joinKeyId = state.joinKeyId ?? null;
      if (!joinKeyId && state.device) joinKeyId = (await services.device.pending(state.device))?.joinKeyId ?? null;
      const developer = await services.accounts.developerForGithub(user, joinKeyId);
      await startSession(req, res, developer.id);
      if (state.device) {
        await services.device.approve(state.device, developer.id);
        return res.redirect(`/device?code=${encodeURIComponent(state.device)}&approved=1`);
      }
      return res.redirect(safeReturn(state.returnTo));
    } catch (error) {
      if (!(error instanceof AppError)) log.error('github login failed', { error: (error as Error).message });
      return fail(error instanceof AppError ? error.message : 'GitHub login failed', state.device);
    }
  });

  // ---- key login & logout (dashboard) -----------------------------------------------------------------

  router.post('/api/auth/key-login', strict.middleware(), async (req, res) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(200) }), req.body);
    const actor = await services.accounts.authenticateKey(token);
    if (!actor) throw new AppError('unauthorized', 'That access key is not valid.');
    await startSession(req, res, actor.developerId);
    ok(res, { developerId: actor.developerId });
  });

  router.post('/api/auth/logout', async (req, res) => {
    const cookies = parseCookies(req.header('cookie'));
    const sessionId = cookies[SESSION_COOKIE]?.split('.')[0];
    if (sessionId) await services.sessions.revoke(sessionId);
    clearCookie(res, SESSION_COOKIE, config.cookieSecure);
    ok(res, { loggedOut: true });
  });

  return router;
}

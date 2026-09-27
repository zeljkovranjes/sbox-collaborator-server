import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { SESSION_COOKIE } from '../auth/sessions.js';
import type { McpGateway } from '../mcp/server.js';
import { AppError } from '../lib/errors.js';
import { errorFields, log } from '../lib/log.js';
import type { Services } from '../services/index.js';
import { verifyGithubSignature } from '../services/webhooks.js';
import { apiRoutes } from './api-routes.js';
import { authRoutes } from './auth-routes.js';
import { parseCookies, RateLimiter } from './util.js';

export interface AppOptions {
  services: Services;
  mcp: McpGateway;
  version: string;
  startedAt: number;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function createApp({ services, mcp, version, startedAt }: AppOptions) {
  const config = services.deps.config;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  // ---- security headers -----------------------------------------------------------------------
  app.use((req, res, next) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('cross-origin-opener-policy', 'same-origin');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (config.publicUrl.startsWith('https://')) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
    if (!req.path.startsWith('/api') && !req.path.startsWith('/mcp')) {
      res.setHeader(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://github.com",
      );
    }
    next();
  });

  // ---- health -----------------------------------------------------------------------------------
  app.get('/healthz', async (_req, res) => {
    const db = await services.deps.database.ping().catch(() => false);
    res.status(db ? 200 : 503).json({ ok: db, db, version, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), mcpSessions: mcp.sessionCount });
  });

  // ---- git hook script (public: it contains no secrets; keys come from the developer's env) --------
  app.get('/hooks/collab-check.mjs', (_req, res) => {
    const file = join(process.cwd(), 'clients', 'git-hooks', 'collab-check.mjs');
    if (!existsSync(file)) return res.status(404).type('text').send('hook script not found on this server');
    res.type('text/javascript').setHeader('cache-control', 'no-cache');
    return res.sendFile(file);
  });

  // ---- GitHub webhooks (raw body for signature verification) -------------------------------------
  app.post('/webhooks/github', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
    const secret = config.github.webhookSecret;
    if (!secret) return res.status(503).json({ ok: false, error: { code: 'unavailable', message: 'GITHUB_WEBHOOK_SECRET is not configured' } });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifyGithubSignature(secret, body, req.header('x-hub-signature-256'))) {
      log.warn('webhook signature mismatch', { ip: req.ip });
      return res.status(401).json({ ok: false, error: { code: 'unauthorized', message: 'Bad signature' } });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      return res.status(400).json({ ok: false, error: { code: 'invalid_input', message: 'Body is not JSON (set the webhook content type to application/json)' } });
    }
    const result = await services.webhooks.handle(req.header('x-github-event') ?? 'unknown', req.header('x-github-delivery') ?? '', payload);
    return res.json({ ok: true, result });
  });

  // ---- body parsing -------------------------------------------------------------------------------
  app.use('/api/assets/bulk', express.json({ limit: '25mb' }));
  app.use(express.json({ limit: '2mb' }));

  // ---- authentication: bearer key (MCP, editor, scripts) or session cookie (dashboard) ------------
  const keyFailures = new RateLimiter(30, 5 * 60_000);
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const header = req.header('authorization');
      if (header?.toLowerCase().startsWith('bearer ')) {
        const actor = await services.accounts.authenticateKey(header.slice(7));
        if (!actor) {
          if (!keyFailures.hit(req.ip ?? 'unknown')) throw new AppError('rate_limited', 'Too many invalid keys');
          res.setHeader('www-authenticate', 'Bearer realm="collaborator", error="invalid_token"');
          throw new AppError('unauthorized', 'Invalid, expired or revoked access key');
        }
        const agentHeader = req.header('x-collab-agent');
        req.actor = { ...actor, agentId: agentHeader && /^ag_[0-9a-z]{6,20}$/.test(agentHeader) ? agentHeader : null };
        return next();
      }
      if (req.path.startsWith('/mcp')) return next(); // MCP needs a bearer key
      const cookie = parseCookies(req.header('cookie'))[SESSION_COOKIE];
      if (cookie) {
        const actor = await services.sessions.authenticate(cookie);
        if (actor) {
          // Cookie-authenticated writes must carry a custom header: blocks cross-site form posts (CSRF).
          if (MUTATING.has(req.method) && req.header('x-collab-request') !== '1' && req.path.startsWith('/api')) {
            throw new AppError('forbidden', 'Missing X-Collab-Request header');
          }
          const { sessionId: _sessionId, ...rest } = actor;
          req.actor = rest;
          req.viaCookie = true;
        }
      }
      next();
    } catch (error) {
      next(error);
    }
  });

  // ---- MCP -----------------------------------------------------------------------------------------
  app.all('/mcp', async (req, res) => {
    if (!req.actor) {
      res.setHeader('www-authenticate', 'Bearer realm="collaborator"');
      return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Send your access key: Authorization: Bearer sbc_…' }, id: null });
    }
    await mcp.handle(req, res, req.actor);
  });

  app.use(authRoutes(services, version));
  app.use(apiRoutes(services));

  // ---- dashboard (static SPA) ---------------------------------------------------------------------
  const webDir = config.webDir ?? join(process.cwd(), 'dist', 'web');
  if (existsSync(join(webDir, 'index.html'))) {
    app.use(express.static(webDir, { index: false, maxAge: '1h', setHeaders: (res, path) => path.includes(`${join('assets', '')}`) && res.setHeader('cache-control', 'public, max-age=31536000, immutable') }));
    app.get(/^\/(?!api\/|mcp|webhooks\/|auth\/).*/, (_req, res) => {
      res.setHeader('cache-control', 'no-cache');
      res.sendFile(join(webDir, 'index.html'));
    });
  } else {
    log.warn('dashboard not built; run npm run build:web', { webDir });
    app.get('/', (_req, res) => res.type('text').send('Collaborator server is running. Build the dashboard with `npm run build:web`.'));
  }

  // ---- errors -----------------------------------------------------------------------------------------
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (error instanceof AppError) {
      return res.status(error.status).json({ ok: false, error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    }
    const status = (error as { status?: number; statusCode?: number }).status ?? (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return res.status(status).json({ ok: false, error: { code: 'invalid_input', message: (error as Error).message } });
    }
    log.error('request failed', { method: req.method, path: req.path, ...errorFields(error) });
    return res.status(500).json({ ok: false, error: { code: 'internal', message: 'Internal server error' } });
  });

  return app;
}

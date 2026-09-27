import { AppError } from '../lib/errors.js';
import { hmac, newId, randomSecret, safeEqual, sha256, userCode } from '../lib/ids.js';
import { parseJson } from '../lib/json.js';
import { iso } from '../lib/time.js';
import type { Actor, Deps } from '../services/context.js';
import type { Directory } from '../services/directory.js';
import type { AccountService } from './accounts.js';

export const SESSION_COOKIE = 'collab_session';
export const OAUTH_COOKIE = 'collab_oauth';

/** Dashboard login sessions (HttpOnly cookie "<id>.<secret>"; only a hash is stored). */
export class SessionService {
  #lastSeenWrites = new Map<string, number>();

  constructor(
    private readonly deps: Deps,
    private readonly directory: Directory,
  ) {}

  async create(developerId: string, meta: { userAgent?: string | undefined; ip?: string | undefined }): Promise<string> {
    const id = newId(16);
    const secret = randomSecret(32);
    const now = this.deps.clock.now();
    await this.deps.db
      .insertInto('webSessions')
      .values({
        id,
        developerId,
        secretHash: hmac(this.deps.config.secretKey, secret),
        userAgent: meta.userAgent?.slice(0, 200) ?? null,
        ip: meta.ip ?? null,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + this.deps.config.sessionTtlMs,
        revokedAt: null,
      })
      .execute();
    return `${id}.${secret}`;
  }

  async authenticate(cookie: string | undefined): Promise<(Actor & { sessionId: string }) | null> {
    if (!cookie) return null;
    const [id, secret] = cookie.split('.');
    if (!id || !secret) return null;
    const row = await this.deps.db.selectFrom('webSessions').selectAll().where('id', '=', id).executeTakeFirst();
    const now = this.deps.clock.now();
    if (!row || row.revokedAt || row.expiresAt <= now) return null;
    if (!safeEqual(row.secretHash, hmac(this.deps.config.secretKey, secret))) return null;
    const developer = await this.directory.get(row.developerId);
    if (!developer || developer.disabled) return null;
    if (now - (this.#lastSeenWrites.get(id) ?? 0) > 5 * 60_000) {
      this.#lastSeenWrites.set(id, now);
      await this.deps.db.updateTable('webSessions').set({ lastSeenAt: now }).where('id', '=', id).execute();
    }
    return {
      sessionId: id,
      developerId: developer.id,
      displayName: developer.displayName,
      role: developer.role,
      keyId: null,
      // A browser session can do everything its developer can.
      scopes: developer.role === 'admin' ? ['admin'] : ['write'],
      projectIds: developer.projectIds,
      agentId: null,
    };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.deps.db.updateTable('webSessions').set({ revokedAt: this.deps.clock.now() }).where('id', '=', sessionId).execute();
  }

  async list(developerId: string) {
    const rows = await this.deps.db
      .selectFrom('webSessions')
      .selectAll()
      .where('developerId', '=', developerId)
      .where('revokedAt', 'is', null)
      .where('expiresAt', '>', this.deps.clock.now())
      .orderBy('lastSeenAt', 'desc')
      .execute();
    return rows.map((r) => ({ id: r.id, userAgent: r.userAgent, ip: r.ip, createdAt: iso(r.createdAt), lastSeenAt: iso(r.lastSeenAt), expiresAt: iso(r.expiresAt) }));
  }

  // ---- OAuth state (signed cookie) -------------------------------------------------------------

  signState(payload: Record<string, unknown>): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${hmac(this.deps.config.secretKey, `oauth:${body}`)}`;
  }

  readState<T>(value: string | undefined): T | null {
    if (!value) return null;
    const [body, signature] = value.split('.');
    if (!body || !signature || !safeEqual(signature, hmac(this.deps.config.secretKey, `oauth:${body}`))) return null;
    const payload = parseJson<T & { exp?: number }>(Buffer.from(body, 'base64url').toString('utf8'), null as unknown as T & { exp?: number });
    if (!payload || (payload.exp && payload.exp < this.deps.clock.now())) return null;
    return payload;
  }
}

const DEVICE_TTL = 10 * 60_000;
const DEVICE_INTERVAL = 5;

/** Device sign-in for the s&box editor (RFC 8628 style): browser approval hands the editor a key. */
export class DeviceAuthService {
  constructor(
    private readonly deps: Deps,
    private readonly accounts: AccountService,
  ) {}

  async start(input: { clientName: string; clientType: string; serverKey?: string | null }) {
    let joinKeyId: string | null = null;
    if (input.serverKey) {
      const key = await this.accounts.checkJoinKey(input.serverKey);
      if (!key) throw new AppError('invalid_server_key', 'That server key is not valid (wrong, expired, revoked or used up).');
      joinKeyId = key.id;
    }
    const deviceCode = randomSecret(32);
    const now = this.deps.clock.now();
    let code = userCode();
    while (await this.deps.db.selectFrom('deviceAuths').select('id').where('userCode', '=', code).executeTakeFirst()) code = userCode();
    await this.deps.db
      .insertInto('deviceAuths')
      .values({
        id: newId(12),
        deviceCodeHash: sha256(deviceCode),
        userCode: code,
        clientName: input.clientName.trim().slice(0, 80) || 'device',
        clientType: input.clientType.trim().slice(0, 40) || 'other',
        joinKeyId,
        status: 'pending',
        developerId: null,
        keyId: null,
        interval: DEVICE_INTERVAL,
        createdAt: now,
        expiresAt: now + DEVICE_TTL,
        lastPolledAt: null,
      })
      .execute();
    const verificationUri = `${this.deps.config.publicUrl}/device`;
    return {
      deviceCode,
      userCode: code,
      verificationUri,
      verificationUriComplete: `${verificationUri}?code=${code}`,
      interval: DEVICE_INTERVAL,
      expiresIn: DEVICE_TTL / 1000,
    };
  }

  async pending(code: string) {
    const row = await this.deps.db.selectFrom('deviceAuths').selectAll().where('userCode', '=', code.trim().toUpperCase()).executeTakeFirst();
    if (!row || row.status !== 'pending' || row.expiresAt <= this.deps.clock.now()) return null;
    return row;
  }

  async approve(code: string, developerId: string): Promise<void> {
    const row = await this.pending(code);
    if (!row) throw new AppError('expired_token', 'This sign-in code expired or was already used. Start again from the editor.');
    await this.deps.db.updateTable('deviceAuths').set({ status: 'approved', developerId }).where('id', '=', row.id).where('status', '=', 'pending').execute();
  }

  async deny(code: string): Promise<void> {
    const row = await this.pending(code);
    if (row) await this.deps.db.updateTable('deviceAuths').set({ status: 'denied' }).where('id', '=', row.id).execute();
  }

  /** Polling endpoint. Hands out the access key exactly once. */
  async poll(deviceCode: string) {
    const row = await this.deps.db.selectFrom('deviceAuths').selectAll().where('deviceCodeHash', '=', sha256(deviceCode)).executeTakeFirst();
    const now = this.deps.clock.now();
    if (!row) throw new AppError('expired_token', 'Unknown device code');
    if (row.status === 'consumed' || row.expiresAt <= now) throw new AppError('expired_token', 'The sign-in request expired; start again.');
    if (row.status === 'denied') throw new AppError('access_denied', 'Sign-in was denied in the browser.');
    if (row.status === 'pending') {
      const tooFast = row.lastPolledAt && now - row.lastPolledAt < (row.interval - 1) * 1000;
      await this.deps.db.updateTable('deviceAuths').set({ lastPolledAt: now }).where('id', '=', row.id).execute();
      if (tooFast) throw new AppError('slow_down', 'Polling too fast');
      throw new AppError('authorization_pending', 'Waiting for approval in the browser');
    }
    // Approved: mint the key and consume the request atomically.
    const consumed = await this.deps.db.updateTable('deviceAuths').set({ status: 'consumed' }).where('id', '=', row.id).where('status', '=', 'approved').executeTakeFirst();
    if (!Number(consumed.numUpdatedRows)) throw new AppError('expired_token', 'This sign-in was already completed.');
    const { token, key } = await this.accounts.createAccessKey(row.developerId!, { name: row.clientName, scopes: ['write'], via: `device:${row.clientType}` });
    await this.deps.db.updateTable('deviceAuths').set({ keyId: key.id }).where('id', '=', row.id).execute();
    return { token, key, developerId: row.developerId! };
  }

  async sweep(): Promise<void> {
    await this.deps.db.deleteFrom('deviceAuths').where('expiresAt', '<', this.deps.clock.now() - 86_400_000).execute();
  }
}

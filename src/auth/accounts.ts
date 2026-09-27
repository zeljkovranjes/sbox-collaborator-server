import { sql } from 'kysely';
import type { AccessKeyRow, DeveloperRow, JoinKeyRow } from '../db/schema.js';
import { AppError, conflict, invalid, notFound } from '../lib/errors.js';
import { hmac, newId, randomSecret, safeEqual, slug } from '../lib/ids.js';
import { parseJson, toJson } from '../lib/json.js';
import { iso } from '../lib/time.js';
import { intersectProjects, type Actor, type Deps, type Scope } from '../services/context.js';
import type { Directory } from '../services/directory.js';

export const SCOPES: Scope[] = ['read', 'write', 'admin'];

export interface AccessKeyView {
  id: string;
  developerId: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  projectIds: string[] | null;
  createdVia: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface JoinKeyView {
  id: string;
  name: string;
  prefix: string;
  role: 'admin' | 'member';
  githubLogin: string | null;
  maxUses: number | null;
  uses: number;
  projectIds: string[] | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  usable: boolean;
}

const KEY_PATTERN = /^(sbc|sbj)_([0-9a-z]{12})_([A-Za-z0-9_-]{20,})$/;

/** Developers, access keys (per device) and join keys (server keys handed to new teammates). */
export class AccountService {
  #lastUsedWrites = new Map<string, number>();

  constructor(
    private readonly deps: Deps,
    private readonly directory: Directory,
  ) {}

  #hash(secret: string): string {
    return hmac(this.deps.config.secretKey, secret);
  }

  // ---- developers ----------------------------------------------------------------------------

  async createDeveloper(input: { id?: string; displayName: string; githubLogin?: string | null; githubId?: number | null; role?: 'admin' | 'member'; projectIds?: string[] | null }): Promise<DeveloperRow> {
    const base = slug(input.id ?? input.githubLogin ?? input.displayName) || `dev-${newId(4)}`;
    let id = base;
    for (let n = 2; await this.deps.db.selectFrom('developers').select('id').where('id', '=', id).executeTakeFirst(); n++) {
      if (input.id) throw conflict(`Developer "${input.id}" already exists`);
      id = `${base}-${n}`;
    }
    if (input.githubLogin && (await this.directory.byGithubLogin(input.githubLogin))) throw conflict(`GitHub user ${input.githubLogin} is already a developer`);
    const row = await this.deps.db
      .insertInto('developers')
      .values({
        id,
        displayName: input.displayName.trim().slice(0, 60) || id,
        githubLogin: input.githubLogin?.trim() || null,
        githubId: input.githubId ?? null,
        role: input.role ?? 'member',
        projectIds: input.projectIds ? toJson(input.projectIds) : null,
        createdAt: this.deps.clock.now(),
        disabledAt: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    this.directory.invalidate();
    return row;
  }

  async updateDeveloper(id: string, patch: { displayName?: string; githubLogin?: string | null; role?: 'admin' | 'member'; projectIds?: string[] | null; disabled?: boolean; discordUserId?: string | null }): Promise<DeveloperRow> {
    const values: Record<string, unknown> = {};
    if (patch.displayName !== undefined) values.displayName = patch.displayName.trim().slice(0, 60);
    if (patch.githubLogin !== undefined) values.githubLogin = patch.githubLogin?.trim() || null;
    if (patch.role !== undefined) values.role = patch.role;
    if (patch.projectIds !== undefined) values.projectIds = patch.projectIds ? toJson(patch.projectIds) : null;
    if (patch.disabled !== undefined) values.disabledAt = patch.disabled ? this.deps.clock.now() : null;
    if (patch.discordUserId !== undefined) {
      const discord = patch.discordUserId?.trim() || null;
      if (discord && !/^\d{15,22}$/.test(discord)) throw invalid('Discord user ids are 15–22 digits (Discord: Settings ▸ Advanced ▸ Developer Mode, then right-click your name ▸ Copy User ID)');
      values.discordUserId = discord;
    }
    if (!Object.keys(values).length) throw invalid('Nothing to update');
    const row = await this.deps.db.updateTable('developers').set(values).where('id', '=', id).returningAll().executeTakeFirst();
    if (!row) throw notFound(`Developer "${id}"`);
    if (patch.disabled) {
      // Disabling someone ends their sessions immediately; keys stop working through the disabled check.
      await this.deps.db.updateTable('webSessions').set({ revokedAt: this.deps.clock.now() }).where('developerId', '=', id).where('revokedAt', 'is', null).execute();
    }
    this.directory.invalidate();
    return row;
  }

  async listDevelopers() {
    const rows = await this.deps.db.selectFrom('developers').selectAll().orderBy('createdAt').execute();
    return rows.map((r) => ({
      id: r.id,
      displayName: r.displayName,
      githubLogin: r.githubLogin,
      role: r.role,
      projectIds: parseJson<string[] | null>(r.projectIds, null),
      createdAt: iso(r.createdAt)!,
      disabled: r.disabledAt != null,
    }));
  }

  // ---- access keys ---------------------------------------------------------------------------

  #keyView(row: AccessKeyRow): AccessKeyView {
    return {
      id: row.id,
      developerId: row.developerId,
      name: row.name,
      prefix: row.prefix,
      scopes: parseJson<Scope[]>(row.scopes, []),
      projectIds: parseJson<string[] | null>(row.projectIds, null),
      createdVia: row.createdVia,
      createdAt: iso(row.createdAt)!,
      lastUsedAt: iso(row.lastUsedAt),
      expiresAt: iso(row.expiresAt),
      revokedAt: iso(row.revokedAt),
    };
  }

  async createAccessKey(
    developerId: string,
    input: { name: string; scopes?: Scope[]; projectIds?: string[] | null; via: string; expiresInDays?: number | null },
  ): Promise<{ token: string; key: AccessKeyView }> {
    const developer = await this.deps.db.selectFrom('developers').selectAll().where('id', '=', developerId).executeTakeFirst();
    if (!developer || developer.disabledAt) throw notFound(`Developer "${developerId}"`);
    const scopes = [...new Set<Scope>(input.scopes ?? ['write'])];
    if (!scopes.length || scopes.some((s) => !SCOPES.includes(s))) throw invalid(`Scopes must be some of ${SCOPES.join(', ')}`);
    if (scopes.includes('admin') && developer.role !== 'admin') throw invalid('Only admins can hold admin keys');
    const id = newId(12);
    const secret = randomSecret(32);
    const token = `sbc_${id}_${secret}`;
    const now = this.deps.clock.now();
    const row = await this.deps.db
      .insertInto('accessKeys')
      .values({
        id,
        developerId,
        name: input.name.trim().slice(0, 80) || 'access key',
        prefix: token.slice(0, 20),
        secretHash: this.#hash(secret),
        scopes: toJson(scopes),
        projectIds: input.projectIds ? toJson(input.projectIds) : null,
        createdVia: input.via,
        createdAt: now,
        lastUsedAt: null,
        expiresAt: input.expiresInDays ? now + input.expiresInDays * 86_400_000 : null,
        revokedAt: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { token, key: this.#keyView(row) };
  }

  /** Resolves a bearer token to an actor, or null. Constant-time secret comparison. */
  async authenticateKey(token: string): Promise<Actor | null> {
    const match = KEY_PATTERN.exec(token.trim());
    if (!match || match[1] !== 'sbc') return null;
    const [, , id, secret] = match as unknown as [string, string, string, string];
    const row = await this.deps.db.selectFrom('accessKeys').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row || !safeEqual(row.secretHash, this.#hash(secret))) return null;
    const now = this.deps.clock.now();
    if (row.revokedAt || (row.expiresAt && row.expiresAt <= now)) return null;
    const developer = await this.directory.get(row.developerId);
    if (!developer || developer.disabled) return null;
    if (now - (this.#lastUsedWrites.get(id) ?? 0) > 60_000) {
      this.#lastUsedWrites.set(id, now);
      await this.deps.db.updateTable('accessKeys').set({ lastUsedAt: now }).where('id', '=', id).execute();
    }
    const scopes = parseJson<Scope[]>(row.scopes, []).filter((s) => s !== 'admin' || developer.role === 'admin');
    return {
      developerId: developer.id,
      displayName: developer.displayName,
      role: developer.role,
      keyId: row.id,
      scopes,
      projectIds: intersectProjects(developer.projectIds, parseJson<string[] | null>(row.projectIds, null)),
      agentId: null,
    };
  }

  async listAccessKeys(developerId?: string): Promise<AccessKeyView[]> {
    let query = this.deps.db.selectFrom('accessKeys').selectAll();
    if (developerId) query = query.where('developerId', '=', developerId);
    return (await query.orderBy('createdAt', 'desc').execute()).map((r) => this.#keyView(r));
  }

  async revokeAccessKey(actor: Actor, keyId: string): Promise<AccessKeyView> {
    const row = await this.deps.db.selectFrom('accessKeys').selectAll().where('id', '=', keyId).executeTakeFirst();
    if (!row) throw notFound(`Access key ${keyId}`);
    if (row.developerId !== actor.developerId && actor.role !== 'admin') throw new AppError('forbidden', 'You can only revoke your own keys');
    const updated = await this.deps.db
      .updateTable('accessKeys')
      .set({ revokedAt: row.revokedAt ?? this.deps.clock.now() })
      .where('id', '=', keyId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.#keyView(updated);
  }

  // ---- join keys (server keys) -----------------------------------------------------------------

  #joinView(row: JoinKeyRow): JoinKeyView {
    const now = this.deps.clock.now();
    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      role: row.role,
      githubLogin: row.githubLogin,
      maxUses: row.maxUses,
      uses: row.uses,
      projectIds: parseJson<string[] | null>(row.projectIds, null),
      createdAt: iso(row.createdAt)!,
      expiresAt: iso(row.expiresAt),
      revokedAt: iso(row.revokedAt),
      usable: !row.revokedAt && (!row.expiresAt || row.expiresAt > now) && (row.maxUses == null || row.uses < row.maxUses),
    };
  }

  async createJoinKey(input: {
    name: string;
    role?: 'admin' | 'member';
    githubLogin?: string | null;
    maxUses?: number | null;
    expiresInDays?: number | null;
    projectIds?: string[] | null;
    createdBy?: string | null;
  }): Promise<{ token: string; key: JoinKeyView }> {
    const id = newId(12);
    const secret = randomSecret(24);
    const token = `sbj_${id}_${secret}`;
    const now = this.deps.clock.now();
    const row = await this.deps.db
      .insertInto('joinKeys')
      .values({
        id,
        name: input.name.trim().slice(0, 80) || 'server key',
        prefix: token.slice(0, 20),
        secretHash: this.#hash(secret),
        role: input.role ?? 'member',
        githubLogin: input.githubLogin?.trim().toLowerCase() || null,
        maxUses: input.maxUses ?? 1,
        uses: 0,
        projectIds: input.projectIds ? toJson(input.projectIds) : null,
        createdBy: input.createdBy ?? null,
        createdAt: now,
        expiresAt: input.expiresInDays === null ? null : now + (input.expiresInDays ?? 14) * 86_400_000,
        revokedAt: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { token, key: this.#joinView(row) };
  }

  /** Returns the join key when the token is valid and still usable. */
  async checkJoinKey(token: string | null | undefined): Promise<JoinKeyRow | null> {
    if (!token) return null;
    const match = KEY_PATTERN.exec(token.trim());
    if (!match || match[1] !== 'sbj') return null;
    const row = await this.deps.db.selectFrom('joinKeys').selectAll().where('id', '=', match[2]!).executeTakeFirst();
    if (!row || !safeEqual(row.secretHash, this.#hash(match[3]!))) return null;
    return this.#joinView(row).usable ? row : null;
  }

  async listJoinKeys(): Promise<JoinKeyView[]> {
    return (await this.deps.db.selectFrom('joinKeys').selectAll().orderBy('createdAt', 'desc').execute()).map((r) => this.#joinView(r));
  }

  async revokeJoinKey(id: string): Promise<JoinKeyView> {
    const row = await this.deps.db.updateTable('joinKeys').set({ revokedAt: this.deps.clock.now() }).where('id', '=', id).returningAll().executeTakeFirst();
    if (!row) throw notFound(`Server key ${id}`);
    return this.#joinView(row);
  }

  /**
   * The developer behind a GitHub login. Existing developers just sign in; a new GitHub account
   * needs a usable join key (or to be listed in ADMIN_GITHUB_LOGINS) and consumes one use of it.
   */
  async developerForGithub(user: { id: number; login: string; name: string | null }, joinKeyId: string | null): Promise<DeveloperRow> {
    const existing = await this.deps.db
      .selectFrom('developers')
      .selectAll()
      .where((eb) => eb.or([eb('githubId', '=', user.id), eb(sql`lower(github_login)`, '=', user.login.toLowerCase())]))
      .executeTakeFirst();
    if (existing) {
      if (existing.disabledAt) throw new AppError('forbidden', 'This account is disabled on this server.');
      if (existing.githubId !== user.id || existing.githubLogin !== user.login) {
        await this.deps.db.updateTable('developers').set({ githubId: user.id, githubLogin: user.login }).where('id', '=', existing.id).execute();
        this.directory.invalidate();
      }
      return existing;
    }

    if (this.deps.config.adminGithubLogins.includes(user.login.toLowerCase())) {
      return this.createDeveloper({ displayName: user.name || user.login, githubLogin: user.login, githubId: user.id, role: 'admin' });
    }
    if (!joinKeyId) throw new AppError('invalid_server_key', `GitHub account ${user.login} is not on this server yet. Ask the server owner for a server key and enter it first.`);
    return this.deps.db.transaction().execute(async (trx) => {
      const key = await trx.selectFrom('joinKeys').selectAll().where('id', '=', joinKeyId).executeTakeFirst();
      if (!key || !this.#joinView(key).usable) throw new AppError('invalid_server_key', 'That server key is no longer valid. Ask for a new one.');
      if (key.githubLogin && key.githubLogin !== user.login.toLowerCase()) throw new AppError('invalid_server_key', `That server key is reserved for GitHub user ${key.githubLogin}.`);
      const consumed = await trx
        .updateTable('joinKeys')
        .set({ uses: key.uses + 1 })
        .where('id', '=', key.id)
        .where('uses', '=', key.uses)
        .executeTakeFirst();
      if (!Number(consumed.numUpdatedRows)) throw new AppError('conflict', 'The server key was used at the same moment; try again.');
      const base = slug(user.login) || `dev-${newId(4)}`;
      let id = base;
      for (let n = 2; await trx.selectFrom('developers').select('id').where('id', '=', id).executeTakeFirst(); n++) id = `${base}-${n}`;
      const row = await trx
        .insertInto('developers')
        .values({
          id,
          displayName: (user.name || user.login).slice(0, 60),
          githubLogin: user.login,
          githubId: user.id,
          role: key.role,
          projectIds: key.projectIds,
          createdAt: this.deps.clock.now(),
          disabledAt: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      this.directory.invalidate();
      return row;
    });
  }
}

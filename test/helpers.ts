import { PGlite } from '@electric-sql/pglite';
import { CamelCasePlugin, Kysely, PGliteDialect } from 'kysely';
import { loadConfig } from '../src/config.js';
import { openDatabase, postgresHandle, type DatabaseHandle } from '../src/db/index.js';
import type { Database } from '../src/db/schema.js';
import type { Actor } from '../src/services/context.js';
import { GitHubClient } from '../src/services/github.js';
import { createServices, type Services } from '../src/services/index.js';

export type DbKind = 'sqlite' | 'postgres';
export const DB_KINDS: DbKind[] = ['sqlite', 'postgres'];

export class FakeClock {
  t = Date.UTC(2026, 8, 1, 12, 0, 0);
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

export const MINUTE = 60_000;

export const TEST_ENV = {
  SECRET_KEY: 'test-secret-key-that-is-long-enough-0123456789',
  SQLITE_PATH: ':memory:',
  PUBLIC_URL: 'http://localhost',
  GITHUB_WEBHOOK_SECRET: 'webhook-secret',
  AGENT_OFFLINE_AFTER: '15m',
  RESERVATION_GRACE: '45m',
  MESSAGE_RATE_LIMIT: '5',
  LOG_LEVEL: 'error',
};

async function openTestDatabase(kind: DbKind): Promise<DatabaseHandle> {
  if (kind === 'sqlite') return openDatabase({ kind: 'sqlite', path: ':memory:' });
  const pglite = new PGlite({ parsers: { 20: (value: string) => Number(value) } });
  const db = new Kysely<Database>({ dialect: new PGliteDialect({ pglite }), plugins: [new CamelCasePlugin()] });
  return postgresHandle(db);
}

export interface World {
  services: Services;
  clock: FakeClock;
  database: DatabaseHandle;
  chomnr: Actor;
  friend: Actor;
  chomnrToken: string;
  friendToken: string;
  close(): Promise<void>;
}

/** A fresh database with two developers, one project and an access key each. */
export async function world(kind: DbKind, env: Record<string, string> = {}): Promise<World> {
  const config = loadConfig({ ...TEST_ENV, ...env });
  const clock = new FakeClock();
  const database = await openTestDatabase(kind);
  const offlineGithub = new GitHubClient(null, 'http://github.invalid', (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch);
  const services = createServices({ config, database, clock, github: offlineGithub });
  await services.accounts.createDeveloper({ id: 'chomnr', displayName: 'chomnr', githubLogin: 'chomnr', role: 'admin' });
  await services.accounts.createDeveloper({ id: 'friend', displayName: 'Friend', githubLogin: 'friendgh' });
  await services.projects.create(null, { id: 'sailing', name: 'Sailing', kind: 'game', repos: ['chomnr/sailing'] });
  const a = await services.accounts.createAccessKey('chomnr', { name: 'desk', via: 'test' });
  const b = await services.accounts.createAccessKey('friend', { name: 'laptop', via: 'test' });
  const chomnr = (await services.accounts.authenticateKey(a.token))!;
  const friend = (await services.accounts.authenticateKey(b.token))!;
  return { services, clock, database, chomnr, friend, chomnrToken: a.token, friendToken: b.token, close: () => database.close() };
}

/** Registers an agent and returns the actor acting as it. */
export async function asAgent(w: World, actor: Actor, clientType = 'claude-code', machine = 'PC'): Promise<Actor> {
  const agent = await w.services.agents.register(actor, { project: 'sailing', clientType, machine });
  return { ...actor, agentId: agent.id };
}

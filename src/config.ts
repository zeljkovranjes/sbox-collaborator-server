import { readFileSync } from 'node:fs';
import { parseDuration } from './lib/time.js';

export interface Config {
  port: number;
  host: string;
  publicUrl: string;
  serverName: string;
  database: { kind: 'postgres'; url: string } | { kind: 'sqlite'; path: string };
  /** Server secret: signs cookies and OAuth state, peppers key hashes. */
  secretKey: string;
  github: {
    token: string | null;
    webhookSecret: string | null;
    oauthClientId: string | null;
    oauthClientSecret: string | null;
    apiUrl: string;
  };
  agentOfflineAfterMs: number;
  reservationGraceMs: number;
  reservationDefaultTtlMs: number;
  reservationMaxTtlMs: number;
  messageRateLimit: number;
  sessionTtlMs: number;
  trustProxy: boolean | number | string;
  cookieSecure: boolean;
  webDir: string | null;
  /** GitHub logins that become admins on their first GitHub login (bootstrap). */
  adminGithubLogins: string[];
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

type Env = Record<string, string | undefined>;

/** Reads `NAME`, or the contents of the file named by `NAME_FILE` (Docker secrets). */
function secret(env: Env, name: string): string | null {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim() || null;
  const value = env[name]?.trim();
  return value ? value : null;
}

function int(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

function duration(env: Env, name: string, fallback: string): number {
  return parseDuration(env[name] || fallback, name);
}

export function loadConfig(env: Env = process.env): Config {
  const port = int(env, 'PORT', 8080);
  const publicUrl = (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  const databaseUrl = secret(env, 'DATABASE_URL');
  const database: Config['database'] =
    databaseUrl && /^postgres(ql)?:\/\//.test(databaseUrl)
      ? { kind: 'postgres', url: databaseUrl }
      : { kind: 'sqlite', path: env.SQLITE_PATH || databaseUrl || './data/collaborator.sqlite' };

  const secretKey = secret(env, 'SECRET_KEY');
  if (!secretKey || secretKey.length < 32) {
    throw new Error('SECRET_KEY must be set to at least 32 random characters (openssl rand -hex 32).');
  }

  const trustProxyRaw = env.TRUST_PROXY ?? 'loopback';
  const trustProxy =
    trustProxyRaw === 'true' ? true : trustProxyRaw === 'false' ? false : /^\d+$/.test(trustProxyRaw) ? Number(trustProxyRaw) : trustProxyRaw;

  const logLevel = (env.LOG_LEVEL || 'info') as Config['logLevel'];
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) throw new Error(`LOG_LEVEL "${logLevel}" is not valid`);

  return {
    port,
    host: env.HOST || '0.0.0.0',
    publicUrl,
    serverName: env.SERVER_NAME || 'Collaborator',
    database,
    secretKey,
    github: {
      token: secret(env, 'GITHUB_TOKEN'),
      webhookSecret: secret(env, 'GITHUB_WEBHOOK_SECRET'),
      oauthClientId: env.GITHUB_OAUTH_CLIENT_ID?.trim() || null,
      oauthClientSecret: secret(env, 'GITHUB_OAUTH_CLIENT_SECRET'),
      apiUrl: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
    },
    agentOfflineAfterMs: duration(env, 'AGENT_OFFLINE_AFTER', '15m'),
    reservationGraceMs: duration(env, 'RESERVATION_GRACE', '45m'),
    reservationDefaultTtlMs: duration(env, 'RESERVATION_DEFAULT_TTL', '4h'),
    reservationMaxTtlMs: duration(env, 'RESERVATION_MAX_TTL', '72h'),
    messageRateLimit: int(env, 'MESSAGE_RATE_LIMIT', 20),
    sessionTtlMs: duration(env, 'SESSION_TTL', '30d'),
    trustProxy,
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : publicUrl.startsWith('https://'),
    webDir: env.WEB_DIR || null,
    adminGithubLogins: (env.ADMIN_GITHUB_LOGINS || '')
      .split(',')
      .map((login) => login.trim().toLowerCase())
      .filter(Boolean),
    logLevel,
  };
}

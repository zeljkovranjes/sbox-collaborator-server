import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors.js';
import type { Actor } from '../services/context.js';

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      /* ignore malformed cookie */
    }
  }
  return out;
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  secure: boolean;
  path?: string;
  sameSite?: 'Strict' | 'Lax';
}

export function setCookie(res: Response, name: string, value: string, options: CookieOptions): void {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? '/'}`, 'HttpOnly', `SameSite=${options.sameSite ?? 'Lax'}`];
  if (options.secure) parts.push('Secure');
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${options.maxAgeSeconds}`);
  res.append('Set-Cookie', parts.join('; '));
}

export const clearCookie = (res: Response, name: string, secure: boolean) => setCookie(res, name, '', { secure, maxAgeSeconds: 0 });

export function ok(res: Response, result: unknown, notices?: string[]): void {
  res.json({ ok: true, result, ...(notices?.length ? { notices } : {}) });
}

/** Fixed-window limiter keyed by caller (IP or key). Good enough for a small self-hosted team. */
export class RateLimiter {
  #windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  hit(key: string, now = Date.now()): boolean {
    const window = this.#windows.get(key);
    if (!window || now - window.start >= this.windowMs) {
      this.#windows.set(key, { start: now, count: 1 });
      if (this.#windows.size > 10_000) this.#prune(now);
      return true;
    }
    window.count++;
    return window.count <= this.limit;
  }

  #prune(now: number) {
    for (const [key, window] of this.#windows) if (now - window.start >= this.windowMs) this.#windows.delete(key);
  }

  middleware(keyOf: (req: Request) => string = (req) => req.ip ?? 'unknown') {
    return (req: Request, _res: Response, next: NextFunction) => {
      if (!this.hit(keyOf(req))) return next(new AppError('rate_limited', 'Too many requests, slow down'));
      next();
    };
  }
}

declare module 'express-serve-static-core' {
  interface Request {
    actor?: Actor;
    viaCookie?: boolean;
  }
}

export function requireActor(req: Request): Actor {
  if (!req.actor) throw new AppError('unauthorized', 'Sign in or send an access key (Authorization: Bearer sbc_…)');
  return req.actor;
}

export function queryString(req: Request, name: string): string | undefined {
  const value = req.query[name];
  return typeof value === 'string' && value ? value : undefined;
}

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijkmnopqrstuvwxyz'; // no "l": easier to read aloud

/** Random lowercase id, e.g. "k3f9x2mq7z". */
export function newId(length = 12): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

export const randomSecret = (bytes = 32) => randomBytes(bytes).toString('base64url');

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export const hmac = (key: string, value: string) => createHmac('sha256', key).update(value).digest('base64url');

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Human-friendly code like "WDJB-MJHT" (no easily confused letters). */
export function userCode(): string {
  const letters = 'BCDFGHJKLMNPQRSTVWXZ';
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += letters[bytes[i]! % letters.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

export const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

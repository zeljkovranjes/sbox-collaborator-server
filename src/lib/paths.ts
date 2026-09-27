import { invalid } from './errors.js';

/**
 * Normalises a project-relative path: forward slashes, no leading "./" or "/", no "..".
 * A trailing slash is kept: it marks a directory.
 */
export function normalizePath(input: string): string {
  const raw = input.trim().replace(/\\/g, '/');
  if (!raw) throw invalid('Path is empty');
  const isDirectory = raw.endsWith('/');
  const parts: string[] = [];
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') throw invalid(`Path "${input}" must not contain ".."`);
    parts.push(part);
  }
  if (parts.length === 0) throw invalid(`Path "${input}" is empty`);
  if (/^[a-zA-Z]:$/.test(parts[0]!)) throw invalid(`Path "${input}" must be relative to the project root, not absolute`);
  const path = parts.join('/');
  if (path.length > 512) throw invalid('Path is longer than 512 characters');
  return isDirectory ? `${path}/` : path;
}

/** Case-insensitive key (Windows and macOS developers share repositories). */
export const pathKey = (path: string) => normalizePath(path).toLowerCase();

export const isDirectoryPath = (path: string) => path.endsWith('/');

export type Overlap = 'exact' | 'inside' | 'contains' | null;

/**
 * How `candidate` relates to an existing reserved path:
 * exact – same file/dir; inside – candidate lies inside the reserved dir;
 * contains – candidate is a dir that contains the reserved path.
 */
export function overlap(candidateKey: string, reservedKey: string): Overlap {
  const candidate = candidateKey.replace(/\/$/, '');
  const reserved = reservedKey.replace(/\/$/, '');
  if (candidate === reserved) return 'exact';
  if (isDirectoryPath(reservedKey) && candidate.startsWith(`${reserved}/`)) return 'inside';
  if (isDirectoryPath(candidateKey) && reserved.startsWith(`${candidate}/`)) return 'contains';
  return null;
}

export function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of paths) {
    const path = normalizePath(raw);
    seen.set(path.toLowerCase(), path);
  }
  return [...seen.values()];
}

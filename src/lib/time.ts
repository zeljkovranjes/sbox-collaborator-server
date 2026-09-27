const UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parses "90s", "15m", "4h", "2d" or a plain millisecond count. */
export function parseDuration(value: string, name = 'duration'): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/.exec(value);
  if (!match) throw new Error(`${name}: "${value}" is not a duration (use e.g. 30s, 15m, 4h, 2d)`);
  return Math.round(Number(match[1]) * UNITS[match[2] ?? 'ms']!);
}

export const iso = (ms: number | null | undefined): string | null => (ms == null ? null : new Date(Number(ms)).toISOString());

/** Accepts an ISO date, epoch ms, or a relative duration ("2h" = two hours ago). */
export function parseSince(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined;
  if (/^\d+(\.\d+)?(ms|s|m|h|d)$/.test(value.trim())) return now - parseDuration(value);
  if (/^\d{10,}$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`"${value}" is not a date or duration`);
  return parsed;
}

/** "3m ago", "2h ago", "4d ago" – for compact text packets. */
export function ago(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

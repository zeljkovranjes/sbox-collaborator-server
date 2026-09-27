/** JSON text columns: tolerant parsing so a bad row never takes a request down. */
export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text == null || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export const toJson = (value: unknown) => JSON.stringify(value ?? null);

export const list = (text: string | null | undefined): string[] => parseJson<string[]>(text, []);

/** Drops null/undefined/empty-array fields: keeps tool results small for LLM context. */
export function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(compact) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      if (field === null || field === undefined) continue;
      if (Array.isArray(field) && field.length === 0) continue;
      out[key] = compact(field);
    }
    return out as T;
  }
  return value;
}

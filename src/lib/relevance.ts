const STOP = new Set(
  'a an and are as at be but by for from has have i in into is it its of on or that the this to was were will with we you our not do does can should use using work working'.split(
    ' ',
  ),
);

/** Lowercase word tokens; splits camelCase and paths so "BoatController.cs" matches "boat". */
export function tokenize(text: string | null | undefined): string[] {
  if (!text) return [];
  const spaced = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
  const out: string[] = [];
  for (const word of spaced.split(/[^a-z0-9&]+/)) {
    if (word.length < 2 || STOP.has(word)) continue;
    out.push(word.length > 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word);
  }
  return out;
}

export function tokenSet(...texts: (string | null | undefined)[]): Set<string> {
  const set = new Set<string>();
  for (const text of texts) for (const token of tokenize(text)) set.add(token);
  return set;
}

/** How many query tokens appear in the document (prefix matches count half). */
export function matchScore(query: Set<string>, doc: Set<string>): number {
  if (query.size === 0) return 0;
  let score = 0;
  for (const token of query) {
    if (doc.has(token)) {
      score += 1;
      continue;
    }
    if (token.length < 4) continue;
    for (const candidate of doc) {
      if (candidate.length >= 4 && (candidate.startsWith(token) || token.startsWith(candidate))) {
        score += 0.5;
        break;
      }
    }
  }
  return score;
}

/** Exponential recency weight with the given half-life. */
export const recency = (at: number, now: number, halfLifeMs: number) => Math.pow(0.5, Math.max(0, now - at) / halfLifeMs);

export function truncate(text: string | null | undefined, max: number): string {
  if (!text) return '';
  const clean = text.trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

import { normalizeName } from './text.js';

/** Sørensen–Dice similarity of two texts by letter pairs, 0 to 1 (1 = the same after the caller's normalisation) */
export function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s: string): Map<string, number> => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); } return m; };
  const ga = grams(a), gb = grams(b);
  let hit = 0;
  for (const [g, n] of ga) hit += Math.min(n, gb.get(g) ?? 0);
  return (2 * hit) / (a.length - 1 + b.length - 1);
}

/** how alike two product names are, ignoring spelling variants, digits' script, word order and punctuation */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a), nb = normalizeName(b);
  if (na === nb) return 1;
  const sorted = (s: string): string => s.split(' ').sort().join(' ');
  return Math.max(dice(na, nb), dice(sorted(na), sorted(nb)));
}

export interface SimilarPair { a: number; b: number; score: number }
/**
 * names in one list that are probably the same thing ("بيبسى 330 مل" and "بيبسي ٣٣٠ملي"): pairs scoring at least `threshold`, best first. Names are compared inside blocks that share their
 * first letters and similar length, so a 50 thousand row file does not compare every pair; the caller decides what to do with a pair (a warning, a merge suggestion), nothing here merges.
 */
export function similarPairs(names: string[], opts: { threshold?: number; limit?: number } = {}): SimilarPair[] {
  const threshold = opts.threshold ?? 0.9, limit = opts.limit ?? 200;
  const norm = names.map(normalizeName);
  const blocks = new Map<string, number[]>();
  norm.forEach((n, i) => { if (n.length < 3) return; const k = n.slice(0, 2); (blocks.get(k) ?? blocks.set(k, []).get(k)!).push(i); });
  const out: SimilarPair[] = [];
  for (const idx of blocks.values()) {
    const part = idx.length > 4000 ? idx.slice(0, 4000) : idx;
    for (let x = 0; x < part.length; x++) for (let y = x + 1; y < part.length; y++) {
      const i = part[x]!, j = part[y]!;
      if (Math.abs(norm[i]!.length - norm[j]!.length) > 4) continue;
      const s = norm[i] === norm[j] ? 1 : dice(norm[i]!, norm[j]!);
      if (s >= threshold) out.push({ a: i, b: j, score: Math.round(s * 100) / 100 });
    }
  }
  return out.sort((p, q) => q.score - p.score || p.a - q.a).slice(0, limit);
}

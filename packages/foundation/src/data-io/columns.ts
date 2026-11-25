import { asciiDigits, normalizeHeader, parseDecimal } from './text.js';
import { dice } from './similar.js';

/**
 * What a product says about one field it can import: the key, how it is read, the names other systems and people give its column, and whether it is sensitive (a price, a cost,
 * a balance: changes to these are always shown to the owner before they are saved, and a value that came from AI is flagged).
 */
export type FieldType = 'text' | 'money' | 'qty' | 'int' | 'code' | 'barcode' | 'bool' | 'date' | 'enum';
export interface FieldSpec {
  key: string;
  /** Arabic label shown to the owner */
  label: string;
  type: FieldType;
  required?: boolean;
  /** column titles that mean this field (any language, any system); compared after normalisation */
  aliases: string[];
  sensitive?: boolean;
  /** for `enum`: the allowed values, each with the words that mean it ("kg" = كيلو) */
  options?: Array<{ value: string; words: string[] }>;
  max?: number;
  /** a sample for the downloadable template */
  example?: string;
}

export interface MappedColumn { index: number; header: string; key: string | null; how: 'exact' | 'similar' | 'manual' | null }
export interface ColumnMap { columns: MappedColumn[]; missingRequired: string[] }

/**
 * Matches the file's header row to a product's fields. Exact (after normalisation) first, then a close spelling (>= 0.86 similarity, shown to the owner as a guess), then the owner's
 * own choices (`manual`: column index to field key, or null to ignore the column). A field takes one column: the first that matches; a second column with the same meaning stays unmapped
 * and is listed, never silently merged.
 */
export function mapColumns(headers: string[], fields: FieldSpec[], manual: Record<number, string | null> = {}): ColumnMap {
  const alias = new Map<string, string>();
  for (const f of fields) for (const a of [f.key, f.label, ...f.aliases]) alias.set(normalizeHeader(a), f.key);
  const used = new Set<string>();
  const cols: MappedColumn[] = headers.map((header, index) => ({ index, header, key: null, how: null }));
  for (const c of cols) if (c.index in manual) {
    const k = manual[c.index] ?? null;
    if (k && fields.some((f) => f.key === k) && !used.has(k)) { c.key = k; c.how = 'manual'; used.add(k); }
    else if (k === null) c.how = 'manual';
  }
  for (const c of cols) {
    if (c.how === 'manual') continue;
    const k = alias.get(normalizeHeader(c.header));
    if (k && !used.has(k)) { c.key = k; c.how = 'exact'; used.add(k); }
  }
  for (const c of cols) {
    if (c.how !== null) continue;
    const h = normalizeHeader(c.header);
    if (h.length < 4) continue;
    let best: { k: string; s: number } | null = null;
    for (const [a, k] of alias) if (!used.has(k) && a.length >= 4) { const s = dice(h, a); if (s >= 0.86 && (!best || s > best.s)) best = { k, s }; }
    if (best) { c.key = best.k; c.how = 'similar'; used.add(best.k); }
  }
  return { columns: cols, missingRequired: fields.filter((f) => f.required && !used.has(f.key)).map((f) => f.key) };
}

export type Coerced = { ok: true; value: string | boolean | null } | { ok: false; code: string };

const TRUE = new Set(['1', 'true', 'yes', 'y', 'نعم', 'ايوه', 'ايوا', 'اه', 'صح', 'x', '✓']), FALSE = new Set(['0', 'false', 'no', 'n', 'لا', 'خطا', '']);
/** one cell to the canonical text a product validates further: money and quantities as decimals, codes without spaces, booleans and dates normalised; empty is `null` */
export function coerce(f: FieldSpec, raw: string): Coerced {
  const s = String(raw ?? '').trim();
  if (s === '') return { ok: true, value: null };
  switch (f.type) {
    case 'money': case 'qty': { const d = parseDecimal(s); return d === null ? { ok: false, code: 'bad_' + f.type } : { ok: true, value: d }; }
    case 'int': { const d = parseDecimal(s); return d !== null && /^-?\d+$/.test(d) ? { ok: true, value: d } : { ok: false, code: 'bad_int' }; }
    case 'barcode': {
      let c = asciiDigits(s).replace(/\s+/g, '');
      if (/^\d+\.0+$/.test(c)) c = c.replace(/\.0+$/, '');                         // Excel stores 6221031234567 as 6221031234567.0
      if (/^\d(\.\d+)?[eE]\+?\d+$/.test(c)) return { ok: false, code: 'barcode_scientific' };    // Excel turned it into 6.22E+12: the digits are gone
      return { ok: true, value: c };
    }
    case 'code': return { ok: true, value: asciiDigits(s).replace(/\s+/g, '') };
    case 'bool': { const k = normalizeHeader(s); return TRUE.has(k) ? { ok: true, value: true } : FALSE.has(k) ? { ok: true, value: false } : { ok: false, code: 'bad_bool' }; }
    case 'date': {
      const t = asciiDigits(s);
      let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(t);
      if (!m) { const d = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(t); if (d) m = [d[0], d[3]!, d[2]!, d[1]!] as unknown as RegExpExecArray; }
      if (!m) { const n = Number(t); if (/^\d{5}$/.test(t) && n > 20000 && n < 80000) { const dt = new Date(Date.UTC(1899, 11, 30) + n * 86_400_000); return { ok: true, value: dt.toISOString().slice(0, 10) }; } return { ok: false, code: 'bad_date' }; }
      const iso = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
      return Number.isNaN(Date.parse(iso + 'T00:00:00Z')) || new Date(iso + 'T00:00:00Z').toISOString().slice(0, 10) !== iso ? { ok: false, code: 'bad_date' } : { ok: true, value: iso };
    }
    case 'enum': {
      const k = normalizeHeader(s);
      const hit = f.options?.find((o) => normalizeHeader(o.value) === k || o.words.some((w) => normalizeHeader(w) === k));
      return hit ? { ok: true, value: hit.value } : { ok: false, code: 'unknown_option' };
    }
    default: return f.max && s.length > f.max ? { ok: false, code: 'too_long' } : { ok: true, value: s.replace(/\s+/g, ' ') };
  }
}

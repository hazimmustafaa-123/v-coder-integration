import { inflateRawSync } from 'node:zlib';

/**
 * A minimal .xlsx reader with no dependency: an xlsx file is a zip of XML parts, and a shop's price list needs only the first sheet's cells (text and numbers).
 * Built for UNTRUSTED files: the sizes it will inflate, the entries it will read and the rows and columns it will return are all capped, so a crafted file
 * (a zip bomb, a million-row sheet) is refused instead of exhausting memory. Formulas are not evaluated: the cached value Excel saved is what is read.
 */
export class XlsxError extends Error { constructor(public code: 'not_xlsx' | 'too_big' | 'unsupported' | 'empty' | 'macro_file') { super(code); } }

const MAX_ENTRIES = 200, MAX_PART_BYTES = 12 * 1024 * 1024, MAX_COLS = 60;
/** rows a sheet may hold before the reader refuses it (decision ق-ب9: 50 thousand for V-MART; a product with a smaller limit passes its own) */
export const DEFAULT_MAX_ROWS = 5000;
/** the limits the data center passes for a big price list: 50 thousand rows, a sheet that inflates to 64 MB */
export const BIG_LIMITS = { maxRows: 50_000, maxPartBytes: 64 * 1024 * 1024 } as const;

export interface Entry { name: string; method: number; csize: number; usize: number; offset: number }

export function entries(buf: Buffer): Entry[] {
  // end of central directory: the last 22 bytes plus an optional comment
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new XlsxError('not_xlsx');
  const count = buf.readUInt16LE(eocd + 10), dirOff = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new XlsxError('too_big');
  const out: Entry[] = [];
  let p = dirOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new XlsxError('not_xlsx');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), offset = buf.readUInt32LE(p + 42);
    if (flags & 1) throw new XlsxError('unsupported');                                    // encrypted
    out.push({ name: buf.toString('utf8', p + 46, p + 46 + nlen), method, csize, usize, offset });
    p += 46 + nlen + elen + clen;
  }
  return out;
}

export function read(buf: Buffer, e: Entry, maxBytes: number = MAX_PART_BYTES): string {
  if (e.usize > maxBytes) throw new XlsxError('too_big');
  if (buf.readUInt32LE(e.offset) !== 0x04034b50) throw new XlsxError('not_xlsx');
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const raw = buf.subarray(start, start + e.csize);
  if (e.method === 0) return raw.toString('utf8');
  if (e.method !== 8) throw new XlsxError('unsupported');
  try { return inflateRawSync(raw, { maxOutputLength: maxBytes }).toString('utf8'); } catch { throw new XlsxError('too_big'); }
}

const decode = (s: string): string => s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, g: string) => {
  if (g === 'amp') return '&'; if (g === 'lt') return '<'; if (g === 'gt') return '>'; if (g === 'quot') return '"'; if (g === 'apos') return "'";
  const code = g[1] === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
  return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
});
const textOf = (xml: string): string => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1]!)).join('');
const colIndex = (ref: string): number => { let n = 0; for (const ch of ref.replace(/[0-9]/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

/** the first worksheet as rows of strings (empty cells are empty strings) */
export function parseXlsx(buf: Buffer, opts: { maxRows?: number; maxPartBytes?: number } = {}): string[][] {
  const MAX_BYTES = opts.maxPartBytes ?? MAX_PART_BYTES;
  const MAX_ROWS = opts.maxRows ?? DEFAULT_MAX_ROWS;
  if (buf.length < 100 || buf.readUInt32LE(0) !== 0x04034b50) throw new XlsxError('not_xlsx');
  const es = entries(buf);
  const by = new Map(es.map((e) => [e.name, e]));
  if (by.has('xl/vbaProject.bin')) throw new XlsxError('macro_file');            // a workbook with macros is refused, never read
  const wbRels = by.get('xl/_rels/workbook.xml.rels'), wb = by.get('xl/workbook.xml');
  if (!wb) throw new XlsxError('not_xlsx');
  // the first sheet named in the workbook, resolved through its relationship (usually xl/worksheets/sheet1.xml)
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const first = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(read(buf, wb, MAX_BYTES));
  if (first && wbRels) {
    const rel = [...read(buf, wbRels, MAX_BYTES).matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((t) => new RegExp(`Id="${first[1]}"`).test(t));
    const target = rel && /Target="([^"]+)"/.exec(rel)?.[1];
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
  }
  const sheet = by.get(sheetPath);
  if (!sheet) throw new XlsxError('not_xlsx');
  const sst = by.get('xl/sharedStrings.xml');
  const shared = sst ? [...read(buf, sst, MAX_BYTES).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]!)) : [];
  const xml = read(buf, sheet, MAX_BYTES);
  const rows: string[][] = [];
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= MAX_ROWS) throw new XlsxError('too_big');
    const row: string[] = [];
    for (const cm of rm[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1]!, body = cm[2] ?? '';
      const ref = /\br="([A-Z]+[0-9]+)"/.exec(attrs)?.[1];
      const idx = ref ? colIndex(ref) : row.length;
      if (idx >= MAX_COLS) continue;
      const t = /\bt="([^"]+)"/.exec(attrs)?.[1];
      let v = '';
      if (t === 's') v = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '-1')] ?? '';
      else if (t === 'inlineStr') v = textOf(body);
      else if (t === 'str' || t === 'e' || t === 'b') v = decode(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      else v = decode(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      while (row.length < idx) row.push('');
      row[idx] = v;
    }
    rows.push(row);
  }
  if (rows.length === 0) throw new XlsxError('empty');
  // numbers Excel stores as 12.500000000000002 are tidied to what a person typed
  return rows.map((r) => r.map((v) => (/^-?\d+\.\d{9,}$/.test(v) ? String(Number(Number(v).toFixed(6))) : v)));
}

import { BIG_LIMITS, entries, parseXlsx, read, XlsxError } from './xlsx-read.js';
import { parseCsv } from './csv.js';

/**
 * Any file the owner drops, as a table of strings. The type is read from the bytes, never from the name or what the browser says: a renamed file is still what it is.
 * Refused outright: macro workbooks, the old binary .xls, encrypted files. PDF and images are not tables; they are reported as `needs_ai` so a product can send them to extraction.
 */
export type TableKind = 'xlsx' | 'csv' | 'docx';
export interface ReadResult { kind: TableKind; rows: string[][]; /** sheet or table notes worth telling the owner (several tables found, which one was used) */ notes: string[] }
export class FileError extends Error { constructor(public code: 'empty_file' | 'xls_unsupported' | 'macro_file' | 'encrypted' | 'too_big' | 'too_many_rows' | 'needs_ai' | 'unreadable' | 'no_table') { super(code); } }

export type Sniffed = 'zip' | 'ole' | 'pdf' | 'image' | 'text';
export function sniff(buf: Buffer): Sniffed {
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) return 'zip';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'ole';
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if ((buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') || (buf[0] === 0xff && buf[1] === 0xd8) || (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP')) return 'image';
  return 'text';
}

/** text bytes to a string: UTF-8 (with or without BOM), UTF-16 with BOM, else Windows-1256 (what old Arabic Excel saves) */
export function decodeText(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (!utf8.includes('�')) return utf8;
  try { return new TextDecoder('windows-1256').decode(buf); } catch { return utf8; }
}

const xmlDecode = (s: string): string => s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, g: string) => {
  if (g === 'amp') return '&'; if (g === 'lt') return '<'; if (g === 'gt') return '>'; if (g === 'quot') return '"'; if (g === 'apos') return "'";
  const code = g[1] === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
  return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
});

/** the tables of a .docx (rows of cell texts), biggest first; and its plain paragraphs for a product that wants the text */
export function readDocx(buf: Buffer): { tables: string[][][]; text: string } {
  const es = entries(buf);
  const doc = es.find((e) => e.name === 'word/document.xml');
  if (!doc) throw new FileError('unreadable');
  const xml = read(buf, doc);
  const cellText = (x: string): string => [...x.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((p) => [...p[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => xmlDecode(m[1]!)).join('')).join(' ').trim();
  const tables: string[][][] = [];
  for (const t of xml.matchAll(/<w:tbl>([\s\S]*?)<\/w:tbl>/g)) {
    const rows = [...t[1]!.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((r) => [...r[0].matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)].map((c) => cellText(c[1]!)));
    if (rows.length > 0) tables.push(rows);
  }
  tables.sort((a, b) => b.length * (b[0]?.length ?? 0) - a.length * (a[0]?.length ?? 0));
  const text = [...xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((p) => [...p[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => xmlDecode(m[1]!)).join('')).filter(Boolean).join('\n');
  return { tables, text };
}

export function readTable(buf: Buffer, opts: { maxRows?: number } = {}): ReadResult {
  if (buf.length === 0) throw new FileError('empty_file');
  const max = opts.maxRows ?? 50_000;
  const what = sniff(buf);
  if (what === 'ole') throw new FileError('xls_unsupported');
  if (what === 'pdf' || what === 'image') throw new FileError('needs_ai');
  if (what === 'zip') {
    let names: string[];
    try { names = entries(buf).map((e) => e.name); } catch (e) { throw e instanceof XlsxError ? mapXlsx(e) : new FileError('unreadable'); }
    if (names.includes('xl/vbaProject.bin') || names.includes('word/vbaProject.bin')) throw new FileError('macro_file');
    if (names.includes('word/document.xml')) {
      let d: ReturnType<typeof readDocx>;
      try { d = readDocx(buf); } catch (e) { throw e instanceof XlsxError ? mapXlsx(e) : e; }
      if (d.tables.length === 0) throw new FileError('no_table');
      const notes = d.tables.length > 1 ? [`في الملف ${d.tables.length} جداول؛ استُعمل أكبرها`] : [];
      return { kind: 'docx', rows: d.tables[0]!.slice(0, max + 1), notes };
    }
    try { return { kind: 'xlsx', rows: parseXlsx(buf, { maxRows: max + 1, maxPartBytes: BIG_LIMITS.maxPartBytes }), notes: [] }; } catch (e) { throw e instanceof XlsxError ? mapXlsx(e) : e; }
  }
  try { return { kind: 'csv', rows: parseCsv(decodeText(buf), { maxRows: max }), notes: [] }; } catch (e) { if ((e as Error).message === 'too_many_rows') throw new FileError('too_many_rows'); throw e; }
}

function mapXlsx(e: XlsxError): FileError {
  if (e.code === 'macro_file') return new FileError('macro_file');
  if (e.code === 'too_big') return new FileError('too_many_rows');
  if (e.code === 'empty') return new FileError('empty_file');
  if (e.code === 'unsupported') return new FileError('encrypted');
  return new FileError('unreadable');
}

/** a small CSV reader: quotes, escaped quotes, commas or semicolons or tabs (Excel exports vary), byte-order mark, CRLF; blank lines are dropped */
export function parseCsv(text: string, opts: { maxRows?: number } = {}): string[][] {
  const max = opts.maxRows ?? 50_000;
  const t = text.replace(/^﻿/, '');
  const first = t.split(/\r?\n/, 1)[0] ?? '';
  const sep = (first.match(/\t/g)?.length ?? 0) > 0 ? '\t' : (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  const push = (): void => { row.push(cell); cell = ''; if (row.some((x) => x.trim() !== '')) rows.push(row); row = []; if (rows.length > max + 1) throw new Error('too_many_rows'); };
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; push(); }
    else cell += ch;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

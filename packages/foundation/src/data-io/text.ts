/**
 * Cleaning that every product needs and none should write twice: Arabic and Western digits, the spelling variants of Arabic names, and numbers as people type them
 * ("1,234.50", "١٢٣٤٫٥٠", "12,5 ج.م"). Pure functions, no locale or country assumptions beyond the characters themselves.
 */

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩', FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** Arabic-Indic and Persian digits to 0-9 */
export const asciiDigits = (s: string): string => s.replace(/[٠-٩۰-۹]/g, (c) => {
  const i = AR_DIGITS.indexOf(c);
  return String(i >= 0 ? i : FA_DIGITS.indexOf(c));
});

/**
 * a name as it is compared (never as it is stored): lower case, no diacritics or tatweel, the alef family as one letter, ى as ي, ة as ه, digits as 0-9, punctuation as a space.
 * "بيبسى ٣٣٠ مل" and "بيبسي 330 مل" become the same text, which is how two spellings of one product meet.
 */
export function normalizeName(s: string): string {
  return asciiDigits(String(s ?? '').normalize('NFKC'))
    .replace(/[ً-ٰٟـ]/g, '')                  // tashkeel, dagger alef, tatweel
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** a column title as matched: no byte-order mark, no trailing "[Store]" or "(EGP)" note, one space between words, normalised */
export const normalizeHeader = (h: string): string => normalizeName(String(h ?? '').replace(/^﻿/, '').replace(/\s*[\[(][^\])]*[\])]\s*$/, ''));

/**
 * a number as a canonical decimal text ("1234.5"), or null when it is not one. Handles Arabic digits, the Arabic decimal mark (٫) and thousands mark (٬), "1,234.50",
 * "1.234,50", "12,5", a currency word or symbol around it. A comma followed by exactly three digits and a non-zero whole part is a thousands mark; otherwise it is a decimal mark.
 */
export function parseDecimal(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const all = asciiDigits(String(raw)).replace(/[٫]/g, '.').replace(/[٬\s ]/g, '');
  const m = /[-+]?(?:\d|[.,]\d)[\d.,]*/.exec(all);
  if (!m) return null;
  if (/\d/.test(all.slice(0, m.index) + all.slice(m.index + m[0].length))) return null;          // a second number or a stray digit around it: not one number
  let s = m[0].replace(/[.,]+$/, '');
  let neg = false;
  if (s.startsWith('-')) { neg = true; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (/[-+]/.test(s)) return null;
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {                                      // both marks: the later one is the decimal mark
    const dec = lastDot > lastComma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    s = s.split(thou).join('').replace(dec, '.');
  } else if (lastComma >= 0) {
    const parts = s.split(',');
    const tail = parts[parts.length - 1]!;
    if (parts.length > 2 || (tail.length === 3 && parts[0] !== '0' && parts[0] !== '')) s = parts.join('');        // 1,234 or 1,234,567
    else s = parts.join('.');
  } else if ((s.match(/\./g)?.length ?? 0) > 1) {
    s = s.replace(/\./g, '');
  }
  if (!/^[0-9]*\.?[0-9]*$/.test(s) || s === '.' || s === '') return null;
  s = s.replace(/^0+(?=\d)/, '');
  if (s.startsWith('.')) s = '0' + s;
  if (s.endsWith('.')) s = s.slice(0, -1);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return (neg && s !== '0' ? '-' : '') + s;
}

/** Excel and CSV readers can run a cell that starts like a formula; text written to a file is made inert */
export const csvSafe = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return s;
};

const csvCell = (v: unknown): string => { const s = csvSafe(v); return /[",;\n\r\t]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
/** rows as CSV text with a byte-order mark so Excel opens Arabic correctly */
export const toCsv = (rows: unknown[][]): string => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

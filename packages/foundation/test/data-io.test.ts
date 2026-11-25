import { describe, expect, it } from 'vitest';
import { buildXlsx, buildZip, coerce, countPlan, cleanRow, errorFile, extractRows, FileError, mapColumns, nameSimilarity, normalizeName, parseCsv, parseDecimal, parseXlsx, readTable, similarPairs, templateXlsx, toCsv, XlsxError, type FieldSpec } from '../src/data-io/index.js';

const FIELDS: FieldSpec[] = [
  { key: 'name', label: 'الاسم', type: 'text', required: true, aliases: ['اسم الصنف', 'product name', 'item name'], max: 160 },
  { key: 'barcode', label: 'الباركود', type: 'barcode', aliases: ['barcode', 'ean', 'bar code'] },
  { key: 'price', label: 'السعر', type: 'money', aliases: ['price', 'سعر البيع', 'sales price'], sensitive: true },
  { key: 'unit', label: 'الوحدة', type: 'enum', aliases: ['unit', 'uom'], options: [{ value: 'kg', words: ['كيلو', 'كجم'] }, { value: 'piece', words: ['قطعة', 'حبة'] }] },
];

describe('text cleaning', () => {
  it('treats spelling variants and digit scripts of one Arabic name as the same text', () => {
    expect(normalizeName('بيبسى ٣٣٠ مل')).toBe(normalizeName('بيبسي 330 مل'));
    expect(normalizeName('أحمد  إبراهيم')).toBe('احمد ابراهيم');
    expect(normalizeName('مَدرَسة')).toBe('مدرسه');
    expect(normalizeName('Coca-Cola (Zero)')).toBe('coca cola zero');
  });
  it('reads numbers the way people type them', () => {
    const cases: Array<[string | number, string | null]> = [['42', '42'], ['42.50', '42.5'], ['1,234.50', '1234.5'], ['1.234,50', '1234.5'], ['12,5', '12.5'], ['1,234', '1234'], ['0,500', '0.5'], ['١٢٣٤٫٥٠', '1234.5'], ['١٬٢٣٤', '1234'], ['12.5 ج.م', '12.5'], ['EGP 7', '7'], ['-3.00', '-3'], ['', null], ['abc', null], ['1-2', null], ['.5', '0.5'], [12.5, '12.5']];
    for (const [i, o] of cases) expect(parseDecimal(i), String(i)).toBe(o);
  });
  it('makes file output inert and keeps Arabic readable in Excel', () => {
    const csv = toCsv([['=HYPERLINK("x")', '+1+1', 'ok', 5], ['a,b', 'q"q', '-3', '@x']]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+1+1");
    expect(csv).toContain('"a,b"');
    expect(csv).toContain(',-3,');
    expect(csv).toContain("'@x");
  });
});

describe('readers', () => {
  it('reads CSV with quotes, semicolons and BOM', () => {
    expect(parseCsv('﻿a;b\r\n"x;1";2\r\n\r\n3;"q""r"')).toEqual([['a', 'b'], ['x;1', '2'], ['3', 'q"r']]);
    expect(() => parseCsv('a\n1\n2\n3\n', { maxRows: 2 })).toThrow('too_many_rows');
  });
  it('writes an xlsx that reads back, keeps Arabic and formulas as text', () => {
    const rows = [['الاسم', 'السعر'], ['=1+1', 12.5], ['صنف <&> "x"', 3]];
    const back = parseXlsx(buildXlsx([{ name: 'ورقة', rows }]));
    expect(back[0]).toEqual(['الاسم', 'السعر']);
    expect(back[1]).toEqual(['=1+1', '12.5']);
    expect(back[2]![0]).toBe('صنف <&> "x"');
  });
  it('refuses what it should, by content and not by name', () => {
    expect(() => readTable(Buffer.alloc(0))).toThrow(FileError);
    expect(() => readTable(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(50)]))).toThrow('xls_unsupported');
    expect(() => readTable(Buffer.from('%PDF-1.7 ....'))).toThrow('needs_ai');
    expect(() => readTable(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toThrow('needs_ai');
    const macro = buildZip([['[Content_Types].xml', '<x/>'], ['xl/workbook.xml', '<workbook/>'], ['xl/vbaProject.bin', 'MZ']]);
    expect(() => readTable(macro)).toThrow('macro_file');
    expect(() => parseXlsx(macro)).toThrow(XlsxError);
    expect(() => readTable(buildXlsx([{ name: 's', rows: [['h'], ...Array.from({ length: 30 }, (_, i) => [String(i)])] }]), { maxRows: 10 })).toThrow('too_many_rows');
  });
  it('reads a Windows-1256 CSV and a Word table', () => {
    const win1256 = Buffer.from([0xc7, 0xe1, 0xc7, 0xd3, 0xe3, 0x2c, 0xc7, 0xe1, 0xd3, 0xda, 0xd1, 0x0a, 0xca, 0xdd, 0xc7, 0xcd, 0x2c, 0x35]);
    const r = readTable(win1256);
    expect(r.kind).toBe('csv');
    expect(r.rows).toEqual([['الاسم', 'السعر'], ['تفاح', '5']]);
    const cell = (t: string) => `<w:tc><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
    const docx = buildZip([['[Content_Types].xml', '<x/>'], ['word/document.xml', `<w:document><w:body><w:p><w:r><w:t>قائمة</w:t></w:r></w:p><w:tbl><w:tr>${cell('الصنف')}${cell('السعر')}</w:tr><w:tr>${cell('شاي')}${cell('25 &amp; 5')}</w:tr></w:tbl></w:body></w:document>`]]);
    const d = readTable(docx);
    expect(d.kind).toBe('docx');
    expect(d.rows).toEqual([['الصنف', 'السعر'], ['شاي', '25 & 5']]);
  });
});

describe('column matching and row cleaning', () => {
  it('recognises other systems\' titles, close spellings, and leaves the unknown listed', () => {
    const m = mapColumns(['Product Name [Store]', 'Barcod', 'Sales Price (EGP)', 'Colour', 'سعر البيع'], FIELDS);
    expect(m.columns.map((c) => [c.key, c.how])).toEqual([['name', 'exact'], ['barcode', 'similar'], ['price', 'exact'], [null, null], [null, null]]);
    expect(m.missingRequired).toEqual([]);
    expect(mapColumns(['x'], FIELDS).missingRequired).toEqual(['name']);
  });
  it('honours the owner\'s own mapping over the guess, and lets a column be ignored', () => {
    const m = mapColumns(['العمود1', 'العمود2', 'price'], FIELDS, { 0: 'name', 1: 'barcode', 2: null });
    expect(m.columns.map((c) => c.key)).toEqual(['name', 'barcode', null]);
  });
  it('cleans each cell to its type and reports what is wrong with the line', () => {
    const table = [['اسم الصنف', 'ean', 'سعر البيع', 'uom'], ['  شاي   ليبتون ', '٦٢٢١٠٣١٢٣٤٥٦٧', '25,50', 'كيلو'], ['', '1', 'x', 'علبة'], ['كولا', '6.22E+12', '', '']];
    const rows = extractRows(table, mapColumns(table[0]!, FIELDS));
    expect(rows.map((r) => r.line)).toEqual([2, 3, 4]);
    const plans = rows.map((r) => cleanRow(r, FIELDS));
    expect(plans[0]!.values).toMatchObject({ name: 'شاي ليبتون', barcode: '6221031234567', price: '25.5', unit: 'kg' });
    expect(plans[1]!.issues.map((i) => i.code).sort()).toEqual(['bad_money', 'required_missing', 'unknown_option']);
    expect(plans[2]!.issues.map((i) => i.code)).toEqual(['barcode_scientific']);
    expect(countPlan(plans)).toMatchObject({ rows: 3, create: 1, error: 2 });
  });
  it('turns Excel dates and several date layouts into ISO days', () => {
    const f: FieldSpec = { key: 'd', label: 'd', type: 'date', aliases: [] };
    expect(coerce(f, '2026-11-05')).toEqual({ ok: true, value: '2026-11-05' });
    expect(coerce(f, '5/11/2026')).toEqual({ ok: true, value: '2026-11-05' });
    expect(coerce(f, '46331')).toEqual({ ok: true, value: '2026-11-05' });
    expect(coerce(f, '2026-02-31')).toEqual({ ok: false, code: 'bad_date' });
  });
});

describe('similarity', () => {
  it('finds the same product written two ways, and not different sizes', () => {
    expect(nameSimilarity('بيبسى ٣٣٠ مل', 'بيبسي 330 ملي')).toBeGreaterThan(0.85);
    expect(nameSimilarity('شاي ليبتون ٢٥ كيس', 'ليبتون شاي 25 كيس')).toBe(1);
    expect(nameSimilarity('شاي ليبتون', 'قهوة نسكافيه')).toBeLessThan(0.4);
    const pairs = similarPairs(['بيبسى 330 مل', 'قهوة', 'بيبسي ٣٣٠ مل', 'كولا'], { threshold: 0.9 });
    expect(pairs).toEqual([{ a: 0, b: 2, score: 1 }]);
  });
});

describe('error file and template', () => {
  it('lists the rejected rows with their reasons, in the owner\'s columns, as CSV or XLSX', () => {
    const rows = extractRows([['الاسم', 'السعر'], ['', 'x']], mapColumns(['الاسم', 'السعر'], FIELDS));
    const plans = rows.map((r) => cleanRow(r, FIELDS));
    const csv = errorFile(FIELDS, plans, (c) => 'سبب:' + c, 'csv');
    expect(csv.content).toContain('سبب:required_missing');
    const x = errorFile(FIELDS, plans, (c) => c, 'xlsx');
    expect(parseXlsx(Buffer.from(x.content, 'base64'))[1]![0]).toBe('2');
  });
  it('builds a template that maps back onto its own fields', () => {
    const t = parseXlsx(templateXlsx('أصناف', FIELDS, { money: 'مبلغ' }));
    expect(mapColumns(t[0]!, FIELDS).columns.map((c) => c.key)).toEqual(['name', 'barcode', 'price', 'unit']);
  });
});

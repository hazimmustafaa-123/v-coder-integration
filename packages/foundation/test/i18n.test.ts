import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDictionaries, pluralVariablesOf, placeholdersOf } from '../src/i18n/check.js';
import { checkRatchet, compareToBaseline, countArabicRuns, scanArabic, stripCodeComments, writeBaseline } from '../src/i18n/scan.js';

const kinds = (ar: Record<string, string>, en: Record<string, string>, o = {}) => checkDictionaries(ar, en, o).map((p) => `${p.kind}:${p.key}`);

describe('dictionary parity', () => {
  it('accepts two dictionaries that say the same things', () => {
    expect(kinds({ 'a.save': 'حفظ', 'a.hi': 'أهلًا {name}', 'a.days': '{n|يوم|يومان|أيام|يومًا}' }, { 'a.save': 'Save', 'a.hi': 'Hello {name}', 'a.days': '{n|day|days}' })).toEqual([]);
  });

  it('catches a key missing in either language', () => {
    expect(kinds({ a: 'ا', b: 'ب' }, { a: 'A', c: 'C' })).toEqual(['missing-in-en:b', 'missing-in-ar:c']);
  });

  it('catches empty text, a lost placeholder and a lost plural variable', () => {
    expect(kinds({ a: 'مرحبا {name}', b: 'نص', c: '{n|يوم|أيام}' }, { a: 'Hello', b: '  ', c: '{m|day|days}' })).toEqual(['placeholders:a', 'empty:b', 'plural-variables:c']);
  });

  it('catches Arabic left inside English and English that is the Arabic text', () => {
    expect(kinds({ a: 'حفظ', b: 'حفظ' }, { a: 'Save حفظ', b: 'حفظ' })).toEqual(['arabic-in-en:a', 'arabic-in-en:b', 'same-as-ar:b']);
  });

  it('lets a brand name or a symbol stay the same when the key is allowed', () => {
    expect(kinds({ brand: 'V-SUFRA', dash: '—' }, { brand: 'V-SUFRA', dash: '—' })).toEqual(['same-as-ar:brand']);
    expect(kinds({ brand: 'V-SUFRA' }, { brand: 'V-SUFRA' }, { allowSame: ['brand'] })).toEqual([]);
  });

  it('reads placeholders and plural variables', () => {
    expect(placeholdersOf('{b} and {a} and {a}')).toEqual(['a', 'b']);
    expect(pluralVariablesOf('{n|one|many} {count}')).toEqual(['n']);
  });
});

describe('Arabic typed in code', () => {
  it('counts runs of Arabic words outside comments', () => {
    const src = [
      '// تعليق عربي لا يُحسب',
      "const a = 'حفظ التغييرات';",
      '/* وهذا أيضًا */',
      'const b = "اسم" + `الصنف ${x} نفد`; // وهذا',
      "const c = 'https://example.com/a//b';",
    ].join('\n');
    // «حفظ التغييرات», «اسم», «الصنف» and «نفد» (the placeholder splits the template into two runs)
    expect(countArabicRuns(src)).toBe(4);
  });

  it('keeps a quote that holds comment characters', () => {
    expect(stripCodeComments("const u = 'a//b'; // gone")).toBe("const u = 'a//b'; ");
  });

  it('reads html and ignores its comments', () => {
    expect(countArabicRuns('<!-- ملاحظة --><h1>لوحة الإدارة</h1><p>دخول</p>', 'html')).toBe(2);
  });

  it('scans a folder, skips excluded dictionary files and tests, and compares with a baseline', () => {
    const root = mkdtempSync(join(tmpdir(), 'i18n-scan-'));
    mkdirSync(join(root, 'src', 'i18n'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(root, 'src', 'Screen.tsx'), "export const A = () => <b>{'حفظ'}</b>;\nexport const B = 'إلغاء';\n");
    writeFileSync(join(root, 'src', 'i18n', 'ar.ts'), "export const ar = { save: 'حفظ' };\n");
    writeFileSync(join(root, 'src', 'Screen.test.ts'), "expect('حفظ');\n");
    writeFileSync(join(root, 'node_modules', 'x', 'i.js'), "'حفظ'");
    expect(scanArabic({ root, exclude: ['src/i18n'] })).toEqual({ 'src/Screen.tsx': 2 });

    const baselinePath = join(root, 'i18n-baseline.json');
    writeBaseline(baselinePath, { version: 1, exclude: ['src/i18n'], files: { 'src/Screen.tsx': 2 } });
    expect(checkRatchet(root, baselinePath).comparison.ok).toBe(true);

    writeFileSync(join(root, 'src', 'New.tsx'), "export const C = 'جديد';\n");
    const grown = checkRatchet(root, baselinePath);
    expect(grown.comparison.ok).toBe(false);
    expect(grown.comparison.grew).toEqual([{ file: 'src/New.tsx', baseline: 0, now: 1 }]);
    expect(grown.report).toContain('GREW   src/New.tsx');
  });

  it('only lets the baseline go down', () => {
    expect(compareToBaseline({ a: 3 }, { a: 5, b: 2 })).toMatchObject({ ok: true, shrank: [{ file: 'a', baseline: 5, now: 3 }, { file: 'b', baseline: 2, now: 0 }], total: { baseline: 7, now: 3 } });
    expect(compareToBaseline({ a: 6 }, { a: 5 }).ok).toBe(false);
  });
});

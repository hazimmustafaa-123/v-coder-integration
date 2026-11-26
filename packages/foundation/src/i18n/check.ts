/**
 * VC-STD-15 (language), the dictionary half: two dictionaries of the same product (Arabic = the source, English) must say the same things.
 * Pure functions on plain objects, so a product's own test imports its dictionaries and asserts `checkDictionaries(ar, en)` is empty.
 * Placeholders are `{name}`; plural tokens are `{n|one|two|few|many}` (the V-Fit form: only the variable name has to match, because
 * Arabic has more forms than English).
 */
export type Dictionary = Readonly<Record<string, string>>;

export type ProblemKind = 'missing-in-en' | 'missing-in-ar' | 'empty' | 'placeholders' | 'plural-variables' | 'arabic-in-en' | 'same-as-ar';

export interface DictionaryProblem {
  kind: ProblemKind;
  key: string;
  message: string;
}

export interface CheckOptions {
  /** keys whose English text may equal the Arabic one (brand names, symbols) */
  allowSame?: readonly string[];
  /** keys whose English text may carry Arabic letters (a literal Arabic example the user must type, for instance) */
  allowArabic?: readonly string[];
}

const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
const ANY_LETTER = /\p{L}/u;

/** True when the text holds an Arabic letter. */
export const hasArabic = (text: string): boolean => ARABIC.test(text);

/** The `{name}` placeholders of a message, sorted and without repeats (plural tokens are not placeholders). */
export function placeholdersOf(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\{(\w+)\}/g)) out.add(m[1]!);
  return [...out].sort();
}

/** The variable names of the plural tokens `{n|a|b|c}` of a message, sorted and without repeats. */
export function pluralVariablesOf(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\{(\w+)\|[^}]+\}/g)) out.add(m[1]!);
  return [...out].sort();
}

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export function checkDictionaries(ar: Dictionary, en: Dictionary, options: CheckOptions = {}): DictionaryProblem[] {
  const problems: DictionaryProblem[] = [];
  const allowSame = new Set(options.allowSame ?? []);
  const allowArabic = new Set(options.allowArabic ?? []);
  const add = (kind: ProblemKind, key: string, message: string) => problems.push({ kind, key, message });

  for (const key of Object.keys(ar)) {
    const a = ar[key]!;
    if (!(key in en)) {
      add('missing-in-en', key, `«${key}» has Arabic text but no English text`);
      continue;
    }
    const e = en[key]!;
    if (a.trim() === '') add('empty', key, `«${key}»: the Arabic text is empty`);
    if (e.trim() === '') {
      add('empty', key, `«${key}»: the English text is empty`);
      continue;
    }
    if (!same(placeholdersOf(a), placeholdersOf(e))) {
      add('placeholders', key, `«${key}»: placeholders differ — Arabic {${placeholdersOf(a).join(',')}} vs English {${placeholdersOf(e).join(',')}}`);
    }
    if (!same(pluralVariablesOf(a), pluralVariablesOf(e))) {
      add('plural-variables', key, `«${key}»: plural tokens differ — Arabic [${pluralVariablesOf(a).join(',')}] vs English [${pluralVariablesOf(e).join(',')}]`);
    }
    if (hasArabic(e) && !allowArabic.has(key)) add('arabic-in-en', key, `«${key}»: the English text contains Arabic letters`);
    if (e === a && ANY_LETTER.test(a) && !allowSame.has(key)) add('same-as-ar', key, `«${key}»: the English text is the Arabic text (not translated)`);
  }
  for (const key of Object.keys(en)) {
    if (!(key in ar)) add('missing-in-ar', key, `«${key}» has English text but no Arabic text (Arabic is the source)`);
  }
  return problems;
}

/** One line per problem, for a test failure message. */
export const formatProblems = (problems: readonly DictionaryProblem[]): string => problems.map((p) => `${p.kind}: ${p.message}`).join('\n');

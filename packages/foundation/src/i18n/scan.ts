import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * VC-STD-15 (language), the code half — the ratchet. Arabic text typed straight into code is counted per file and compared with a
 * baseline kept in the repository: the count may go down (then the baseline is lowered) but never up, and a file the baseline does not
 * know may hold none. When a surface is fully moved to dictionaries its files leave the baseline and the rule becomes "no Arabic here".
 * What is counted: runs of Arabic words (a run ends at punctuation or a non-Arabic character) outside comments. Dictionary files are
 * excluded by pattern. A rough measure on purpose: it must be cheap, stable and impossible to satisfy by moving a quote.
 */
const AR = '\\u0600-\\u06FF\\u0750-\\u077F\\uFB50-\\uFDFF\\uFE70-\\uFEFF';
const ARABIC_RUN = new RegExp(`[${AR}]+(?:[ \\u00A0][${AR}]+)*`, 'g');

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro']);
const HTML_EXT = new Set(['.html', '.htm']);
const ALWAYS_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.git', '.turbo', 'release', 'vendor', 'test', 'tests', '__tests__', 'e2e', 'screenshots']);

/** Removes comments from JavaScript/TypeScript source, keeping strings (a small state machine, not a parser). */
export function stripCodeComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
    } else if (c === '"' || c === "'" || c === '`') {
      out += c;
      i++;
      while (i < n) {
        const s = src[i]!;
        out += s;
        i++;
        if (s === '\\' && i < n) {
          out += src[i]!;
          i++;
        } else if (s === c) break;
        else if (s === '\n' && c !== '`') break; // an unterminated quote (a regex, an apostrophe): recover at the line end
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Removes HTML comments (and the comments of inline scripts and styles). */
export const stripHtmlComments = (src: string): string => stripCodeComments(src.replace(/<!--[\s\S]*?-->/g, ' '));

/** How many runs of Arabic words the source holds outside comments. `html` for .html files, `code` for the rest. */
export function countArabicRuns(source: string, kind: 'code' | 'html' = 'code'): number {
  const text = kind === 'html' ? stripHtmlComments(source) : stripCodeComments(source);
  return (text.match(ARABIC_RUN) ?? []).length;
}

export interface ScanOptions {
  root: string;
  /** relative paths (posix slashes) matching any of these are not counted: dictionaries, generated files */
  exclude?: readonly (RegExp | string)[];
  /** extra file extensions to read as code (with the dot) */
  extensions?: readonly string[];
}

const matches = (rel: string, patterns: readonly (RegExp | string)[]): boolean =>
  patterns.some((p) => (typeof p === 'string' ? rel === p || rel.startsWith(p.endsWith('/') ? p : `${p}/`) : p.test(rel)));

/** Arabic-run count per file (relative path, posix slashes); files with none are left out. */
export function scanArabic(options: ScanOptions): Record<string, number> {
  const exclude = options.exclude ?? [];
  const exts = new Set([...CODE_EXT, ...HTML_EXT, ...(options.extensions ?? [])]);
  const result: Record<string, number> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = relative(options.root, full).split(sep).join('/');
      const st = statSync(full);
      if (st.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(name) || matches(rel, exclude)) continue;
        walk(full);
        continue;
      }
      const dot = name.lastIndexOf('.');
      const ext = dot < 0 ? '' : name.slice(dot);
      if (!exts.has(ext) || /\.(test|spec)\.[a-z]+$/.test(name) || /\.min\./.test(name) || matches(rel, exclude)) continue;
      const count = countArabicRuns(readFileSync(full, 'utf8'), HTML_EXT.has(ext) ? 'html' : 'code');
      if (count > 0) result[rel] = count;
    }
  };
  walk(options.root);
  return result;
}

export interface Baseline {
  version: 1;
  /** patterns (plain strings: path prefixes; "re:..." : regular expressions) left out of the count */
  exclude: string[];
  /** files whose Arabic text is still typed in code, and how many runs each holds */
  files: Record<string, number>;
}

export interface Comparison {
  ok: boolean;
  /** more Arabic than the baseline allows (or a file the baseline does not list) */
  grew: { file: string; baseline: number; now: number }[];
  /** less than the baseline: lower it (`--update`) so it cannot climb back */
  shrank: { file: string; baseline: number; now: number }[];
  total: { baseline: number; now: number };
}

export function compareToBaseline(current: Readonly<Record<string, number>>, baseline: Readonly<Record<string, number>>): Comparison {
  const grew: Comparison['grew'] = [];
  const shrank: Comparison['shrank'] = [];
  const files = new Set([...Object.keys(current), ...Object.keys(baseline)]);
  for (const file of [...files].sort()) {
    const now = current[file] ?? 0;
    const before = baseline[file] ?? 0;
    if (now > before) grew.push({ file, baseline: before, now });
    else if (now < before) shrank.push({ file, baseline: before, now });
  }
  const sum = (o: Readonly<Record<string, number>>) => Object.values(o).reduce((a, b) => a + b, 0);
  return { ok: grew.length === 0, grew, shrank, total: { baseline: sum(baseline), now: sum(current) } };
}

export const toPatterns = (exclude: readonly string[]): (RegExp | string)[] => exclude.map((p) => (p.startsWith('re:') ? new RegExp(p.slice(3)) : p));

export function readBaseline(path: string): Baseline {
  if (!existsSync(path)) return { version: 1, exclude: [], files: {} };
  return JSON.parse(readFileSync(path, 'utf8')) as Baseline;
}

export function writeBaseline(path: string, baseline: Baseline): void {
  const files = Object.fromEntries(Object.entries(baseline.files).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path, `${JSON.stringify({ ...baseline, files }, null, 2)}\n`);
}

/** The whole check a product's test or CI runs: scan, compare with the baseline file, return the verdict and a readable report. */
export function checkRatchet(root: string, baselinePath: string): { comparison: Comparison; report: string; current: Record<string, number> } {
  const baseline = readBaseline(baselinePath);
  const current = scanArabic({ root, exclude: toPatterns(baseline.exclude) });
  const comparison = compareToBaseline(current, baseline.files);
  const lines = [`Arabic typed in code: ${comparison.total.now} runs (baseline ${comparison.total.baseline})`];
  for (const g of comparison.grew) lines.push(`  GREW   ${g.file}: ${g.baseline} -> ${g.now} - move the new text into the dictionaries (VC-STD-15)`);
  for (const s of comparison.shrank) lines.push(`  shrank ${s.file}: ${s.baseline} -> ${s.now} - lower the baseline (--update)`);
  return { comparison, report: lines.join('\n'), current };
}

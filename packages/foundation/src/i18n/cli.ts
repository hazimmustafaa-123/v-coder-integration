#!/usr/bin/env node
import { resolve } from 'node:path';
import { checkRatchet, readBaseline, writeBaseline } from './scan.js';

/**
 * v-coder-i18n-scan [--root <dir>] [--baseline <file>] [--update | --init]
 * Fails (exit 1) when Arabic typed in code grew compared with the baseline file (default ./i18n-baseline.json). `--update` rewrites the
 * baseline to the current counts, but only downwards: it refuses while any file grew. `--init` writes the first baseline (keeping the
 * `exclude` list already in the file) and is for adopting the check, never for silencing it.
 */
const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const root = resolve(opt('--root', '.'));
const baselinePath = resolve(root, opt('--baseline', 'i18n-baseline.json'));
const { comparison, report, current } = checkRatchet(root, baselinePath);
console.log(report);
if (args.includes('--init')) {
  const baseline = readBaseline(baselinePath);
  writeBaseline(baselinePath, { ...baseline, version: 1, files: current });
  console.log(`baseline initialised: ${baselinePath}`);
  process.exit(0);
}
if (!comparison.ok) process.exit(1);
if (args.includes('--update')) {
  const baseline = readBaseline(baselinePath);
  writeBaseline(baselinePath, { ...baseline, version: 1, files: current });
  console.log(`baseline written: ${baselinePath}`);
}

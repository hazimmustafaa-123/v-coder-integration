// The consumer matrix (docs/release-policy.md §2): before a candidate version is taken by any product, every product's integration tests
// run against it. Install the candidate's .tgz files in each product's vendor/v-coder (and its lockfile) first, then:
//
//   node scripts/consumer-matrix.mjs            (products found next to this repository, or SUFRA_DIR / VMART_DIR / VFIT_DIR)
//
// A product whose tests fail blocks the release for that product. Exit code 1 if any product fails or is missing.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const parent = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pick = (env, ...names) => process.env[env] ?? names.map((n) => join(parent, n)).find((p) => existsSync(p)) ?? join(parent, names[0]);

const products = [
  { name: 'V-SUFRA', dir: pick('SUFRA_DIR', 'sufra-int', 'restaurant-sushi'), cwd: 'apps/cloud', cmd: ['node_modules/vitest/vitest.mjs', 'run', 'test/integrations-flows.test.ts', 'test/integrations-routes.test.ts'] },
  { name: 'V-MART', dir: pick('VMART_DIR', 'vmart-int', 'V-MART'), cwd: 'apps/cloud', cmd: ['node_modules/vitest/vitest.mjs', 'run', 'test/integrations.test.ts', 'test/admin-ui.test.ts'] },
  { name: 'V-Fit', dir: pick('VFIT_DIR', 'vfit-int', 'v-fit'), cwd: '.', cmd: ['--experimental-strip-types', '--no-warnings', '--test', 'apps/api/test/integrations.test.ts'], env: { NODE_ENV: 'test' } },
];

let failed = 0;
for (const p of products) {
  const cwd = join(p.dir, p.cwd);
  if (!existsSync(cwd)) {
    console.log(`✗ ${p.name}: not found at ${p.dir}`);
    failed += 1;
    continue;
  }
  process.stdout.write(`… ${p.name} (${p.dir})\n`);
  try {
    execFileSync(process.execPath, p.cmd, { cwd, stdio: 'inherit', env: { ...process.env, ...(p.env ?? {}) } });
    console.log(`✓ ${p.name}`);
  } catch {
    console.log(`✗ ${p.name}: integration tests failed`);
    failed += 1;
  }
}
console.log(failed ? `\n${failed} product(s) red — do not take this version there.` : '\nall products green.');
process.exit(failed ? 1 : 0);

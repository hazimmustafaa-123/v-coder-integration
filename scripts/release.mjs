// Release (docs/release-policy.md): build, run every test, then pack each package into packs/<name>-<version>.tgz with a SHA-256 list.
// A product takes a release by copying the .tgz files into its own vendor/v-coder/ folder and pointing its package.json at them (exact
// files, so the build needs no registry and the version can never drift). Refuses to overwrite an existing version: a version is immutable.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packs = join(root, 'packs');
mkdirSync(packs, { recursive: true });
const pkgs = ['kit-core', 'connector-paymob', 'connector-whatsapp', 'delivery-kit'];

// pnpm is a .cmd shim on Windows and needs a shell; node itself must NOT go through one (its path has a space).
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { stdio: 'inherit', cwd, shell: cmd === 'pnpm' && process.platform === 'win32' });

run(process.execPath, [join(root, 'scripts', 'build.mjs')]);
const vitest = createRequire(join(root, 'package.json')).resolve('vitest/vitest.mjs');
run(process.execPath, [vitest, 'run']);

const manifest = [];
for (const name of pkgs) {
  const dir = join(root, 'packages', name);
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const file = `${pj.name.replace('@', '').replace('/', '-')}-${pj.version}.tgz`;
  if (existsSync(join(packs, file))) {
    console.error(`\n${file} already exists: a released version never changes. Bump the version in packages/${name}/package.json and its CHANGELOG.`);
    process.exit(1);
  }
  const before = new Set(readdirSync(dir));
  run('pnpm', ['pack'], dir);
  const made = readdirSync(dir).find((f) => f.endsWith('.tgz') && !before.has(f));
  if (!made) throw new Error(`pnpm pack produced nothing for ${name}`);
  renameSync(join(dir, made), join(packs, file));
  const sha256 = createHash('sha256').update(readFileSync(join(packs, file))).digest('hex');
  manifest.push({ package: pj.name, version: pj.version, file, sha256 });
}
const listPath = join(packs, 'releases.json');
const all = existsSync(listPath) ? JSON.parse(readFileSync(listPath, 'utf8')) : [];
all.push({ at: new Date().toISOString(), packages: manifest });
writeFileSync(listPath, JSON.stringify(all, null, 2) + '\n');
writeFileSync(join(packs, 'SHA256SUMS'), all.flatMap((r) => r.packages.map((p) => `${p.sha256}  ${p.file}`)).join('\n') + '\n');
console.log('\nreleased:');
for (const m of manifest) console.log(`  ${m.file}  ${m.sha256}`);

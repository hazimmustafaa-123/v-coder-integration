// Builds every package with tsc, in dependency order (the core first: the connectors compile against its declarations).
// `--check` type-checks without writing the connectors' output (the core is still built, because the others need its types).
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = createRequire(join(root, 'package.json')).resolve('typescript/bin/tsc');
const check = process.argv.includes('--check');
const order = ['kit-core', 'connector-paymob', 'connector-whatsapp', 'delivery-kit', 'foundation'];

for (const pkg of order) {
  const dir = join(root, 'packages', pkg);
  const args = ['-p', join(dir, 'tsconfig.json')];
  if (check && pkg !== 'kit-core') args.push('--noEmit');
  else rmSync(join(dir, 'dist'), { recursive: true, force: true });
  process.stdout.write(`${check && pkg !== 'kit-core' ? 'check' : 'build'} ${pkg} … `);
  execFileSync(process.execPath, [tsc, ...args], { stdio: 'inherit', cwd: root });
  process.stdout.write('ok\n');
}

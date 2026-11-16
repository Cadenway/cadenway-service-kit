import { spawnSync } from 'node:child_process';
import { realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const packages = ['nest-common', 'nest-jobs', 'nest-messaging'];
const require = createRequire(import.meta.url);

// Old emitted modules can survive a move and end up in an archive. Remove each package's
// output and its incremental build state before compiling the project references.
for (const name of packages) {
  const output = join(root, 'packages', name, 'dist');
  let resolved;
  try {
    resolved = realpathSync(output);
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    throw error;
  }
  if (relative(root, resolved) !== join('packages', name, 'dist')) {
    throw new Error(`Refusing to clean a redirected build directory: ${output}`);
  }
  rmSync(output, { recursive: true, force: true });
}

const build = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-b'], {
  cwd: root,
  stdio: 'inherit',
});
if (build.error !== undefined) throw build.error;
process.exitCode = build.status ?? 1;

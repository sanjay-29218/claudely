// Dependency-free static checks used locally and by GitHub Actions.
import { readdir, readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
let count = 0;
for (const directory of ['extension', 'host', 'tools']) {
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(root, directory, entry.name);
    let result;
    if (/\.(?:mjs|js)$/.test(entry.name)) result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (entry.name.endsWith('.sh')) result = spawnSync('bash', ['-n', file], { stdio: 'inherit' });
    if (result) {
      if (result.error) throw result.error;
      if (result.status !== 0) process.exit(result.status || 1);
      count++;
    }
  }
}
const manifest = JSON.parse(await readFile(path.join(root, 'extension/manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const key = JSON.parse(await readFile(path.join(root, 'tools/extension-key.json'), 'utf8'));
if (manifest.version !== pkg.version) throw new Error('Package and extension versions differ.');
if (manifest.key !== key.key) throw new Error('Extension public keys differ.');
for (const file of [manifest.options_page, manifest.action.default_popup, manifest.background.service_worker,
  ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap((script) => script.js)]) {
  await access(path.join(root, 'extension', file));
}
console.log(`Checked ${count} source files, extension assets, version, and public key.`);

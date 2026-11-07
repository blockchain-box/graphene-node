import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(root, '../grph-explorer');
const build = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: source, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status || 1);
const output = path.join(root, 'docker/explorer/app');
// Replace generated assets so retired routes and downloads are not left in the image.
fs.rmSync(path.join(output, 'assets'), { recursive: true, force: true });
const downloads = path.join(output, 'downloads');
for (const filename of ['graphene-operator-kit.zip', 'graphene-operator-guide.md', 'operator-kit.json', 'SHA256SUMS']) {
  fs.rmSync(path.join(downloads, filename), { force: true });
}
// A previous installation may still hold checkpoint publications here. Never
// delete those data files as part of a frontend rebuild.
if (fs.existsSync(downloads) && fs.readdirSync(downloads).length === 0) fs.rmdirSync(downloads);
fs.cpSync(path.join(source, 'dist'), output, { recursive: true });
console.log('Updated docker/explorer/app from grph-explorer. Rebuild the explorer image to deploy.');

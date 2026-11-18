// Standalone public checkpoint bootstrap. No controller checkout is needed.
import fs from 'node:fs';
import { jobContext, logOutput } from './jobs.js';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isIPv4 } from 'node:net';
import { verifyEnvelope } from './checkpoint/snapshot-files.mjs';

export function verifySelection(invite, raw, fingerprint, baseUrl) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4 * 1024 ** 2)
    throw Error('Choose a signed manifest smaller than 4 MiB.');
  const envelope = JSON.parse(raw);
  const manifest = verifyEnvelope(envelope, fingerprint, invite.network, JSON.parse(invite.genesis), invite.images);
  const url = new URL(baseUrl);
  const publicApi = url.protocol === 'https:' && url.origin === new URL(invite.rpc).origin;
  const sentry = isIPv4(url.hostname) && url.protocol === 'http:' && url.port === '26657';
  if ((!publicApi && !sentry) || url.username || url.password ||
      url.search || url.hash || url.pathname !== `/checkpoints/${manifest.id}/`)
    throw Error('Use the public snapshot folder URL supplied by the operator.');
  return { envelope, fingerprint, baseUrl: url.href };
}

export function restoreCheckpoint(directory, project, role, selection) {
  const { envelope, fingerprint, baseUrl } = selection;
  const fileHelper = fs.readFileSync(new URL('./checkpoint/snapshot-files.mjs', import.meta.url), 'utf8');
  const host = new URL('./checkpoint/snapshot-host.py', import.meta.url);
  const compose = JSON.parse(fs.readFileSync(path.join(directory, 'compose.json')));
  const images = { transport: envelope.manifest.images.transport };
  for (const [service, image] of Object.entries({ node: 'tendermint', abci: 'abci', 'abci-db': 'postgres', mpt: 'mpt' }))
    images[image] = compose.services[service].image;
  images.transport = compose.services['home-tunnel']?.image || images.transport;
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith('COMPOSE_') || ['ABCI_DB_PASSWORD', 'ABCI_ADMIN_PASSWORD', 'MPT_DB_API_TOKEN'].includes(key)) delete env[key];
  // An explicit context wins over an ambient socket, just as in the normal launcher.
  if (env.DOCKER_CONTEXT) delete env.DOCKER_HOST;
  logOutput('Verifying, downloading and restoring the selected checkpoint…\n');
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [fileURLToPath(host)], { cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'], signal:jobContext()?.signal });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-4 * 1024 ** 2); });
    child.stderr.on('data', chunk => { logOutput(chunk.toString()); stderr = (stderr + chunk).slice(-4000); });
    child.on('error', error => reject(Error(error.code === 'ENOENT' ? 'Install Python 3 to restore a checkpoint.' : error.message)));
    child.stdin.on('error', () => {});
    child.on('close', code => {
      if (code !== 0) return reject(Error(stderr.trim() || 'Checkpoint restore interrupted. Keep the node data and retry the same checkpoint.'));
      try { resolve(JSON.parse(stdout)); } catch { reject(Error('Invalid checkpoint restore result. Preserve the node data.')); }
    });
    child.stdin.end(JSON.stringify({ action: 'restore', id: envelope.manifest.id, directory, project, role,
      networkId: envelope.manifest.networkId, chainId: envelope.manifest.chainId,
      images, helperImage: images.transport, envelope, fingerprint, baseUrl, fileHelper }));
  });
}

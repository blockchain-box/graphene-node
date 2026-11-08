#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { verifyManifest } from './checkpoint-core.js';
import { publicCheckpointTrust, checkpointFingerprint } from './checkpoint-trust.js';
export { publicCheckpointTrust, checkpointFingerprint } from './checkpoint-trust.js';
import { checkpointDownloadPath, serveCheckpointDownload } from './checkpoint-serving.js';
import { loadTunnelSeed, tunnelPublicKey, openGrphServer } from '../agents/lib/grph-tunnel.js';

function hostIdentity(identityFile, publicationDirectory) {
  const requested = path.resolve(identityFile), root = fs.realpathSync(publicationDirectory);
  const inside = file => file === root || file.startsWith(root + path.sep);
  if (inside(requested)) throw new Error('Checkpoint host identity must stay outside the public publication directory.');
  fs.mkdirSync(path.dirname(requested), { recursive: true, mode: 0o700 });
  const resolved = path.join(fs.realpathSync(path.dirname(requested)), path.basename(requested));
  if (inside(resolved)) throw new Error('Checkpoint host identity must stay outside the public publication directory.');
  if (fs.existsSync(resolved)) {
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Checkpoint host identity must be a private regular file (mode 0600).');
  }
  return loadTunnelSeed(resolved);
}

export function checkpointHostIdentity({ identityFile, publicationDirectory }) {
  const seed = hostIdentity(identityFile, publicationDirectory);
  return { key: tunnelPublicKey(seed), manifestURL: `grph://${tunnelPublicKey(seed)}/checkpoints/latest.json` };
}

function readLatest(publicationDirectory, trust) {
  const file = path.join(publicationDirectory, 'latest.json');
  const root = fs.realpathSync(publicationDirectory), resolved = fs.realpathSync(file);
  if (!resolved.startsWith(root + path.sep) || !fs.statSync(resolved).isFile() || fs.statSync(resolved).size > 65536) throw new Error('Invalid public checkpoint manifest.');
  const envelope = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  verifyManifest(envelope, trust);
  return envelope;
}

export async function startCheckpointHost({ publicationDirectory, identityFile, trust, port = 0, maxConcurrent = 8, bootstrap, publish = openGrphServer }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 128) throw new Error('Invalid checkpoint host port or concurrency limit.');
  const root = fs.realpathSync(publicationDirectory);
  if (!fs.statSync(root).isDirectory()) throw new Error('Checkpoint publication path must be a directory.');
  const seed = hostIdentity(identityFile, root), key = tunnelPublicKey(seed);
  const manifestURL = `grph://${key}/checkpoints/latest.json`;
  const enrollment = publicCheckpointTrust(trust, manifestURL);
  let active = 0;
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000, keepAliveTimeout: 5000 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    const host = /^(127\.0\.0\.1|localhost):([0-9]{1,5})$/.exec(req.headers.host || '');
    if (!loopback || !host || Number(host[2]) < 1 || Number(host[2]) > 65535) return reply(403, { error: 'Checkpoint transport must use loopback.' });
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return reply(405, { error: 'This checkpoint host is read-only.' }); }
    if (req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) { res.setHeader('Connection', 'close'); return reply(400, { error: 'Checkpoint downloads do not accept request bodies.' }); }
    const match = checkpointDownloadPath.exec(req.url);
    if (!match && !['/healthz', '/checkpoints/enrollment.json'].includes(req.url)) return reply(404, { error: 'Checkpoint not found.' });
    if (active >= maxConcurrent) { res.setHeader('Retry-After', '5'); return reply(503, { error: 'Checkpoint host is busy. Retry shortly.' }); }
    active++;
    let released = false;
    const release = () => { if (!released) { released = true; active--; } };
    res.once('close', release); res.once('finish', release);
    try {
      if (req.url === '/checkpoints/enrollment.json') return reply(200, enrollment);
      if (req.url === '/healthz' || match[1] === 'latest.json') {
        const envelope = readLatest(root, enrollment);
        return reply(200, req.url === '/healthz' ? { status: 'ready', height: envelope.manifest.height, id: envelope.manifest.id } : envelope);
      }
      await serveCheckpointDownload(req, res, root, match[1]);
    } catch { reply(503, { error: 'No fresh, verified checkpoint is available.' }); }
  });
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 100;
  server.setTimeout(15 * 60000, socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  let tunnel;
  const close = async () => {
    try { await tunnel?.close(); }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  };
  try {
    tunnel = await publish({ seed, port: server.address().port, ...(bootstrap ? { bootstrap } : {}) });
    if (tunnel.key !== key) throw new Error('Checkpoint transport identity changed unexpectedly.');
    return { server, key, manifestURL, enrollment, fingerprint: checkpointFingerprint(enrollment.publicKey), close };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = (name, fallback) => {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(`Provide a value for ${name}.`);
    return process.argv[index + 1];
  };
  try {
    const command = process.argv[2];
    if (!['identity', 'serve'].includes(command)) throw new Error('Usage: npm run checkpoint:host -- identity|serve --publication DIR --identity PRIVATE_FILE [--trust PUBLIC_TRUST_JSON] [--port LOOPBACK_PORT] [--max-concurrent 8]');
    const publicationDirectory = path.resolve(option('--publication', './.checkpoints/publication'));
    const identityFile = path.resolve(option('--identity', './.checkpoints/host-p2p.json'));
    if (command === 'identity') console.log(JSON.stringify(checkpointHostIdentity({ identityFile, publicationDirectory }), null, 2));
    else {
      const trustFile = path.resolve(option('--trust', './.checkpoints/trust.json'));
      if (fs.statSync(trustFile).size > 65536) throw new Error('Checkpoint trust configuration is too large.');
      const host = await startCheckpointHost({ publicationDirectory, identityFile, trust: JSON.parse(fs.readFileSync(trustFile, 'utf8')), port: Number(option('--port', '0')), maxConcurrent: Number(option('--max-concurrent', '8')) });
      console.log(`Public read-only checkpoint location: ${host.manifestURL}`);
      console.log(`Public enrollment: grph://${host.key}/checkpoints/enrollment.json`);
      console.log(`Publisher fingerprint (SHA-256): ${host.fingerprint}`);
      console.log('Authenticate this fingerprint and the genesis pin through an independent trusted channel before enrollment.');
      let stopping = false;
      const stop = () => { if (!stopping) { stopping = true; void host.close().catch(error => { console.error(error.message); process.exitCode = 1; }); } };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    }
  } catch (error) { console.error(`Checkpoint host failed: ${error.message}`); process.exitCode = 1; }
}

import http from 'node:http';
import fs from 'node:fs';
import { hash, HASH, networkScope } from './update-contracts.js';
import { loadTunnelSeed, openGrphServer } from './grph-tunnel.js';
import path from 'node:path';

export async function serveUpdates(store, { publish = openGrphServer, bootstrap, maxConnections = 4 } = {}) {
  let active = 0;
  const scope = networkScope(store.profile);
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'GET' || req.url.length > 512) return send(405, { error: 'Read-only update service.' });
    if (active >= maxConnections) return send(429, { error: 'Update service is busy.' });
    active++;
    try {
      if (req.url === '/updates/v1/capabilities') return send(200, { protocol: 1, activation: false, networkScope: scope });
      const current = store.release();
      if (!current) return send(404, { error: 'No verified release available.' });
      if (req.url === `/updates/v1/networks/${scope}/channels/${store.profile.channel}`) {
        const envelope = store.channel();
        // Expired signed metadata can still be carried by peers. Receivers enforce
        // freshness independently; serving it never authorizes local activation.
        return send(200, envelope);
      }
      if (req.url === `/updates/v1/releases/${store.state().releaseHash}`) return send(200, current.envelope);
      const match = /^\/updates\/v1\/artifacts\/([a-f0-9]{64})\/chunks\/(0|[1-9][0-9]{0,5})$/.exec(req.url);
      if (!match || !HASH.test(match[1])) return send(404, { error: 'Unknown update resource.' });
      // Publishers can seed multiple targets; ordinary agents only possess the
      // native artifacts they downloaded. Never serve undeclared cache files.
      const artifact = current.manifest.artifacts.find(a => a.sha256 === match[1]);
      const index = Number(match[2]);
      if (!artifact || index >= artifact.chunks.length) return send(404, { error: 'Unknown artifact chunk.' });
      const file = store.artifactPath(artifact.sha256);
      if (!fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.statSync(file).size !== artifact.bytes) return send(404, { error: 'Artifact not staged.' });
      const offset = index * artifact.chunkSize;
      const bytes = Buffer.alloc(Math.min(artifact.chunkSize, artifact.bytes - offset));
      const fd = fs.openSync(file, 'r');
      let read;
      try { read = fs.readSync(fd, bytes, 0, bytes.length, offset); } finally { fs.closeSync(fd); }
      if (read !== bytes.length || hash(bytes) !== artifact.chunks[index]) return send(503, { error: 'Cached artifact failed verification.' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
      // Bound aggregate egress independently of the requesting peer's settings.
      const quantum = Math.max(1, Math.min(16384, Math.floor(store.profile.bytesPerSecond / maxConnections / 10)));
      for (let pos = 0; pos < bytes.length && !res.destroyed; pos += quantum) {
        const piece = bytes.subarray(pos, pos + quantum);
        res.write(piece);
        await new Promise(resolve => setTimeout(resolve, Math.ceil(piece.length * 1000 * maxConnections / store.profile.bytesPerSecond)));
      }
      res.end();
    } catch {
      if (!res.headersSent) send(503, { error: 'Verified update metadata is unavailable.' });
      else res.destroy();
    } finally { active--; }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.maxConnections = 16;
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let publication;
  try {
    publication = await publish({ seed: loadTunnelSeed(path.join(store.directory, 'update-p2p.json')), port: server.address().port, bootstrap });
  } catch (error) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); throw error; }
  return { key: publication.key, origin: `http://127.0.0.1:${server.address().port}`, async close() {
    try { await publication.close(); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  } };
}

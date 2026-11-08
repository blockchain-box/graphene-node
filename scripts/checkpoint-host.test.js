import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import HyperDHT from 'hyperdht';
import { gzipSync } from 'node:zlib';
import { startCheckpointHost, checkpointHostIdentity, publicCheckpointTrust, checkpointFingerprint } from './checkpoint-host.js';
import { canonical, fetchCheckpoint, signManifest } from './checkpoint-core.js';
import { openGrphClient, tunnelPublicKey } from '../agents/lib/grph-tunnel.js';
import { enrollCheckpointHost } from './checkpoint-enroll.js';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function directories(names) {
  return gzipSync(Buffer.concat([...names.map(name => {
    const header = Buffer.alloc(512);
    header.write(name); header.write('0000700\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write('00000000000\0', 124); header.write('00000000000\0', 136); header.fill(32, 148, 156); header.write('5', 156); header.write('ustar\0', 257);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    return header;
  }), Buffer.alloc(1024)]));
}

function fixture(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'grph-checkpoint-host-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const publicationDirectory = path.join(folder, 'publication'), id = 'height-42-host-test';
  fs.mkdirSync(path.join(publicationDirectory, id), { recursive: true });
  const keys = crypto.generateKeyPairSync('ed25519');
  const trust = { chainId: 9876, genesisHash: 'f'.repeat(64), publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), maxAgeHours: 24, secret: 'NEVER_PUBLISH_THIS', manifestURL: 'http://127.0.0.1:1/old.json' };
  const data = { 'genesis.json': Buffer.from('{}'), 'app-state.json': Buffer.from('{}'), 'mpt.tar.gz': directories(['db', 'db/state', 'db/blocks', 'db/receipts', 'db/transactions']), 'tendermint.tar.gz': directories(['blockstore.db', 'state.db', 'evidence.db', 'tx_index.db']) };
  const manifest = { format: 1, kind: 'graphene-local-checkpoint', id, chainId: 9876, genesisHash: trust.genesisHash, height: '42', appHash: 'a'.repeat(64), blockHash: 'b'.repeat(64), createdAt: new Date().toISOString(), files: Object.fromEntries(Object.entries(data).map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha(bytes) }])), verification: { caughtUp: true, height: 44, appHash: 'c'.repeat(64) } };
  for (const [name, bytes] of Object.entries(data)) fs.writeFileSync(path.join(publicationDirectory, id, name), bytes);
  const writeManifest = value => {
    const signed = JSON.stringify(signManifest(value, keys.privateKey));
    fs.writeFileSync(path.join(publicationDirectory, 'latest.json'), signed);
    fs.writeFileSync(path.join(publicationDirectory, id, 'manifest.json'), signed);
  };
  writeManifest(manifest);
  return { folder, publicationDirectory, identityFile: path.join(folder, 'private', 'host.json'), trust, manifest, writeManifest, keys };
}

const localPublication = async ({ seed }) => ({ key: tunnelPublicKey(seed), close: async () => {} });
async function start(t, data, extra = {}) {
  const host = await startCheckpointHost({ ...data, publish: localPublication, ...extra });
  t.after(() => host.close());
  return { ...host, origin: `http://127.0.0.1:${host.server.address().port}` };
}

test('public host exposes verified downloads and public enrollment without management, upload or private data', async t => {
  const data = fixture(t), host = await start(t, data);
  assert.equal(host.server.address().address, '127.0.0.1');
  const enrollment = await (await fetch(host.origin + '/checkpoints/enrollment.json')).json();
  assert.equal(enrollment.manifestURL, host.manifestURL);
  assert.equal(enrollment.publicKey, data.trust.publicKey);
  assert.equal(enrollment.secret, undefined);
  assert.equal(host.fingerprint, checkpointFingerprint(data.trust.publicKey));
  const latest = await (await fetch(host.origin + '/checkpoints/latest.json')).json();
  assert.equal(canonical(latest.manifest), canonical(data.manifest));
  assert.equal((await fetch(host.origin + '/healthz')).status, 200);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await fetch(host.origin + '/checkpoints/latest.json', { method });
    assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET');
  }
  for (const route of ['/manager/nodes', '/launcher', '/checkpoints/host.json', '/checkpoints/publisher.pem', '/checkpoints/trust.json', '/checkpoints/height-42-host-test/node_key.json']) assert.equal((await fetch(host.origin + route)).status, 404, route);
  const foreignHost = await new Promise((resolve, reject) => {
    const request = http.get(host.origin + '/healthz', { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(foreignHost, 403);
  const result = await fetchCheckpoint({ ...enrollment, manifestURL: host.origin + '/checkpoints/latest.json' }, path.join(data.folder, 'cache'));
  assert.equal(result.manifest.height, '42');
});

test('private transport identity is stable across restarts and cannot live in the public tree', async t => {
  const data = fixture(t);
  const first = checkpointHostIdentity(data), second = checkpointHostIdentity(data);
  assert.deepEqual(first, second);
  assert.equal(fs.statSync(data.identityFile).mode & 0o777, 0o600);
  assert.throws(() => checkpointHostIdentity({ ...data, identityFile: path.join(data.publicationDirectory, 'private.json') }), /outside/);
  fs.symlinkSync(data.publicationDirectory, path.join(data.folder, 'public-link'));
  assert.throws(() => checkpointHostIdentity({ ...data, identityFile: path.join(data.folder, 'public-link', 'private.json') }), /outside/);
  const host = await startCheckpointHost({ ...data, publish: localPublication });
  const key = host.key; await host.close();
  const restarted = await start(t, data);
  assert.equal(restarted.key, key);
});

test('stale or tampered latest checkpoints are unavailable while public trust remains accessible', async t => {
  const data = fixture(t), host = await start(t, data);
  data.writeManifest({ ...data.manifest, createdAt: '2020-01-01T00:00:00Z' });
  assert.equal((await fetch(host.origin + '/healthz')).status, 503);
  assert.equal((await fetch(host.origin + '/checkpoints/latest.json')).status, 503);
  assert.equal((await fetch(host.origin + '/checkpoints/enrollment.json')).status, 200);
  fs.writeFileSync(path.join(data.publicationDirectory, 'latest.json'), JSON.stringify({ manifest: data.manifest, signature: '' }));
  assert.equal((await fetch(host.origin + '/checkpoints/latest.json')).status, 503);
  data.writeManifest(data.manifest);
  assert.equal((await fetch(host.origin + '/healthz')).status, 200);
});

test('host refuses private signing material as public enrollment and bounds simultaneous transfers', async t => {
  const data = fixture(t);
  assert.throws(() => publicCheckpointTrust({ ...data.trust, publicKey: data.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) }, 'http://127.0.0.1:1/latest.json'), /public/);
  const body = Buffer.alloc(16 * 1024 ** 2, 1), hash = sha(body);
  fs.mkdirSync(path.join(data.publicationDirectory, 'objects'));
  fs.writeFileSync(path.join(data.publicationDirectory, 'objects', hash + '.gz'), body);
  const host = await start(t, data, { maxConcurrent: 1 });
  const request = http.get(host.origin + `/checkpoints/objects/${hash}.gz`);
  request.on('error', () => {});
  await new Promise(resolve => request.once('response', response => { response.pause(); response.on('error', () => {}); resolve(); }));
  const response = await fetch(host.origin + '/healthz');
  assert.equal(response.status, 503); assert.equal(response.headers.get('retry-after'), '5');
  request.destroy();
});

test('public read-only location supports real Grph P2P enrollment, downloads and stable identity', async t => {
  const data = fixture(t);
  const reservation = dgram.createSocket('udp4');
  await new Promise(resolve => reservation.bind(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const dht = HyperDHT.bootstrapper(port, '127.0.0.1'); await dht.ready();
  const bootstrap = ['127.0.0.1:' + port];
  const saved = process.env.GRAPHENE_DHT_BOOTSTRAP;
  process.env.GRAPHENE_DHT_BOOTSTRAP = bootstrap.join(',');
  let client, host;
  t.after(async () => {
    await client?.close(); await host?.close(); await dht.destroy();
    if (saved === undefined) delete process.env.GRAPHENE_DHT_BOOTSTRAP;
    else process.env.GRAPHENE_DHT_BOOTSTRAP = saved;
  });
  host = await startCheckpointHost({ ...data, trust: { ...data.trust, maxAgeHours: 8760 }, bootstrap });
  client = await openGrphClient(host.key, { bootstrap, timeoutMs: 10000 });
  const enrollment = await (await fetch(client.origin + '/checkpoints/enrollment.json')).json();
  assert.equal(enrollment.manifestURL, host.manifestURL);
  const result = await fetchCheckpoint(enrollment, path.join(data.folder, 'remote-cache'));
  assert.equal(result.manifest.height, '42');
  const enrollmentURL = `grph://${host.key}/checkpoints/enrollment.json`;
  const output = path.join(data.folder, 'validator', 'trust.json');
  const pins = { url: enrollmentURL, fingerprint: host.fingerprint, genesisHash: data.trust.genesisHash, output };
  const installed = await enrollCheckpointHost(pins);
  assert.equal(installed.maxAgeHours, 24, 'remote host cannot relax the validator’s local freshness policy');
  assert.equal(installed.manifestURL, host.manifestURL);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(output)).secret, undefined);
  const original = fs.readFileSync(output);
  await assert.rejects(enrollCheckpointHost(pins), /already exists/);
  assert.deepEqual(fs.readFileSync(output), original);
  for (const change of [{ fingerprint: '0'.repeat(64) }, { genesisHash: '0'.repeat(64) }]) {
    const rejected = path.join(data.folder, 'rejected.json');
    await assert.rejects(enrollCheckpointHost({ ...pins, ...change, output: rejected }), /fingerprint|genesis/);
    assert.equal(fs.existsSync(rejected), false);
  }
  data.writeManifest({ ...data.manifest, createdAt: new Date(Date.now() - 48 * 3600000).toISOString() });
  const stale = path.join(data.folder, 'stale.json');
  await assert.rejects(enrollCheckpointHost({ ...pins, output: stale }), /expired/);
  assert.equal(fs.existsSync(stale), false);
  data.writeManifest(data.manifest);
  assert.equal((await fetch(client.origin + '/manager/nodes')).status, 404);
  assert.equal((await fetch(client.origin + '/checkpoints/latest.json', { method: 'PUT', body: '{}' })).status, 405);
});

test('enrollment rejects endpoint substitution without persisting trust', async t => {
  const data = fixture(t);
  const server = http.createServer((req, res) => res.end(JSON.stringify({ ...data.trust, manifestURL: 'http://127.0.0.1:1/checkpoints/latest.json' })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const output = path.join(data.folder, 'rejected.json');
  await assert.rejects(enrollCheckpointHost({ url: `http://127.0.0.1:${server.address().port}/checkpoints/enrollment.json`, fingerprint: checkpointFingerprint(data.trust.publicKey), genesisHash: data.trust.genesisHash, output }), /endpoint/);
  assert.equal(fs.existsSync(output), false);
});

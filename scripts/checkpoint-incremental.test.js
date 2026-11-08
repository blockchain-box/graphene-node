import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { publishCheckpoint } from './checkpoint-docker.js';
import { artifacts, canonical, fetchCheckpoint, fileHash, signManifest, verifyManifest, verifyArchive } from './checkpoint-core.js';
import { archiveNames, materializePublication, objectFile, readArchiveIndex } from './checkpoint-storage.js';
import { checkpointDownloadPath, serveCheckpointDownload } from './checkpoint-serving.js';
import { createSetupServer } from './join-network.js';
import { enrollCheckpointHost } from './checkpoint-enroll.js';
import { checkpointFingerprint } from './checkpoint-trust.js';

function temporary(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'graphene-incremental-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

function entry(name, body = null, mtime = 1) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write('0000600\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write((body?.length || 0).toString(8).padStart(11, '0') + '\0', 124);
  header.write(mtime.toString(8).padStart(11, '0') + '\0', 136);
  header.fill(32, 148, 156); header.write(body === null ? '5' : '0', 156); header.write('ustar\0', 257);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, body || Buffer.alloc(0), Buffer.alloc((512 - (body?.length || 0) % 512) % 512)]);
}

const genesis = { chain_id: 'incremental-test', initial_height: '1' };
const unchanged = crypto.randomBytes(100000);
function snapshot(directory, height, changed = false) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'genesis.json'), JSON.stringify(genesis));
  fs.writeFileSync(path.join(directory, 'app-state.json'), JSON.stringify({ chain_id: 9876, current_height: height, session_token: 'PRIVATE', current_app_root: '0x' + 'a'.repeat(64), current_block_hash: '0x' + 'b'.repeat(64), genesis_app_root: '0x' + 'c'.repeat(64), genesis_block_hash: '0x' + 'd'.repeat(64), genesis_versions: '["v0"]' }));
  const mtime = changed ? 99 : 1;
  for (const [name, directories] of Object.entries({ 'mpt.tar': ['db', 'db/state', 'db/blocks', 'db/receipts', 'db/transactions'], 'tendermint.tar': ['blockstore.db', 'state.db', 'evidence.db', 'tx_index.db'] })) {
    const root = name === 'mpt.tar' ? 'db/state' : 'state.db';
    fs.writeFileSync(path.join(directory, name), Buffer.concat([
      ...directories.map(name => entry(name, null, mtime)),
      entry(`${root}/000001.ldb`, unchanged, mtime),
      entry(`${root}/CURRENT`, Buffer.from(changed ? 'MANIFEST-000003\n' : 'MANIFEST-000002\n'), mtime),
      ...(changed ? [entry(`${root}/000003.ldb`, Buffer.from('new table'))] : [entry(`${root}/000002.ldb`, Buffer.from('deleted table'))]),
      Buffer.alloc(1024),
    ]));
  }
}

function settings(folder) {
  const keys = crypto.generateKeyPairSync('ed25519');
  return {
    output: path.join(folder, 'publication'), privateKey: keys.privateKey, progress() {},
    run: async args => { assert.deepEqual(args.slice(0, 2), ['image', 'inspect']); return JSON.stringify([{ Id: `sha256:${args[2]}` }]); },
    read: async url => url.endsWith('/genesis') ? { result: { genesis } } : { result: { block: { header: { app_hash: 'a'.repeat(64) } }, block_id: { hash: 'b'.repeat(64) } } },
    verifyRestore: async (directory, trust) => {
      const manifest = verifyManifest(JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'))), trust, { requireVerified: false });
      await verifyArchive(path.join(directory, 'mpt.tar.gz'), 'mpt');
      await verifyArchive(path.join(directory, 'tendermint.tar.gz'), 'tendermint');
      return { caughtUp: true, height: Number(manifest.height) + 2, appHash: 'a'.repeat(64), nonVoting: true };
    },
  };
}

async function publications(t) {
  const folder = temporary(t), options = settings(folder);
  const firstInput = path.join(folder, 'first'), secondInput = path.join(folder, 'second');
  snapshot(firstInput, 42); snapshot(secondInput, 43, true);
  const first = await publishCheckpoint({ ...options, inputDirectory: firstInput });
  const second = await publishCheckpoint({ ...options, inputDirectory: secondInput });
  return { folder, options, first, second };
}

async function startServer(t, output, intercept = () => false) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (intercept(req, res)) return;
    const match = checkpointDownloadPath.exec(req.url);
    if (!match) { res.writeHead(404).end(); return; }
    void serveCheckpointDownload(req, res, output, match[1]);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { origin: `http://127.0.0.1:${server.address().port}`, requests };
}

test('next publication reuses unchanged entries despite mtime changes, records its parent, and omits deleted files', async t => {
  const { folder, options, first, second } = await publications(t);
  assert.equal(first.manifest.incremental.parent, null);
  assert.deepEqual(second.manifest.incremental.parent, { id: first.manifest.id, height: '42', sha256: crypto.createHash('sha256').update(canonical(first.manifest)).digest('hex') });
  assert.ok(second.stats.reusedBytes > 100000, JSON.stringify(second.stats));
  assert.ok(second.stats.createdBytes < first.stats.createdBytes / 10);
  assert.equal(fs.existsSync(path.join(second.directory, 'mpt.tar.gz')), false, 'publication stores shared objects instead of full duplicates');
  const directory = await materializePublication(second.directory, second.manifest, path.join(folder, 'restored'));
  for (const name of archiveNames) {
    await verifyArchive(path.join(directory, name), name === 'mpt.tar.gz' ? 'mpt' : 'tendermint');
    const raw = gunzipSync(fs.readFileSync(path.join(directory, name)));
    assert.ok(raw.includes(Buffer.from('000003.ldb')));
    assert.ok(!raw.includes(Buffer.from('000002.ldb')), 'deleted tables must not survive reconstruction');
    assert.equal(await fileHash(path.join(directory, name)), second.manifest.files[name].sha256);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'app-state.json'))).session_token, null);
  const full = await publishCheckpoint({ ...options, inputDirectory: path.join(folder, 'second'), full: true });
  assert.equal(full.manifest.incremental.parent, null);
  const republished = await publishCheckpoint({ ...options, inputDirectory: second.directory });
  assert.equal(republished.manifest.height, '43', 'published object-only directories remain valid publish inputs');
});

test('warm downloads fetch only missing objects, resume partials, repair corruption, and fresh clients need no parents', async t => {
  const { folder, options, first, second } = await publications(t);
  const { origin, requests } = await startServer(t, options.output);
  const trust = { ...first.trust, manifestURL: `${origin}/checkpoints/latest.json` };
  const cache = path.join(folder, 'cache');
  fs.copyFileSync(path.join(first.directory, 'manifest.json'), path.join(options.output, 'latest.json'));
  await fetchCheckpoint(trust, cache);
  fs.copyFileSync(path.join(second.directory, 'manifest.json'), path.join(options.output, 'latest.json'));
  const index = await readArchiveIndex(path.join(second.directory, 'index.json'), second.manifest.incremental.index, second.manifest.files);
  const chunks = [...new Map(Object.values(index.archives).flat().map(chunk => [chunk.sha256, chunk])).values()];
  const missing = chunks.filter(chunk => !fs.existsSync(objectFile(cache, chunk.sha256)));
  const partial = missing[0];
  fs.writeFileSync(objectFile(cache, partial.sha256) + '.part', fs.readFileSync(objectFile(options.output, partial.sha256)).subarray(0, 10));
  requests.length = 0;
  const downloaded = await fetchCheckpoint(trust, cache);
  assert.equal(requests.filter(url => url.includes('/objects/')).length, missing.length);
  assert.ok(!requests.some(url => /\.tar\.gz$/.test(url)), 'warm clients never fetch full archives');
  for (const name of archiveNames) assert.equal(await fileHash(path.join(downloaded.directory, name)), second.manifest.files[name].sha256);
  const corrupt = chunks.find(chunk => !missing.includes(chunk));
  fs.writeFileSync(objectFile(cache, corrupt.sha256), Buffer.alloc(corrupt.bytes));
  for (const name of archiveNames) fs.rmSync(path.join(downloaded.directory, name));
  requests.length = 0;
  await fetchCheckpoint(trust, cache);
  assert.deepEqual(requests.filter(url => url.includes('/objects/')), [`/checkpoints/objects/${corrupt.sha256}.gz`]);
  fs.rmSync(first.directory, { recursive: true });
  requests.length = 0;
  const fresh = await fetchCheckpoint(trust, path.join(folder, 'fresh-cache'));
  assert.equal(fresh.manifest.height, '43');
  assert.ok(!requests.some(url => url.includes(first.manifest.id)), 'no historical manifest or checkpoint is required');
});

test('launcher streams exact full archive bytes and ranges for legacy clients without materialized archives', async t => {
  const { folder, options, second } = await publications(t);
  const { server } = createSetupServer({ directory: path.join(folder, 'secrets'), checkpointDirectory: options.output });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const name of archiveNames) {
    const url = `${origin}/checkpoints/${second.manifest.id}/${name}`;
    const all = Buffer.from(await (await fetch(url)).arrayBuffer());
    assert.equal(crypto.createHash('sha256').update(all).digest('hex'), second.manifest.files[name].sha256);
    for (const offset of [1, Math.floor(all.length / 2), all.length - 1]) {
      const response = await fetch(url, { headers: { Range: `bytes=${offset}-` } });
      assert.equal(response.status, 206);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), all.subarray(offset));
    }
    assert.equal((await fetch(url, { headers: { Range: `bytes=${all.length}-` } })).status, 416);
  }
  assert.equal((await fetch(`${origin}/checkpoints/${second.manifest.id}/publisher.pem`)).status, 404);
});

test('object endpoint unavailable falls back to verified full archives; tampered signed index fails closed', async t => {
  const { folder, options, second } = await publications(t);
  const { origin, requests } = await startServer(t, options.output, (req, res) => {
    if (!req.url.includes('/objects/')) return false;
    res.writeHead(404).end(); return true;
  });
  const trust = { ...second.trust, manifestURL: `${origin}/checkpoints/latest.json` };
  await fetchCheckpoint(trust, path.join(folder, 'cache'));
  assert.equal(requests.filter(url => url.endsWith('.tar.gz')).length, 2);
  const indexFile = path.join(second.directory, 'index.json');
  fs.writeFileSync(indexFile, Buffer.alloc(fs.statSync(indexFile).size, 32));
  await assert.rejects(fetchCheckpoint(trust, path.join(folder, 'tampered')), /integrity/);
});

test('failed restore verification preserves latest publication and old manifests remain supported', async t => {
  const { folder, options, second } = await publications(t);
  const latest = fs.readFileSync(path.join(options.output, 'latest.json'));
  await assert.rejects(publishCheckpoint({ ...options, inputDirectory: path.join(folder, 'second'), verifyRestore: async () => { throw new Error('restore failed'); } }), /restore failed/);
  assert.deepEqual(fs.readFileSync(path.join(options.output, 'latest.json')), latest);
  const legacy = { ...second.manifest }; delete legacy.incremental;
  fs.writeFileSync(path.join(options.output, 'latest.json'), JSON.stringify(signManifest(legacy, options.privateKey)));
  const { origin, requests } = await startServer(t, options.output);
  const result = await fetchCheckpoint({ ...second.trust, manifestURL: `${origin}/checkpoints/latest.json` }, path.join(folder, 'legacy'));
  assert.equal(result.manifest.height, '43');
  assert.equal(requests.filter(url => url.endsWith('.tar.gz')).length, 2);
  for (const name of artifacts) assert.equal(await fileHash(path.join(result.directory, name)), legacy.files[name].sha256);
});

test('invalid parent, chunk paths, size totals and index tampering are rejected before reconstruction', async t => {
  const { options, first, second } = await publications(t);
  for (const parent of [{ id: '../keys', height: '42', sha256: 'a'.repeat(64) }, { id: first.manifest.id, height: '43', sha256: 'a'.repeat(64) }]) {
    const manifest = { ...second.manifest, incremental: { ...second.manifest.incremental, parent } };
    assert.throws(() => verifyManifest(signManifest(manifest, options.privateKey), second.trust), /parent/);
  }
  const file = path.join(second.directory, 'index.json');
  const original = JSON.parse(fs.readFileSync(file));
  for (const change of [chunk => { chunk.sha256 = '../key'; }, chunk => { chunk.bytes++; }]) {
    const value = structuredClone(original); change(value.archives['mpt.tar.gz'][0]);
    const bytes = Buffer.from(JSON.stringify(value)); fs.writeFileSync(file, bytes);
    const expected = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    await assert.rejects(readArchiveIndex(file, expected, second.manifest.files), /chunk|size/i);
  }
});

test('reopening a launcher refuses an older backend without shared checkpoint objects', async t => {
  const { startSetupLauncher } = await import('./join-network.js');
  const folder = temporary(t);
  const features = ['checkpoint-bootstrap-v1', 'public-setup-import-v1', 'node-manager-v1', 'p2p-manager-v1', 'operator-guide-v1', 'wallet-discovery-v1', 'agent-funding-v1', 'host-doctor-v1', 'host-monitor-v1', 'saved-node-removal-v1', 'checkpoint-reset-v1'];
  const server = http.createServer((req, res) => res.end(JSON.stringify({ service: 'graphene-launcher', pid: process.pid, features })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  fs.writeFileSync(path.join(folder, 'launcher.json'), JSON.stringify({ port, pid: process.pid, token: 'a'.repeat(64), config: JSON.stringify([path.join(folder, 'keystore.enc'), path.join(folder, 'sentry-secrets.json')]) }));
  await assert.rejects(startSetupLauncher({ directory: folder, port }), /without incremental checkpoint downloads/);
});

test('a selected node checkpoint enrolls and downloads from its immutable manifest with signed source provenance', async t => {
  const { folder, options, second } = await publications(t);
  const { origin, requests } = await startServer(t, options.output);
  const agentAddress = '0x' + '1'.repeat(40);
  const manifest = { ...second.manifest, source: { agentAddress, role: 'sentry' } };
  fs.writeFileSync(path.join(second.directory, 'manifest.json'), JSON.stringify(signManifest(manifest, options.privateKey)));
  const pinned = { ...second.trust, manifestURL: `${origin}/checkpoints/${manifest.id}/manifest.json` };
  fs.writeFileSync(path.join(second.directory, 'enrollment.json'), JSON.stringify(pinned));
  const enrollment = { url: `${origin}/checkpoints/${manifest.id}/enrollment.json`, fingerprint: checkpointFingerprint(second.trust.publicKey), genesisHash: second.trust.genesisHash, expectedSource: agentAddress };
  const trust = await enrollCheckpointHost({ ...enrollment, output: path.join(folder, 'node-trust.json') });
  const downloaded = await fetchCheckpoint(trust, path.join(folder, 'selected-node-cache'));
  assert.equal(downloaded.manifest.source.agentAddress, agentAddress);
  for (const name of archiveNames) assert.equal(await fileHash(path.join(downloaded.directory, name)), manifest.files[name].sha256);
  assert.ok(!requests.some(url => url.includes(`/${manifest.id}/${manifest.id}/`)), 'immutable manifests resolve artifacts from the publication root');
  await assert.rejects(enrollCheckpointHost({ ...enrollment, expectedSource: '0x' + '2'.repeat(40), output: path.join(folder, 'wrong-source.json') }), /selected source node/);
  assert.equal(fs.existsSync(path.join(folder, 'wrong-source.json')), false);
});

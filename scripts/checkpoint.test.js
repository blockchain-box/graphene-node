import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { canonical, genesisHash, signManifest, verifyManifest, sanitizeAppState, verifyArchive, downloadFile, checkpointURL } from './checkpoint-core.js';
import { verifyRestore } from './checkpoint-verify.js';
import { tunnelPublicKey } from '../agents/lib/grph-tunnel.js';
import { assertFreshHome } from './checkpoint-docker.js';

const keys = crypto.generateKeyPairSync('ed25519');
const trust = { chainId: 9876, genesisHash: 'f'.repeat(64), publicKey: keys.publicKey };
const manifest = () => ({ format: 1, kind: 'graphene-local-checkpoint', id: 'height-42-test', chainId: 9876, genesisHash: trust.genesisHash, height: '42', appHash: 'a'.repeat(64), blockHash: 'b'.repeat(64), createdAt: new Date().toISOString(), files: Object.fromEntries(['genesis.json', 'app-state.json', 'mpt.tar.gz', 'tendermint.tar.gz'].map((name) => [name, { bytes: 10, sha256: 'c'.repeat(64) }])), verification: { caughtUp: true, height: 45, appHash: 'd'.repeat(64) } });
function temporary(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphene-checkpoint-unit-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('publisher signature, pinned network, freshness and restore attestation are required', () => {
  const original = manifest();
  assert.equal(verifyManifest(signManifest(original, keys.privateKey), trust).height, '42');
  assert.throws(() => verifyManifest(signManifest(original, keys.privateKey), { ...trust, publicKey: crypto.generateKeyPairSync('ed25519').publicKey }), /signature/);
  const tampered = signManifest(original, keys.privateKey); tampered.manifest.height = '43';
  assert.throws(() => verifyManifest(tampered, trust), /signature/);
  for (const change of [{ genesisHash: '0'.repeat(64) }, { chainId: 1 }, { verification: null }, { createdAt: '2020-01-01' }, { id: '../../keys' }]) assert.throws(() => verifyManifest(signManifest({ ...manifest(), ...change }, keys.privateKey), trust));
});

test('only public committed metadata is exported, never session tokens or extra fields', () => {
  const row = { chain_id: 9876, current_height: 42, session_token: 'PRIVATE_SESSION', current_app_root: '0x' + 'a'.repeat(64), current_block_hash: '0x' + 'b'.repeat(64), genesis_app_root: '0x' + 'c'.repeat(64), genesis_block_hash: '0x' + 'd'.repeat(64), genesis_versions: '["v0"]', password: 'PRIVATE_PASSWORD' };
  const result = canonical(sanitizeAppState(row));
  assert.ok(!result.includes('PRIVATE_')); assert.equal(JSON.parse(result).session_token, null);
  assert.throws(() => sanitizeAppState({ ...row, genesis_versions: '["SQL; DROP TABLE x"]' }));
});

function tarEntry(name, type = '0', body = Buffer.alloc(0)) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100); header.write('0000600\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
  header.fill(32, 148, 156); header.write(type, 156); header.write('ustar\0', 257);
  const sum = header.reduce((a, b) => a + b, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}
const mptEntries = () => ['db', 'db/state', 'db/blocks', 'db/receipts', 'db/transactions'].map((name) => tarEntry(name, '5'));
test('archive validation rejects traversal, signing files, links, duplicates and truncation', async (t) => {
  const dir = temporary(t), file = path.join(dir, 'test.gz');
  fs.writeFileSync(file, gzipSync(Buffer.concat([...mptEntries(), tarEntry('db/state/CURRENT', '0', Buffer.from('manifest')), Buffer.alloc(1024)])));
  assert.ok((await verifyArchive(file, 'mpt')).entries > 0);
  for (const bad of [tarEntry('db/../../priv_validator_state.json'), tarEntry('config/node_key.json'), tarEntry('db/state/keystore.enc'), tarEntry('db/state/node_key.json'), tarEntry('db/state/key', '2'), tarEntry('db/state', '5')]) {
    fs.writeFileSync(file, gzipSync(Buffer.concat([...mptEntries(), bad, Buffer.alloc(1024)])));
    await assert.rejects(verifyArchive(file, 'mpt'));
  }
  fs.writeFileSync(file, gzipSync(Buffer.concat(mptEntries())));
  await assert.rejects(verifyArchive(file, 'mpt'), /Truncated/);
  fs.writeFileSync(file, gzipSync(Buffer.concat([...mptEntries(), Buffer.alloc(1024)])));
  await assert.rejects(verifyArchive(file, 'mpt', { maxBytes: 512 }), /size limit/);
});

test('downloads resume, handle servers ignoring Range, and reject changed content', async (t) => {
  const dir = temporary(t), body = Buffer.from('checkpoint payload bytes');
  let ignoreRange = false, corrupt = false;
  const server = http.createServer((req, res) => {
    const offset = !ignoreRange && req.headers.range ? Number(req.headers.range.match(/\d+/)[0]) : 0;
    res.writeHead(offset ? 206 : 200, offset ? { 'Content-Range': `bytes ${offset}-${body.length - 1}/${body.length}` } : {});
    res.end(corrupt ? Buffer.alloc(body.length, 0) : body.subarray(offset));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/file`, file = path.join(dir, 'data');
  const expected = { bytes: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') };
  for (const ignore of [false, true]) {
    ignoreRange = ignore; fs.writeFileSync(file + '.part', body.subarray(0, 5));
    await downloadFile(url, file, expected); assert.deepEqual(fs.readFileSync(file), body); fs.unlinkSync(file);
  }
  fs.writeFileSync(file + '.part', body);
  await downloadFile(url, file, expected); assert.deepEqual(fs.readFileSync(file), body); fs.unlinkSync(file);
  fs.writeFileSync(file + '.part', Buffer.alloc(body.length + 50));
  await downloadFile(url, file, expected); assert.deepEqual(fs.readFileSync(file), body); fs.unlinkSync(file);
  corrupt = true;
  await assert.rejects(downloadFile(url, file, expected), /integrity/);
  assert.equal(fs.existsSync(file), false);
  for (const bad of ['http://example.com/file', 'file:///tmp/keys', 'https://user:pass@example.com/']) assert.throws(() => checkpointURL(bad));
});

test('restore refuses existing data or signing history and preserves identity bytes', (t) => {
  const home = temporary(t); fs.mkdirSync(path.join(home, 'config')); fs.mkdirSync(path.join(home, 'data'));
  const genesis = { chain_id: 'test', initial_height: '0' };
  fs.writeFileSync(path.join(home, 'config/genesis.json'), JSON.stringify(genesis));
  const state = path.join(home, 'data/priv_validator_state.json'); fs.writeFileSync(state, '{"height":"0"}');
  const m = { genesisHash: genesisHash(genesis) };
  assertFreshHome(home, m);
  fs.writeFileSync(state, '{"height":"99","signature":"preserve-me"}'); const before = fs.readFileSync(state);
  assert.throws(() => assertFreshHome(home, m), /signing history/); assert.deepEqual(fs.readFileSync(state), before);
  fs.mkdirSync(path.join(home, 'data/state.db'));
  assert.throws(() => assertFreshHome(home, m), /fresh node/);
  assert.equal(genesisHash({ ...genesis, initial_height: '1' }), genesisHash(genesis));
});

test('signed gzip artifacts retain their original bytes even when the server labels them Content-Encoding gzip', async (t) => {
  const dir = temporary(t);
  const body = gzipSync(Buffer.alloc(20000, 65));
  const server = http.createServer((req, res) => {
    const offset = req.headers.range ? Number(req.headers.range.match(/\d+/)[0]) : 0;
    res.writeHead(offset ? 206 : 200, { 'Content-Encoding': 'gzip', 'Content-Length': body.length - offset,
      ...(offset ? { 'Content-Range': `bytes ${offset}-${body.length - 1}/${body.length}` } : {}) });
    res.end(body.subarray(offset));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/state.tar.gz`;
  const expected = { bytes: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') };
  for (const offset of [0, 10]) {
    const file = path.join(dir, `data-${offset}`);
    if (offset) fs.writeFileSync(file + '.part', body.subarray(0, offset));
    await downloadFile(url, file, expected);
    assert.deepEqual(fs.readFileSync(file), body);
  }
});


test('checkpoint verifier prepares private P2P configuration before Compose can start bootstrap-source', async (t) => {
  const directory = temporary(t);
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(signManifest(manifest(), keys.privateKey)));
  fs.writeFileSync(path.join(directory, 'genesis.json'), '{}');
  const reachedStartup = new Error('configuration checked before startup');
  let checked = false;
  const reference = { project: 'donor', tm: 'donor-node-1', rpc: 'http://reference' };
  const run = async (args) => {
    if (args[0] === 'run') {
      const home = args[args.indexOf('-v') + 1].split(':/tendermint')[0];
      fs.mkdirSync(path.join(home, 'config'), { recursive: true });
      fs.writeFileSync(path.join(home, 'config/config.toml'), 'addr_book_strict = true');
      return '';
    }
    if (args[0] === 'inspect') return JSON.stringify([{ NetworkSettings: { Networks: { donor_default: {} } } }]);
    assert.equal(args[0], 'compose');
    if (args.includes('down')) return '';
    const profile = JSON.parse(fs.readFileSync(args[args.indexOf('-f') + 1]));
    const config = (service) => {
      const file = profile.services[service].volumes[0].split(':/app/p2p/config.json')[0];
      assert.ok(fs.existsSync(file), `${service} configuration must exist before Compose starts`);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      return JSON.parse(fs.readFileSync(file));
    };
    const source = config('bootstrap-source'), client = config('bootstrap-tunnel');
    assert.equal(source.host, reference.tm);
    assert.equal(source.port, 26656);
    assert.equal(client.key, tunnelPublicKey(source.seed));
    assert.deepEqual(profile.services.node.networks, ['default']);
    assert.equal(profile.networks.bootstrap.name, 'donor_default');
    assert.equal(profile.services.agent, undefined);
    checked = true;
    throw reachedStartup;
  };
  await assert.rejects(verifyRestore(directory, trust, { reference, run, read: async () => ({ result: { node_info: { id: 'peer-id' } } }) }), error => error === reachedStartup);
  assert.equal(checked, true);
});

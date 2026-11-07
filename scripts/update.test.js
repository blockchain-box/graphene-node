import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';
import HyperDHT from 'hyperdht';
import { tunnelPublicKey } from '../agents/lib/grph-tunnel.js';
import { validateProfile, networkScope, signMetadata, verifyChannel, verifyRelease, metadataHash, hash } from '../agents/lib/update-contracts.js';
import { UpdateStore } from '../agents/lib/update-store.js';
import { UpdateWorker, startAgentUpdates } from '../agents/lib/update-worker.js';
import { publishUpdate } from '../agents/lib/update-publisher.js';
import { serveUpdates } from '../agents/lib/update-service.js';
import { bindLocalUpdates, configureAgentUpdates } from './update-runtime.js';
import { genesisHash } from './checkpoint-core.js';
import { LocalNodeRuntime } from './local-node-runtime.js';
import { generateAll } from '../agents/validator-agent/src/keygen.js';
import { publicNodeSetup } from '../agents/lib/node-setup.js';

const releaseKeys = crypto.generateKeyPairSync('ed25519');
const channelKeys = crypto.generateKeyPairSync('ed25519');
const publicKey = keys => keys.publicKey.export({ type: 'spki', format: 'pem' });
const seedA = tunnelPublicKey('a'.repeat(64)), seedB = tunnelPublicKey('b'.repeat(64));
function profile(changes = {}) {
  return validateProfile({ format: 1, kind: 'graphene-update-profile', networkId: 'local-fixture', environment: 'local',
    chainId: 9876, tendermintChainId: 'local', genesisHash: 'f'.repeat(64), channel: 'dev', role: 'validator',
    target: { os: 'linux', arch: 'arm64' }, currentVersion: '1.0.0', seeds: [seedA],
    keys: { release: { release: publicKey(releaseKeys) }, channel: { channel: publicKey(channelKeys) } },
    maxArtifactBytes: 1024 ** 2, maxCacheBytes: 8 * 1024 ** 2, bytesPerSecond: 64 * 1024 ** 2, pollIntervalMs: 10000, ...changes });
}
function temp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'grph-updates-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
async function fixture(t, p = profile(), bytes = crypto.randomBytes(600000)) {
  const directory = temp(t);
  fs.writeFileSync(path.join(directory, 'bundle.tar'), bytes);
  const descriptor = { releaseId: '1.1.0', classification: 'compatible', compatibleFrom: ['1.0.0'],
    artifacts: [{ file: 'bundle.tar', component: 'blockchain', role: 'all', os: 'linux', arch: 'arm64' }] };
  const options = { directory: path.join(directory, 'seed'), profile: p, descriptor, sourceDirectory: directory,
    releaseKey: releaseKeys.privateKey, releaseKeyId: 'release', channelKey: channelKeys.privateKey, channelKeyId: 'channel',
    sequence: 1, expiresAt: new Date(Date.now() + 3600000).toISOString() };
  await publishUpdate(options);
  const store = new UpdateStore(options.directory, p);
  return { directory, profile: p, bytes, options, store,
    channel: JSON.parse(fs.readFileSync(path.join(store.directory, 'channel.json'))), ...store.release() };
}
async function localService(t, store) {
  const service = await serveUpdates(store, { publish: async () => ({ key: seedA, async close() {} }) });
  t.after(() => service.close());
  return service;
}
function localWorker(f, origin, options = {}) {
  return new UpdateWorker({ directory: path.join(f.directory, 'receiver'), profile: f.profile,
    connect: async () => ({ origin, async close() {} }), ...options });
}

test('network profiles isolate environment, genesis, role and channel while rejecting unsafe production settings', t => {
  const root = temp(t), local = profile();
  const testnet = profile({ networkId: 'testnet', environment: 'test', channel: 'candidate' });
  const prod = profile({ networkId: 'mainnet', environment: 'prod', channel: 'stable' });
  assert.equal(new Set([local, testnet, prod, profile({ genesisHash: 'e'.repeat(64) })].map(networkScope)).size, 4);
  const stores = [local, testnet, prod, profile({ role: 'sentry' }), profile({ channel: 'candidate' })].map(p => new UpdateStore(root, p));
  assert.equal(new Set(stores.map(s => s.directory)).size, 5);
  for (const changes of [{ environment: 'prod' }, { environment: 'test' }, { genesisHash: '' }, { seeds: [] }, { maxCacheBytes: 1 }, { target: { os: 'linux', arch: 'mips' } }]) {
    assert.throws(() => profile(changes));
  }
  assert.throws(() => profile({ keys: { release: { secret: releaseKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }) }, channel: { channel: publicKey(channelKeys) } } }), /trust key/);
});

test('release and channel trust reject tampering, key confusion, wrong networks, replay and expiry', async t => {
  const f = await fixture(t);
  const channel = verifyChannel(f.channel, f.profile);
  assert.equal(verifyRelease(f.envelope, f.profile, channel.releaseHash).releaseId, '1.1.0');
  const forged = structuredClone(f.channel); forged.payload.sequence++;
  assert.throws(() => verifyChannel(forged, f.profile), /signature/);
  assert.throws(() => verifyChannel(signMetadata(f.channel.payload, 'release', releaseKeys.privateKey), f.profile), /Untrusted/);
  assert.throws(() => verifyChannel(f.channel, profile({ genesisHash: 'e'.repeat(64) })), /different network/);
  assert.throws(() => verifyChannel(f.channel, f.profile, { sequence: 2 }), /replay/);
  assert.throws(() => verifyChannel(f.channel, f.profile, { sequence: 1, channelHash: '0'.repeat(64) }), /Conflicting/);
  assert.throws(() => verifyChannel(f.channel, f.profile, {}, Date.now() + 8 * 86400000), /expired/);
  assert.throws(() => verifyRelease(f.envelope, f.profile, '0'.repeat(64)), /hash mismatch/);
  assert.throws(() => verifyRelease(f.envelope, profile({ currentVersion: '0.0.1' }), channel.releaseHash), /upgrade path/);
  assert.throws(() => verifyRelease(f.envelope, profile({ target: { os: 'linux', arch: 'x64' } }), channel.releaseHash), /target/);
});

test('signed malformed artifact lists and updater versions are rejected before downloading', async t => {
  const f = await fixture(t);
  for (const change of [{ updaterProtocol: 2 }, { artifacts: [] }, { artifacts: [{ ...f.manifest.artifacts[0], chunks: [] }] },
    { artifacts: [{ ...f.manifest.artifacts[0], component: '../secret' }] },
    { artifacts: [f.manifest.artifacts[0], f.manifest.artifacts[0]] }, { compatibleFrom: ['0.0.1'] }]) {
    const manifest = { ...f.manifest, ...change };
    assert.throws(() => verifyRelease(signMetadata(manifest, 'release', releaseKeys.privateKey), f.profile, metadataHash(manifest)));
  }
});

test('publisher refuses rollback and modified source bytes never replace a published artifact', async t => {
  const f = await fixture(t);
  await publishUpdate({ ...f.options, sequence: 2 });
  await assert.rejects(publishUpdate(f.options), /replay/);
  assert.equal(f.store.state().sequence, 2);
  assert.equal(f.store.state().activationSupported, false);
  assert.equal(fs.readFileSync(f.store.artifactPath(hash(f.bytes))).equals(f.bytes), true);
  // The convenience pointer is not authoritative; the durable state references
  // immutable metadata written before the replay high-water mark.
  fs.unlinkSync(path.join(f.store.directory, 'channel.json'));
  assert.equal(f.store.channel().payload.sequence, 2);
});

test('P2P service exposes only declared artifacts and bounded verified chunks', async t => {
  const f = await fixture(t), service = await localService(t, f.store);
  assert.equal((await fetch(service.origin + '/manager/nodes')).status, 404);
  assert.equal((await fetch(service.origin + '/updates/v1/capabilities', { method: 'POST' })).status, 405);
  assert.equal((await fetch(service.origin + `/updates/v1/artifacts/${'0'.repeat(64)}/chunks/0`)).status, 404);
  assert.equal((await fetch(service.origin + `/updates/v1/artifacts/${hash(f.bytes)}/chunks/999`)).status, 404);
  fs.writeFileSync(f.store.artifactPath(hash(f.bytes)), Buffer.alloc(f.bytes.length));
  assert.equal((await fetch(service.origin + `/updates/v1/artifacts/${hash(f.bytes)}/chunks/0`)).status, 503);
});

test('worker stages verified artifacts without activation and persists a replay high-water mark', async t => {
  const f = await fixture(t), service = await localService(t, f.store), worker = localWorker(f, service.origin);
  t.after(() => worker.close());
  const state = await worker.checkAndStage();
  assert.equal(state.phase, 'staged'); assert.equal(state.activationSupported, false);
  assert.deepEqual(fs.readFileSync(worker.store.artifactPath(hash(f.bytes))), f.bytes);
  assert.equal(fs.existsSync(worker.store.lockFile), false);
  const reopened = localWorker(f, service.origin);
  t.after(() => reopened.close());
  assert.equal(reopened.store.state().channelHash, metadataHash(f.channel.payload));
  assert.equal((await reopened.checkAndStage()).phase, 'staged');
});

test('worker retries transient Grph HTTP connection resets without retrying authorization failures', async t => {
  const f = await fixture(t), service = await localService(t, f.store);
  let channelRequests = 0, chunkRequests = 0;
  const reset = () => new TypeError('fetch failed', { cause: Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' }) });
  const worker = localWorker(f, service.origin, { request: async (url, options) => {
    if (url.includes('/channels/') && ++channelRequests === 1) throw reset();
    if (url.endsWith('/chunks/0') && ++chunkRequests === 1) throw reset();
    return fetch(url, options);
  } });
  t.after(() => worker.close());
  assert.equal((await worker.checkAndStage()).phase, 'staged');
  assert.equal(channelRequests, 2); assert.equal(chunkRequests, 2);
  let denied = 0;
  const rejected = localWorker(f, service.origin, { directory: path.join(f.directory, 'denied'), request: async () => { denied++; return new Response('{}', { status: 404 }); } });
  t.after(() => rejected.close());
  await assert.rejects(rejected.checkAndStage(), /No configured/);
  assert.equal(denied, 1);
});

test('restarting a worker cannot replay an older signed channel after a later release was accepted', async t => {
  const f = await fixture(t), service = await localService(t, f.store);
  const first = localWorker(f, service.origin);
  await first.checkAndStage();
  await publishUpdate({ ...f.options, sequence: 2 });
  await first.checkAndStage();
  assert.equal(first.store.state().sequence, 2);
  await first.close();
  const restarted = localWorker(f, service.origin, { request: async (url, options) => url.includes('/channels/')
    ? new Response(JSON.stringify(f.channel)) : fetch(url, options) });
  t.after(() => restarted.close());
  await assert.rejects(restarted.checkAndStage(), /No configured/);
  assert.equal(restarted.store.state().sequence, 2);
});

test('a seed can distribute declared non-native architectures without exposing undeclared cache files', async t => {
  const f = await fixture(t);
  const other = Buffer.from('reviewed x64 build');
  fs.writeFileSync(path.join(f.directory, 'other.tar'), other);
  await publishUpdate({ ...f.options, sequence: 2, descriptor: { ...f.options.descriptor,
    artifacts: [...f.options.descriptor.artifacts, { file: 'other.tar', component: 'blockchain', role: 'all', os: 'linux', arch: 'x64' }] } });
  const service = await localService(t, f.store);
  const response = await fetch(service.origin + `/updates/v1/artifacts/${hash(other)}/chunks/0`);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), other);
});

test('interrupted transfer resumes verified chunks and falls back from a corrupt peer', async t => {
  const f = await fixture(t, profile({ seeds: [seedA, seedB] })), service = await localService(t, f.store);
  const first = localWorker(f, service.origin, { request: async (url, options) => {
    if (/\/chunks\/[12]$/.test(url)) throw new Error('disconnected');
    return fetch(url, options);
  } });
  await assert.rejects(first.checkAndStage(), /resumed/);
  assert.equal(fs.existsSync(first.store.chunkPath(hash(f.bytes), 0)), true);
  await first.close();
  const requested = [];
  const second = localWorker(f, service.origin, { request: async (url, options) => {
    requested.push(url);
    return fetch(url, options);
  } });
  t.after(() => second.close());
  assert.equal((await second.checkAndStage()).phase, 'staged');
  assert.equal(requested.some(url => url.endsWith('/chunks/0')), false);
  assert.deepEqual(fs.readFileSync(second.store.artifactPath(hash(f.bytes))), f.bytes);

  // Different loopback proxies represent two distinct Grph peers. The first
  // peer serves corrupt chunks; metadata and the second peer remain genuine.
  const alternate = service.origin.replace('127.0.0.1', 'localhost');
  let corruptAttempts = 0;
  const fallback = localWorker(f, service.origin, { directory: path.join(f.directory, 'fallback'),
    connect: async key => ({ origin: key === seedA ? 'http://127.0.0.1:1' : service.origin, async close() {} }),
    request: async (url, options) => {
      if (url.startsWith('http://127.0.0.1:1/')) {
        if (url.includes('/chunks/')) { corruptAttempts++; return new Response(Buffer.from('bad chunk')); }
        url = url.replace('http://127.0.0.1:1', service.origin);
      }
      return fetch(url, options);
    } });
  t.after(() => fallback.close());
  assert.equal((await fallback.checkAndStage()).phase, 'staged');
  assert.ok(corruptAttempts > 0);
  const direct = localWorker(f, alternate);
  await assert.rejects(direct.checkAndStage(), /No configured/);
  await direct.close();
});

test('worker bounds peer responses, rejects channel conflicts and refuses a concurrent writer', async t => {
  const f = await fixture(t, profile({ seeds: [seedA, seedB] })), service = await localService(t, f.store);
  const release = f.store.acquire();
  assert.throws(() => f.store.acquire(), /EEXIST/);
  release();
  const conflicting = signMetadata({ ...f.channel.payload, releaseHash: '1'.repeat(64) }, 'channel', channelKeys.privateKey);
  const worker = localWorker(f, service.origin, {
    connect: async key => ({ origin: key === seedA ? 'http://127.0.0.1:1' : service.origin, async close() {} }),
    request: async (url, options) => url.startsWith('http://127.0.0.1:1/') ? new Response(JSON.stringify(conflicting)) : fetch(url, options),
  });
  await assert.rejects(worker.checkAndStage(), /conflicting/);
  assert.equal(worker.store.state().sequence, undefined);
  await worker.close();
  const oversized = localWorker(f, service.origin, { request: async () => new Response(Buffer.alloc(2 * 1024 ** 2 + 1)) });
  await assert.rejects(oversized.checkAndStage(), /No configured/);
  await oversized.close();
});

test('insufficient cache quota leaves the release unstaged and retains verified chunks', async t => {
  const f = await fixture(t, profile({ maxCacheBytes: 1024 ** 2 })), service = await localService(t, f.store);
  const worker = localWorker(f, service.origin);
  t.after(() => worker.close());
  await assert.rejects(worker.checkAndStage(), /quota/);
  assert.equal(worker.store.state().phase, 'failed');
  assert.equal(fs.existsSync(worker.store.artifactPath(hash(f.bytes))), false);
  assert.equal(fs.existsSync(worker.store.chunkPath(hash(f.bytes), 0)), true);
});

test('local runtime adoption preserves signing files and cannot cross network boundaries', t => {
  const folder = temp(t), genesis = { chain_id: 'local', initial_height: '1' };
  const p = profile({ genesisHash: genesisHash(genesis) });
  const profileFile = path.join(folder, 'profile.json');
  fs.writeFileSync(profileFile, JSON.stringify(p));
  const signing = path.join(folder, 'priv_validator_state.json');
  fs.writeFileSync(signing, '{"height":"42","signature":"preserve"}');
  const before = fs.readFileSync(signing);
  const binding = bindLocalUpdates({ profileFile, folder, genesis, role: 'validator' });
  assert.deepEqual(fs.readFileSync(signing), before);
  const service = { environment: {}, volumes: ['db-data:/data'] };
  configureAgentUpdates(service, binding); configureAgentUpdates(service, binding);
  assert.equal(service.volumes.length, 3);
  assert.ok(service.volumes.includes('db-data:/data'));
  assert.equal(service.environment.GRAPHENE_UPDATE_DIRECTORY, '/app/update-state');
  assert.throws(() => bindLocalUpdates({ profileFile, folder, genesis: { chain_id: 'other' }, role: 'validator' }), /does not match/);
  assert.throws(() => bindLocalUpdates({ profileFile, folder, genesis, role: 'sentry' }), /does not match/);
  fs.writeFileSync(profileFile, JSON.stringify(profile({ environment: 'prod', channel: 'stable', genesisHash: genesisHash(genesis) })));
  assert.throws(() => bindLocalUpdates({ profileFile, folder, genesis, role: 'validator' }), /cannot provision/);
  assert.deepEqual(fs.readFileSync(signing), before);
});

test('launcher runtime rejects wrong-network update configuration before invoking Docker', async t => {
  const directory = temp(t), secrets = generateAll(), setup = publicNodeSetup('validator', secrets, 'update fixture');
  const wallet = '0x' + '1'.repeat(40), profileFile = path.join(directory, 'profile.json');
  fs.writeFileSync(profileFile, JSON.stringify(profile()));
  let commands = 0;
  const runtime = new LocalNodeRuntime({ directory, updateProfileFile: profileFile,
    run: async () => { commands++; assert.fail('Docker must not run for a mismatched update profile'); },
    read: async url => {
      if (url.includes('/validators/')) return { ...setup, wallet, registered: true, networkPublicKey: setup.consensusPublicKey };
      if (url.endsWith('/status')) return { result: { node_info: { network: 'local' } } };
      return { result: { genesis: { chain_id: 'local' } } };
    } });
  runtime.unlock({ setup, secrets });
  await assert.rejects(runtime.start(wallet), /does not match/);
  assert.equal(commands, 0);
});

test('agent staging is optional and a bad configuration never stops consensus', async t => {
  let constructed = 0;
  const disabled = await startAgentUpdates({ role: 'validator', env: {}, createWorker: () => { constructed++; } });
  assert.equal(disabled.enabled, false); assert.equal(constructed, 0); await disabled.close();
  const directory = temp(t), file = path.join(directory, 'profile.json'), messages = [];
  fs.writeFileSync(file, JSON.stringify(profile({ role: 'sentry' })));
  const wrongRole = await startAgentUpdates({ role: 'validator', env: { GRAPHENE_UPDATE_PROFILE: file }, log: m => messages.push(m) });
  assert.equal(wrongRole.enabled, false); assert.match(messages[0], /role/);
  let calls = 0, closed = 0;
  const enabled = await startAgentUpdates({ role: 'sentry', env: { GRAPHENE_UPDATE_PROFILE: file },
    createWorker: () => ({ store: { state: () => ({ phase: 'staged', activationSupported: false }) }, async checkAndStage() { calls++; }, async close() { closed++; } }) });
  assert.equal(enabled.enabled, true); assert.equal(calls, 1);
  assert.equal(enabled.status().phase, 'staged');
  await enabled.close(); assert.equal(closed, 1);
});

test('real Grph peers distribute a signed release using an isolated local DHT', { timeout: 30000 }, async t => {
  const reservation = dgram.createSocket('udp4');
  await new Promise(resolve => reservation.bind(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const dht = HyperDHT.bootstrapper(port, '127.0.0.1'); await dht.ready();
  let service, worker;
  t.after(async () => { await worker?.close(); await service?.close(); await dht.destroy(); });
  const f = await fixture(t, profile(), Buffer.from('verified update bytes over real Grph'));
  // Keep the test seed identity equal to the public key already pinned in the profile.
  fs.writeFileSync(path.join(f.store.directory, 'update-p2p.json'), JSON.stringify({ seed: 'a'.repeat(64) }));
  const bootstrap = [`127.0.0.1:${port}`];
  service = await serveUpdates(f.store, { bootstrap });
  assert.equal(service.key, seedA);
  worker = new UpdateWorker({ directory: path.join(f.directory, 'real-receiver'), profile: f.profile, bootstrap });
  assert.equal((await worker.checkAndStage()).phase, 'staged');
  assert.deepEqual(fs.readFileSync(worker.store.artifactPath(hash(f.bytes))), f.bytes);
});

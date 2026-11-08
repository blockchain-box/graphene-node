import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { LauncherCheckpoints } from './launcher-checkpoints.js';
import { createSetupServer } from './join-network.js';
import { NodeManager } from './node-manager.js';
import { checkpointFingerprint } from './checkpoint-trust.js';
import { tunnelPublicKey } from '../agents/lib/grph-tunnel.js';
import { signManifest } from './checkpoint-core.js';
import { enrollCheckpointHost } from './checkpoint-enroll.js';

const manifestURL = `grph://${tunnelPublicKey('a'.repeat(64))}/checkpoints/latest.json`;
const enrollmentURL = new URL('enrollment.json', manifestURL).href;
const source = { project: 'owned-sentry', agentAddress: '0x' + '1'.repeat(40), role: 'sentry', tm: 'owned-sentry-node-1', rpc: 'http://127.0.0.1:1234' };
function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-checkpoints-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = { trustFile: path.join(directory, 'receiver', 'trust.json'), publisherTrustFile: path.join(directory, 'publisher', 'trust.json'), keyFile: path.join(directory, 'publisher', 'key.pem'), output: path.join(directory, 'public'), creationAvailable: true, verifyRestore: async () => {}, ...overrides };
  if (config.create) {
    const create = config.create;
    config.create = async options => { const created = await create(options); fs.mkdirSync(path.join(config.output, created.manifest.id), { recursive: true }); return created; };
  }
  return { directory, config, service: new LauncherCheckpoints(config) };
}
function result(privateKey) {
  return { trust: { chainId: 9876, genesisHash: 'f'.repeat(64), publicKey: crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }), maxAgeHours: 24 }, manifest: { id: 'height-42-test', height: '42' }, stats: { reusedChunks: 3, createdChunks: 2 } };
}

test('creation requires confirmation, uses fixed host settings, serializes work and preserves receiver enrollment', async t => {
  let finish, received;
  const { config, service } = fixture(t, { create: async options => { received = options; options.progress('Verifying isolated restore…'); await new Promise(resolve => { finish = resolve; }); return result(options.privateKey); } });
  fs.mkdirSync(path.dirname(config.trustFile), { recursive: true });
  fs.writeFileSync(config.trustFile, 'existing receiver trust must stay unchanged');
  assert.throws(() => service.startCreation({ manifestURL }), /Confirm/);
  for (const extra of [{ output: '/tmp/other' }, { privateKey: 'browser key' }, { source: { tm: 'other-node' } }]) assert.throws(() => service.startCreation({ manifestURL, confirmExport: true, ...extra }), /Unsupported/);
  assert.equal(fs.existsSync(config.keyFile), false);
  assert.equal(service.startCreation({ manifestURL, confirmExport: true }, { source }).accepted, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.status().job.state, 'running');
  assert.match(service.status().job.phase, /Verifying/);
  assert.throws(() => service.startCreation({ manifestURL, confirmExport: true }, { source }), /current/);
  assert.equal(received.output, config.output);
  assert.equal(typeof received.verifyRestore, 'function');
  finish(); await service.task;
  assert.equal(service.status().job.state, 'succeeded');
  assert.equal(service.status().publisher.manifestURL, manifestURL);
  assert.equal(received.source.agentAddress, source.agentAddress);
  assert.equal(received.requireNonVoting, true);
  assert.equal(fs.readFileSync(config.trustFile, 'utf8'), 'existing receiver trust must stay unchanged');
  assert.equal(fs.statSync(config.keyFile).mode & 0o777, 0o600);
  const summary = JSON.stringify(service.status());
  assert.ok(!summary.includes('PRIVATE KEY')); assert.ok(!summary.includes(config.keyFile));
  assert.equal(service.status().job.result.fingerprint, checkpointFingerprint(crypto.createPublicKey(received.privateKey).export({ type: 'spki', format: 'pem' })));
});

test('enrollment installs on the selected host and cannot replace existing trust or accept browser filesystem settings', async t => {
  let received;
  const key = crypto.generateKeyPairSync('ed25519');
  const trust = { chainId: 9876, genesisHash: 'f'.repeat(64), publicKey: key.publicKey.export({ type: 'spki', format: 'pem' }), manifestURL, maxAgeHours: 24 };
  const { config, service } = fixture(t, { enroll: async options => { received = options; fs.mkdirSync(path.dirname(options.output), { recursive: true }); fs.writeFileSync(options.output, JSON.stringify(trust)); return trust; } });
  const body = { url: enrollmentURL, fingerprint: checkpointFingerprint(trust.publicKey), genesisHash: trust.genesisHash };
  assert.throws(() => service.startEnrollment({ ...body, output: '/tmp/other' }), /Unsupported/);
  assert.throws(() => service.startEnrollment({ ...body, url: 'https://example.com/checkpoints/enrollment.json' }), /P2P/);
  assert.throws(() => service.startEnrollment({ ...body, fingerprint: 'bad' }), /fingerprint/);
  assert.equal(service.startEnrollment(body).accepted, true); await service.task;
  assert.equal(received.output, config.trustFile);
  assert.equal(service.status().enrollment.fingerprint, body.fingerprint);
  assert.throws(() => service.startEnrollment(body), /already/);
  assert.equal(fs.existsSync(config.keyFile), false);
});

test('creation failure is reported without replacing publisher trust; operator kits can enroll but cannot export', async t => {
  const { config, service } = fixture(t, { create: async () => { throw new Error('isolated verification failed'); } });
  fs.mkdirSync(path.dirname(config.publisherTrustFile), { recursive: true });
  fs.writeFileSync(config.publisherTrustFile, 'preserved');
  service.startCreation({ manifestURL, confirmExport: true }, { source }); await service.task;
  assert.equal(service.status().job.state, 'failed');
  assert.match(service.status().job.error, /isolated verification failed/);
  assert.equal(fs.readFileSync(config.publisherTrustFile, 'utf8'), 'preserved');
  service.creationAvailable = false;
  assert.throws(() => service.startCreation({ manifestURL, confirmExport: true }), /full provider checkout/);
});

test('checkpoint manager endpoints require private launcher authentication and reject unconfirmed exports', async t => {
  const { directory, service } = fixture(t);
  const { server, token } = createSetupServer({ directory, checkpoints: service, p2p: { close: async () => {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(origin + '/manager/checkpoints')).status, 403);
  assert.equal((await fetch(origin + '/manager/checkpoints', { headers: { Authorization: 'Bearer ' + token } })).status, 200);
  const headers = { Origin: origin, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  assert.equal((await fetch(origin + '/manager/checkpoints/create', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: JSON.stringify({ manifestURL, confirmExport: true }) })).status, 403);
  assert.equal((await fetch(origin + '/manager/checkpoints/create', { method: 'POST', headers, body: JSON.stringify({ manifestURL }) })).status, 400);
  assert.equal(service.job, null);
  assert.equal((await fetch(origin + '/checkpoint-manager-ui.js')).status, 200);
});

test('remote checkpoint routes are narrowly forwarded and checkpoint jobs exclude overlapping node operations', async t => {
  const { directory, service } = fixture(t);
  const calls = [];
  const manager = new NodeManager({ directory, checkpoints: service, remoteFetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ accepted: true }) }; } });
  manager.remotes = [{ id: 'remote' }]; manager.remoteTokens.set('remote', 'private'); manager.remoteConnections.set('remote', { origin: 'http://127.0.0.1:1234' });
  await manager.proxy('remote', { route: '/checkpoints/enroll', method: 'POST', body: { url: enrollmentURL } });
  assert.equal(calls[0].url, 'http://127.0.0.1:1234/manager/checkpoints/enroll');
  await assert.rejects(manager.proxy('remote', { route: '/checkpoints/create', method: 'GET' }), /not supported/);
  await assert.rejects(manager.proxy('remote', { route: '/checkpoints/delete', method: 'POST' }), /not supported/);
  manager.operations.set('node', 'starting');
  await assert.rejects(manager.dispatch('/checkpoints/create', 'POST', { manifestURL, confirmExport: true }), /node operations/);
  manager.operations.clear(); service.job = { state: 'running' };
  await assert.rejects(manager.dispatch('/nodes', 'POST', {}), /checkpoint operation/);
  assert.equal((await manager.dispatch('/checkpoints', 'GET')).job.state, 'running');
});

test('launcher checkpoint forms target the selected host and creation requires an explicit pause confirmation', async () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', innerHTML: '', disabled: false, open: false, reset() {}, addEventListener() {}, showModal() { this.open = true; }, close() { this.open = false; } });
    return elements.get(id);
  };
  const calls = [];
  const context = vm.createContext({ $: element, escapeHtml: String, current: () => null, wallet: '0x' + '1'.repeat(40), hosts: [{ id: 'local', label: 'Local', connected: true }, { id: 'remote', label: 'Remote', connected: true }], filter: 'all', hostLabel: host => host, errorMessage: error => error.message, clearTimeout() {}, setTimeout() {}, confirmLauncherAction: async () => true, api: async (...args) => { calls.push(args); return { accepted: true, job: { state: 'running', phase: 'Checking…' } }; } });
  vm.runInContext(fs.readFileSync(new URL('./checkpoint-manager-ui.js', import.meta.url), 'utf8'), context);
  element('checkpoint-host').value = 'remote';
  element('checkpoint-enrollment-url').value = enrollmentURL;
  element('checkpoint-fingerprint').value = 'a'.repeat(64);
  element('checkpoint-genesis').value = 'f'.repeat(64);
  vm.runInContext("checkpointView={creationAvailable:true,enrollment:{state:'missing'},job:null}", context);
  await vm.runInContext("submitCheckpointAction('enroll')", context);
  assert.equal(calls[0][0], '/checkpoints/enroll'); assert.equal(calls[0][3], 'remote');
  element('checkpoint-publication-url').value = manifestURL;
  element('checkpoint-source-node').value = 'owned';
  vm.runInContext("checkpointView.job=null;checkpointWalletSources=[{nodeId:'owned',canCreate:true,name:'Owned sentry'}];confirmLauncherAction=async()=>false", context);
  await vm.runInContext("submitCheckpointAction('create')", context); assert.equal(calls.length, 1);
  vm.runInContext('confirmLauncherAction=async()=>true', context);
  await vm.runInContext("submitCheckpointAction('create')", context);
  assert.equal(calls[1][0], '/checkpoints/create'); assert.equal(calls[1][2].confirmExport, true); assert.equal(calls[1][3], 'remote');
  assert.equal(calls[1][2].sourceNodeId, 'owned');
  vm.runInContext('checkpointView.job=null;confirmLauncherAction=()=>new Promise(resolve=>globalThis.approve=resolve)', context);
  const pending = vm.runInContext("submitCheckpointAction('create')", context);
  await vm.runInContext("submitCheckpointAction('create')", context);
  assert.equal(calls.length, 2, 'Repeated creation cannot bypass the pending confirmation');
  element('checkpoint-host').value = 'local';
  vm.runInContext('approve(true)', context);
  await pending;
  assert.equal(calls.length, 2, 'Changing the target host invalidates an outstanding approval');
});

test('shared launcher exposes public enrollment so a joining validator can verify its checkpoint provider', async t => {
  const { directory, config, service } = fixture(t);
  const key = crypto.generateKeyPairSync('ed25519');
  const { server } = createSetupServer({ directory, checkpoints: service, checkpointDirectory: config.output, p2p: { close: async () => {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const trust = { chainId: 9876, genesisHash: 'f'.repeat(64), publicKey: key.publicKey.export({ type: 'spki', format: 'pem' }), maxAgeHours: 24, manifestURL: origin + '/checkpoints/latest.json', privateNote: 'NEVER EXPOSE EXTRA FIELDS' };
  fs.mkdirSync(path.dirname(config.publisherTrustFile), { recursive: true });
  fs.writeFileSync(config.publisherTrustFile, JSON.stringify(trust));
  fs.mkdirSync(config.output, { recursive: true });
  const manifest = { format: 1, kind: 'graphene-local-checkpoint', id: 'height-42-enroll', chainId: 9876, genesisHash: trust.genesisHash, height: '42', appHash: 'a'.repeat(64), blockHash: 'b'.repeat(64), createdAt: new Date().toISOString(), files: Object.fromEntries(['genesis.json', 'app-state.json', 'mpt.tar.gz', 'tendermint.tar.gz'].map(name => [name, { bytes: 10, sha256: 'c'.repeat(64) }])), verification: { caughtUp: true, height: 44, appHash: 'd'.repeat(64) } };
  fs.writeFileSync(path.join(config.output, 'latest.json'), JSON.stringify(signManifest(manifest, key.privateKey)));
  const response = await fetch(origin + '/checkpoints/enrollment.json');
  assert.equal(response.status, 200);
  const enrollment = await response.json();
  assert.equal(enrollment.privateNote, undefined);
  const installed = await enrollCheckpointHost({ url: origin + '/checkpoints/enrollment.json', fingerprint: checkpointFingerprint(trust.publicKey), genesisHash: trust.genesisHash, output: path.join(directory, 'joining-node', 'trust.json') });
  assert.equal(installed.manifestURL, trust.manifestURL);
});

test('blocked wallet sources remain selectable for inspection but cannot create checkpoints', async () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', innerHTML: '', disabled: false, addEventListener() {} });
    return elements.get(id);
  };
  const owner = '0x' + '1'.repeat(40);
  const reason = 'Choose an idle donor; this sentry is serving validators or assignments are unavailable.';
  const context = vm.createContext({ $: element, escapeHtml: String, wallet: owner, api: async () => ({ nodes: [{ nodeId: 'sentry', name: 'My sentry', role: 'sentry', state: 'syncing', canCreate: false, reason }, { nodeId: null, name: 'Remote node', role: 'validator', state: 'locked', canCreate: false, reason: 'Connect the original node host.' }] }) });
  vm.runInContext(fs.readFileSync(new URL('./checkpoint-manager-ui.js', import.meta.url), 'utf8'), context);
  vm.runInContext("checkpointView={creationAvailable:true,enrollment:{state:'missing'}}", context);
  await vm.runInContext('loadCheckpointWalletSources()', context);
  assert.doesNotMatch(element('checkpoint-source-node').innerHTML, /<option[^>]*value="sentry"[^>]*disabled/);
  element('checkpoint-source-node').value = 'sentry';
  vm.runInContext('renderCheckpointControls()', context);
  assert.equal(element('checkpoint-create-submit').disabled, true);
  assert.match(element('checkpoint-source-help').textContent, /serving validators/);
  await vm.runInContext('loadCheckpointWalletSources()', context);
  assert.equal(element('checkpoint-source-node').value, 'sentry', 'Refreshing retains the inspected source');
  element('checkpoint-source-node').value = 'unlinked-1';
  vm.runInContext('renderCheckpointControls()', context);
  assert.match(element('checkpoint-source-help').textContent, /Connect the original node host/);
  assert.equal(element('checkpoint-create-submit').disabled, true);
});

test('serving-sentry publication requires its own interruption acknowledgment', async t => {
  const { service } = fixture(t, { create: async options => result(options.privateKey) });
  const servingSource = { ...source, activeValidatorCount: 1 };
  for (const confirmServing of [undefined, false, 'true']) {
    assert.throws(() => service.startCreation({ manifestURL, confirmExport: true, confirmServing }, { source: servingSource }), /Confirm.*interruption/i);
  }
  assert.equal(service.startCreation({ manifestURL, confirmExport: true, confirmServing: true }, { source: servingSource }).accepted, true);
  await service.task;
  assert.equal(service.job.state, 'succeeded', service.job.error);
});

test('serving-sentry UI warns about validator interruption and sends consent only after approval', async () => {
  const elements = new Map(), calls = [], warnings = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', innerHTML: '', disabled: false, addEventListener() {} });
    return elements.get(id);
  };
  const context = vm.createContext({ $: element, wallet: '0x' + '1'.repeat(40), hostLabel: () => 'Local host', errorMessage: error => error.message, confirmLauncherAction: async (message, options) => { warnings.push({ message, options }); return false; }, api: async (...args) => { calls.push(args); return { job: { state: 'running' } }; } });
  vm.runInContext(fs.readFileSync(new URL('./checkpoint-manager-ui.js', import.meta.url), 'utf8'), context);
  element('checkpoint-source-node').value = 'serving'; element('checkpoint-publication-url').value = manifestURL;
  vm.runInContext("checkpointView={creationAvailable:true,enrollment:{state:'missing'}};checkpointWalletSources=[{nodeId:'serving',name:'Serving sentry',canCreate:true,interruptionRequired:true,activeValidatorCount:1}]", context);
  vm.runInContext('renderCheckpointControls()', context);
  assert.equal(element('checkpoint-create-submit').disabled, false);
  assert.match(element('checkpoint-source-help').textContent, /interrupts 1 active validator/);
  await vm.runInContext("submitCheckpointAction('create')", context);
  assert.equal(calls.length, 0);
  assert.match(warnings[0].message, /Connected validators may lose network access and miss votes/);
  assert.equal(warnings[0].options.danger, true);
  vm.runInContext('confirmLauncherAction=async()=>true', context);
  await vm.runInContext("submitCheckpointAction('create')", context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].confirmServing, true);
});

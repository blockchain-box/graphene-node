import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { NodeManager } from './node-manager.js';
import { LauncherCheckpoints } from './launcher-checkpoints.js';
import { LocalNodeRuntime } from './local-node-runtime.js';
import { signManifest, verifyManifest } from './checkpoint-core.js';
import { tunnelPublicKey } from '../agents/lib/grph-tunnel.js';

const wallet = '0x' + '1'.repeat(40), agent = '0x' + '2'.repeat(40);
const manifestURL = `grph://${tunnelPublicKey('a'.repeat(64))}/checkpoints/latest.json`;
function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-selection-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const service = new LauncherCheckpoints({ trustFile: path.join(directory, 'trust.json'), publisherTrustFile: path.join(directory, 'publisher.json'), output: path.join(directory, 'public'), keyFile: path.join(directory, 'publisher.pem'), creationAvailable: true, verifyRestore: async () => {}, ...overrides });
  const registration = { operator: wallet, sentryId: agent, active: true, name: 'Owned sentry' };
  const manager = new NodeManager({ directory, checkpoints: service, p2p: {}, readChain: async route => route.startsWith('/graphene/state/platform/sentries') ? [registration] : route.startsWith('/graphene/state/platform/assignments') ? [] : { registered: false } });
  const node = { id: 'owned-sentry', role: 'sentry', name: 'Owned sentry', setup: { role: 'sentry', agentAddress: agent } };
  manager.nodes = [node];
  return { directory, service, manager, node };
}
function publicManifest(source) {
  return { format: 1, kind: 'graphene-local-checkpoint', id: 'height-42-source', chainId: 9876, genesisHash: 'f'.repeat(64), height: '42', appHash: 'a'.repeat(64), blockHash: 'b'.repeat(64), createdAt: new Date().toISOString(), source: { agentAddress: source.agentAddress, role: source.role }, files: Object.fromEntries(['genesis.json', 'app-state.json', 'mpt.tar.gz', 'tendermint.tar.gz'].map(name => [name, { bytes: 10, sha256: 'c'.repeat(64) }])), verification: { caughtUp: true, height: 44, appHash: 'd'.repeat(64) } };
}

test('wallet donor selection verifies ownership and uses the selected managed source without falling back to bootstrap', async t => {
  let captured;
  const { manager, service, node } = fixture(t, { create: async options => {
    captured = options;
    const manifest = publicManifest(options.source);
    fs.mkdirSync(path.join(options.output, manifest.id), { recursive: true });
    fs.writeFileSync(path.join(options.output, manifest.id, 'manifest.json'), JSON.stringify(signManifest(manifest, options.privateKey)));
    return { manifest, trust: { chainId: 9876, genesisHash: manifest.genesisHash, publicKey: crypto.createPublicKey(options.privateKey).export({ type: 'spki', format: 'pem' }), maxAgeHours: 24 } };
  } });
  const source = { project: 'owned-stack', agentAddress: agent, role: 'sentry', tm: 'owned-stack-node-1', rpc: 'http://127.0.0.1:1234' };
  manager.unlocked.set(node.id, { status: async () => ({ state: 'running', votingPower: '0' }), checkpointSource: async () => source });
  const choices = await manager.checkpointSources(wallet);
  assert.equal(choices.nodes[0].canCreate, true);
  await assert.rejects(manager.dispatch('/checkpoints/create', 'POST', { wallet: '0x' + '3'.repeat(40), sourceNodeId: node.id, manifestURL, confirmExport: true }), /does not own/);
  assert.equal(captured, undefined);
  await assert.rejects(manager.dispatch('/checkpoints/create', 'POST', { wallet, manifestURL, confirmExport: true }), /Choose a node/);
  const response = await manager.dispatch('/checkpoints/create', 'POST', { wallet, sourceNodeId: node.id, manifestURL, confirmExport: true });
  assert.equal(response.accepted, true); await service.task;
  assert.equal(service.job.state, 'succeeded', service.job.error);
  assert.equal(captured.source.tm, 'owned-stack-node-1');
  assert.equal(captured.requireNonVoting, true);
  const publication = service.nodePublication(agent);
  assert.equal(publication.height, '42');
  assert.match(publication.manifestURL, /\/height-42-source\/manifest\.json$/);
  assert.ok(fs.existsSync(path.join(service.output, 'height-42-source/enrollment.json')));
  assert.equal(fs.existsSync(service.trustFile), false, 'creation cannot change receiver enrollment');
});

test('voting and unsynchronized nodes cannot be used as donors', async t => {
  const { directory, manager, node } = fixture(t);
  const runtime = new LocalNodeRuntime({ directory });
  runtime.identity = { setup: node.setup }; runtime.operation = false;
  runtime.compose = async () => { throw new Error('Docker must not be called for an ineligible source'); };
  runtime.status = async () => ({ state: 'running', votingPower: '10' });
  manager.unlocked.set(node.id, runtime);
  assert.equal((await manager.checkpointSources(wallet)).nodes[0].canCreate, false);
  await assert.rejects(runtime.checkpointSource(), /nonvoting source|nonvoting source node|nonvoting source|nonvoting/);
  runtime.status = async () => ({ state: 'syncing', votingPower: '0' });
  await assert.rejects(runtime.checkpointSource(), /synchronized/);
  assert.equal((await manager.checkpointSources(wallet)).nodes[0].canCreate, false);
  runtime.status = async () => ({ state: 'running', votingPower: '0' });
  runtime.read = async () => [{ sentryId: agent, status: 'Active' }];
  await assert.rejects(runtime.checkpointSource(), /Confirm.*interrupt/i);
});

test('first startup and recovery require an approved selection, while ordinary restart resumes saved data', async t => {
  const { service, manager, node } = fixture(t);
  const key = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(service.trustFile, JSON.stringify({ chainId: 9876, genesisHash: 'f'.repeat(64), publicKey: key.publicKey.export({ type: 'spki', format: 'pem' }), manifestURL, maxAgeHours: 24 }));
  const starts = [];
  const runtime = { requiresCheckpoint: () => true, status: async () => ({ state: 'stopped' }), start: async (...args) => { starts.push(args); } };
  manager.unlocked.set(node.id, runtime);
  await assert.rejects(manager.act(node, 'start', wallet), /Choose a checkpoint source/);
  await assert.rejects(manager.act(node, 'start', wallet, '../../keys'), /enrolled checkpoint source/);
  assert.equal(starts.length, 0);
  await manager.act(node, 'start', wallet, 'default'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts[0][1].checkpointTrustFile, service.trustFile);
  runtime.requiresCheckpoint = () => false;
  await manager.act(node, 'start', wallet); await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts[1].length, 1, 'ordinary restart does not select or restore a checkpoint');
  await assert.rejects(manager.act(node, 'reset', wallet), /Choose a checkpoint source/);
  await manager.act(node, 'reset', wallet, 'default'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts[2][1].resetCheckpoint, true);
  assert.equal(starts[2][1].checkpointTrustFile, service.trustFile);
});

test('wallet checkpoint approval pins a separate source and verifies signed source provenance', async t => {
  let received;
  const key = crypto.generateKeyPairSync('ed25519');
  const { service } = fixture(t, { enroll: async options => {
    received = options;
    const manifest = publicManifest({ agentAddress: agent, role: 'sentry' });
    options.onVerified(manifest);
    const trust = { chainId: 9876, genesisHash: manifest.genesisHash, publicKey: key.publicKey.export({ type: 'spki', format: 'pem' }), manifestURL: new URL('manifest.json', options.url).href, maxAgeHours: 24 };
    fs.mkdirSync(path.dirname(options.output), { recursive: true }); fs.writeFileSync(options.output, JSON.stringify(trust)); return trust;
  } });
  const choice = { url: new URL('height-42-source/enrollment.json', manifestURL).href, fingerprint: 'a'.repeat(64), genesisHash: 'f'.repeat(64), sourceAgentAddress: agent, sourceName: 'Owned sentry' };
  assert.throws(() => service.startProviderEnrollment({ ...choice, trustFile: '/tmp/other' }), /Unsupported/);
  service.startProviderEnrollment(choice); await service.task;
  assert.equal(service.job.state, 'succeeded', service.job.error);
  assert.equal(received.expectedSource, agent);
  assert.equal(fs.existsSync(service.trustFile), false);
  const providerId = service.job.result.providerId;
  assert.equal(service.providerChoices()[0].checkpoint.height, '42');
  assert.match(service.providerFile(providerId), /providers/);
  const stored = JSON.parse(fs.readFileSync(service.providerFile(providerId)));
  const changed = publicManifest({ agentAddress: '0x' + '4'.repeat(40), role: 'sentry' });
  assert.throws(() => verifyManifest(signManifest(changed, key.privateKey), stored), /selected wallet node/);
});

function chooserContext(api) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', innerHTML: '', disabled: false, open: false, addEventListener() {}, showModal() { this.open = true; }, close() { this.open = false; } });
    return elements.get(id);
  };
  const context = vm.createContext({ $: element, escapeHtml: String, wallet, hosts: [{ id: 'source', label: 'Source host', connected: true }, { id: 'target', label: 'Target host', connected: true }], api, hostLabel: id => id, errorMessage: error => error.message, clearTimeout, setTimeout, Date });
  vm.runInContext(fs.readFileSync(new URL('./checkpoint-manager-ui.js', import.meta.url), 'utf8'), context);
  return { context, element };
}

test('source dialog appears for first start and recovery, supports cancel, and is skipped for an ordinary restart', async () => {
  let fresh = false;
  const { context, element } = chooserContext(async route => route.includes('checkpoint-options') ? { requiresCheckpoint: fresh, providers: [{ id: 'default', label: 'Trusted provider' }] } : { nodes: [] });
  vm.runInContext("globalThis.node={id:'target-node',hostId:'target',name:'Target node'}", context);
  assert.equal(await vm.runInContext("chooseNodeCheckpoint(node,'start')", context), undefined);
  assert.equal(element('checkpoint-select-dialog').open, false);
  fresh = true;
  const first = vm.runInContext("chooseNodeCheckpoint(node,'start')", context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('checkpoint-select-dialog').open, true);
  assert.equal(element('checkpoint-select-submit').disabled, true, 'there is no implicit source selection');
  element('checkpoint-select-source').value = 'provider:default';
  await vm.runInContext('confirmCheckpointChoice()', context);
  assert.equal(await first, 'default');
  fresh = false;
  const recovery = vm.runInContext("chooseNodeCheckpoint(node,'reset')", context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('checkpoint-select-dialog').open, true);
  vm.runInContext('cancelCheckpointChoice()', context);
  assert.equal(await recovery, null);
});

test('selecting a wallet node approves its checkpoint on the target host before returning its provider ID', async () => {
  const calls = [];
  const { context, element } = chooserContext(async (route, method, body, host) => {
    calls.push({ route, method, body, host });
    if (route.includes('checkpoint-options')) return { requiresCheckpoint: true, providers: [] };
    if (route.includes('/sources/')) return { nodes: host === 'source' ? [{ name: 'Owned sentry', role: 'sentry', agentAddress: agent, checkpoint: { id: 'height-42-source', height: '42', createdAt: new Date().toISOString(), enrollmentURL: new URL('height-42-source/enrollment.json', manifestURL).href, fingerprint: 'a'.repeat(64), genesisHash: 'f'.repeat(64) } }] : [] };
    if (route === '/checkpoints/enroll-provider') return { accepted: true, job: { id: 'approval' } };
    return { job: { id: 'approval', state: 'succeeded', result: { providerId: 'approved-source' } } };
  });
  vm.runInContext("globalThis.node={id:'target-node',hostId:'target',name:'Target node'}", context);
  const selection = vm.runInContext("chooseNodeCheckpoint(node,'start')", context);
  await new Promise(resolve => setImmediate(resolve));
  element('checkpoint-select-source').value = 'node:source:' + agent;
  await vm.runInContext('confirmCheckpointChoice()', context);
  assert.equal(await selection, 'approved-source');
  const approved = calls.find(call => call.route === '/checkpoints/enroll-provider');
  assert.equal(approved.host, 'target'); assert.equal(approved.body.sourceAgentAddress, agent);
});

test('serving sentry is eligible with a visible interruption warning; unknown assignments stay blocked', async t => {
  const { manager, node } = fixture(t);
  const readChain = manager.readChain;
  let assignments = [{ sentryId: agent, status: 'Active' }];
  manager.readChain = route => route.includes('/assignments') ? Promise.resolve(assignments) : readChain(route);
  manager.unlocked.set(node.id, { status: async () => ({ state: 'running', votingPower: '0' }) });
  let [source] = (await manager.checkpointSources(wallet)).nodes;
  assert.equal(source.canCreate, true);
  assert.equal(source.interruptionRequired, true);
  assert.equal(source.activeValidatorCount, 1);
  assignments = {};
  [source] = (await manager.checkpointSources(wallet)).nodes;
  assert.equal(source.canCreate, false);
  assert.match(source.reason, /assignments.*verif/i);
});

test('serving sentry capture requires explicit interruption consent and still checks network and voting power', async t => {
  const { directory, node } = fixture(t);
  const runtime = new LocalNodeRuntime({ directory });
  runtime.identity = { setup: node.setup }; runtime.operation = false; runtime.project = 'owned-stack';
  let assignments = [{ sentryId: agent, status: 'Active' }];
  const genesis = { chain_id: 'checkpoint-test', validators: [] };
  runtime.status = async () => ({ state: 'running', votingPower: '0' });
  runtime.read = async route => route.includes('/assignments') ? assignments : { result: { genesis } };
  runtime.compose = async () => '127.0.0.1:1234';
  let votingPower = '0';
  t.mock.method(globalThis, 'fetch', async url => ({ ok: true, json: async () => String(url).endsWith('/status') ? { result: { sync_info: { catching_up: false }, validator_info: { voting_power: votingPower } } } : { result: { genesis } } }));
  await assert.rejects(runtime.checkpointSource(), /Confirm.*interrupt/i);
  const source = await runtime.checkpointSource({ confirmServing: true });
  assert.equal(source.activeValidatorCount, 1);
  assert.equal(source.agentAddress, agent);
  votingPower = '10';
  await assert.rejects(runtime.checkpointSource({ confirmServing: true }), /voting/i);
  votingPower = '0'; assignments = {};
  await assert.rejects(runtime.checkpointSource({ confirmServing: true }), /assignments.*verif/i);
});

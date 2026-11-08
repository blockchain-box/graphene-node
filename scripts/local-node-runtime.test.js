import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateAll } from '../agents/validator-agent/src/keygen.js';
import { publicNodeSetup } from '../agents/lib/node-setup.js';
import { installIdentity, verifyRegistration, composeDefinition, configureMptAuth, LocalNodeRuntime, bootstrapNetwork } from './local-node-runtime.js';

test('validator and sentry profiles share a retained MPT token across regeneration and migration', () => {
  for (const role of ['validator', 'sentry']) {
    const profile = composeDefinition('/private/node', 'id@bootstrap:26656', 'local', { role });
    const token = profile.services.mpt.environment.MPT_DB_API_TOKEN;
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.equal(profile.services.abci.environment.MPT_DB_API_TOKEN, token);
    configureMptAuth(profile);
    assert.equal(profile.services.mpt.environment.MPT_DB_API_TOKEN, token);
    delete profile.services.abci.environment.MPT_DB_API_TOKEN;
    configureMptAuth(profile);
    assert.equal(profile.services.abci.environment.MPT_DB_API_TOKEN, token);
    delete profile.services.abci.environment.MPT_DB_API_TOKEN;
    delete profile.services.mpt.environment.MPT_DB_API_TOKEN;
    configureMptAuth(profile);
    const migrated = profile.services.mpt.environment.MPT_DB_API_TOKEN;
    assert.match(migrated, /^[a-f0-9]{64}$/);
    assert.equal(profile.services.abci.environment.MPT_DB_API_TOKEN, migrated);
    configureMptAuth(profile);
    assert.equal(profile.services.mpt.environment.MPT_DB_API_TOKEN, migrated);
  }
});

test('identity installation never replaces a consensus key, genesis, or signing state on restart', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grph-runtime-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const secrets = generateAll();
  const genesis = { chain_id: 'local' };
  installIdentity(home, secrets, genesis);
  const state = path.join(home, 'data/priv_validator_state.json');
  fs.writeFileSync(state, '{"height":"42","round":1,"step":3}');
  installIdentity(home, secrets, genesis);
  assert.equal(JSON.parse(fs.readFileSync(state)).height, '42');
  assert.throws(() => installIdentity(home, generateAll(), genesis), /preserved/);
  assert.throws(() => installIdentity(home, secrets, { chain_id: 'other-chain' }), /preserved/);
  assert.equal(fs.statSync(path.join(home, 'config/priv_validator_key.json')).mode & 0o777, 0o600);
});

test('runtime rejects a different wallet or consensus identity before executing Docker', async (t) => {
  const secrets = generateAll();
  const setup = publicNodeSetup('validator', secrets, 'test');
  const record = { ...setup, wallet: '0x' + '1'.repeat(40), registered: true, networkPublicKey: setup.consensusPublicKey };
  verifyRegistration(record, setup, record.wallet);
  assert.throws(() => verifyRegistration(record, setup, '0x' + '2'.repeat(40)), /does not match/);
  assert.throws(() => verifyRegistration({ ...record, networkPublicKey: 'wrong' }, setup, record.wallet), /does not match/);
  let commands = 0;
  const runtime = new LocalNodeRuntime({ directory: os.tmpdir(), run: async () => { commands++; }, read: async () => record });
  runtime.unlock({ setup, secrets });
  await assert.rejects(runtime.start('0x' + '2'.repeat(40)), /does not match/);
  assert.equal(commands, 0);
  assert.equal((await runtime.status()).state, 'error');
});

test('local profile exposes only loopback P2P/RPC and has separate persistent chain data', () => {
  const compose = composeDefinition('/private/node', 'id@tendermint-dev:26656', 'graphene-local_graphene-net-dev');
  assert.deepEqual(compose.services.node.ports, ['127.0.0.1::26657', '127.0.0.1::26656']);
  assert.equal(compose.services.abci.ports, undefined);
  assert.equal(compose.services.db.ports, undefined);
  assert.equal(compose.services.node.environment, undefined);
  assert.equal(compose.services.node.volumes[0], '/private/node:/tendermint');
  assert.ok(compose.volumes.postgres);
  assert.ok(compose.services.node.command.includes('tcp://private-abci-1:26658'));
  assert.equal(compose.services.abci.environment.MPT_DB_HOST, 'private-mpt-1');
});

test('sentry runtime verifies operator and registered endpoint and isolates tunnel listeners', async () => {
  const { verifySentryRegistration } = await import('./local-node-runtime.js');
  const secrets = generateAll();
  const setup = publicNodeSetup('sentry', secrets, 'sentry', { host: 'sentry.local', port: 26656 });
  const wallet = '0x' + '1'.repeat(40);
  const record = { active: true, operator: wallet, sentryId: setup.agentAddress, tendermintNodeId: setup.nodeId, encryptionPublicKey: setup.encryptionPublicKey, p2pHost: setup.p2pHost, p2pPort: setup.p2pPort };
  verifySentryRegistration(record, setup, wallet);
  assert.throws(() => verifySentryRegistration(record, setup, '0x' + '2'.repeat(40)), /registered sentry/);
  assert.throws(() => verifySentryRegistration({ ...record, tendermintNodeId: 'ab'.repeat(20) }, setup, wallet), /registered sentry/);
  const compose = composeDefinition('/private/node', 'id@bootstrap:26656', 'local', { role: 'sentry', secretsPath: '/private/encrypted-store', p2pPort: 26656 });
  assert.equal(compose.services.agent.environment.PEER_HOST, 'private-agent-1');
  assert.equal(compose.services.agent.environment.TENDERMINT_RPC_URL, 'http://private-node-1:26657');
  assert.deepEqual(compose.services.agent.ports, ['127.0.0.1::3001']);
  assert.ok(compose.services.node.command.includes('--rpc.unsafe=true'));
  assert.ok(!JSON.stringify(compose).includes('/var/run/docker.sock'));
  assert.equal(compose.services.agent.environment.KEYSTORE_PASSPHRASE, '${GRAPHENE_NODE_PASSWORD:-}');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grph-sentry-identity-'));
  try {
    installIdentity(home, secrets, { chain_id: 'local' }, 'sentry');
    assert.equal(fs.existsSync(path.join(home, 'config/priv_validator_key.json')), false, 'Sentry must not copy a validator signing identity');
    assert.ok(fs.existsSync(path.join(home, 'config/node_key.json')));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('validator agent is a persistent Docker service, independent of the launcher process', () => {
  const compose = composeDefinition('/private/node', 'id@bootstrap:26656', 'local', { role: 'validator', secretsPath: '/private/keystore.enc' });
  assert.ok(compose.services.agent, 'Closing the setup server must not remove the DHT server');
  assert.equal(compose.services.agent.environment.AGENT_HOST, 'private-node-1');
  assert.equal(compose.services.agent.environment.MANAGE_TENDERMINT, 'false');
  assert.equal(compose.services.agent.environment.KEYSTORE_PASSPHRASE, '${GRAPHENE_NODE_PASSWORD:-}');
  assert.ok(compose.services.agent.volumes.includes('/private/keystore.enc:/app/secrets/keystore.enc:ro'));
});

test('runtime accepts the existing development stack under its actual Compose project name', async () => {
  const secrets = generateAll();
  const setup = publicNodeSetup('validator', secrets, 'test');
  const wallet = '0x' + '1'.repeat(40);
  const record = { ...setup, wallet, registered: true, networkPublicKey: setup.consensusPublicKey };
  const runtime = new LocalNodeRuntime({ directory: os.tmpdir(), read: async (url) => {
    if (url.includes('/validators/')) return record;
    if (url.endsWith('/status')) return { result: { node_info: { network: 'local' } } };
    return { result: { genesis: { chain_id: 'local' } } };
  }, run: async (args) => {
    if (args[0] === 'inspect') return JSON.stringify([{ State: { Running: true }, Config: { Labels: {
      'com.docker.compose.project': 'graphene-quarkus', 'com.docker.compose.service': 'tendermint',
    } }, NetworkSettings: { Networks: { 'graphene-quarkus_graphene-net-dev': {} } } }]);
    if (args[0] === 'network') return JSON.stringify([{ Name: args[2], Labels: {
      'com.docker.compose.project': 'graphene-quarkus', 'com.docker.compose.network': 'graphene-net-dev',
    } }]);
    if (args[0] === 'image') throw new Error('REACHED_IMAGE_CHECK');
    throw new Error(`Unexpected command: ${args[0]}`);
  } });
  runtime.unlock({ setup, secrets });
  await assert.rejects(runtime.start(wallet), /REACHED_IMAGE_CHECK/);
});


test('bootstrap discovery verifies network ownership rather than accepting arbitrary attachments', async () => {
  const container = { State: { Running: true }, Config: { Labels: {
    'com.docker.compose.project': 'graphene-quarkus', 'com.docker.compose.service': 'tendermint',
  } }, NetworkSettings: { Networks: { shared: {}, actual: {} } } };
  const run = async (args) => JSON.stringify([{ Name: args[2], Labels: {
    'com.docker.compose.project': args[2] === 'actual' ? 'graphene-quarkus' : 'other',
    'com.docker.compose.network': 'graphene-net-dev',
  } }]);
  assert.equal(await bootstrapNetwork(container, run), 'actual');
  await assert.rejects(bootstrapNetwork({ ...container, State: { Running: false } }, run), /running Compose/);
  await assert.rejects(bootstrapNetwork({ ...container, NetworkSettings: { Networks: { shared: {} } } }, run), /found 0/);
  const duplicate = async (args) => JSON.stringify([{ Name: args[2], Labels: {
    'com.docker.compose.project': 'graphene-quarkus', 'com.docker.compose.network': 'graphene-net-dev',
  } }]);
  await assert.rejects(bootstrapNetwork(container, duplicate), /found 2/);
});

test('fresh startup rejects a checkpoint for a different genesis before downloading or starting services', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'graphene-genesis-pin-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'tendermint');
  installIdentity(home, generateAll(), { chain_id: 'current-chain' });
  const trustFile = path.join(directory, 'trust.json');
  fs.writeFileSync(trustFile, JSON.stringify({ genesisHash: 'f'.repeat(64), manifestURL: 'http://127.0.0.1:1/no-download' }));
  const runtime = new LocalNodeRuntime({ directory, checkpointTrustFile: trustFile,
    run: async () => assert.fail('Must not mutate Docker before detecting the wrong genesis') });
  runtime.folder = directory;
  await assert.rejects(runtime.bootstrapCheckpoint(home), /does not match the running chain genesis/);
  assert.equal(fs.existsSync(path.join(directory, 'checkpoint-cache')), false);
});

test('a reopened deployment with unavailable Docker is not reported as stopped', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'grph-unknown-status-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const secrets = generateAll(), setup = publicNodeSetup('validator', secrets, 'Saved node');
  const runtime = new LocalNodeRuntime({ directory, run: async () => { throw new Error('Docker unavailable'); } });
  runtime.unlock({ setup, secrets, passphrase: 'test-only-password', keystorePath: path.join(directory, 'keystore.enc') });
  fs.mkdirSync(runtime.folder, { recursive: true }); fs.writeFileSync(runtime.file, '{}');
  assert.equal((await runtime.status()).state, 'unavailable');
  runtime.run = async () => '';
  await runtime.stop();
  assert.equal((await runtime.status()).state, 'stopped');
});

test('a saved Compose profile with no node container is stopped and can be started', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'grph-not-created-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const runtime = new LocalNodeRuntime({ directory, run: async (args) => {
    calls.push(args);
    if (args[0] === 'compose') throw new Error('service "node" is not running');
    if (args[0] === 'ps') return '';
    assert.fail('Unexpected Docker command');
  } });
  runtime.unlock({ setup: publicNodeSetup('validator', generateAll(), 'Not started') });
  fs.mkdirSync(runtime.folder, { recursive: true }); fs.writeFileSync(runtime.file, '{}');
  assert.equal((await runtime.status()).state, 'stopped');
  assert.ok(calls.some(args => args[0] === 'ps' && args.includes(`label=com.docker.compose.project=${runtime.project}`)));
});

test('missing RPC distinguishes exited nodes from running or restarting containers', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'grph-container-status-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let containerState;
  const runtime = new LocalNodeRuntime({ directory, run: async (args) => {
    if (args[0] === 'compose') return '';
    if (args[0] === 'ps') return 'container-id';
    if (args[0] === 'inspect') return JSON.stringify([{ State: containerState }]);
    assert.fail('Unexpected Docker command');
  } });
  runtime.unlock({ setup: publicNodeSetup('validator', generateAll(), 'Saved node') });
  fs.mkdirSync(runtime.folder, { recursive: true }); fs.writeFileSync(runtime.file, '{}');
  for (const [state, expected] of [
    [{ Running: false, Restarting: false }, 'stopped'],
    [{ Running: true }, 'unavailable'],
    [{ Running: false, Restarting: true }, 'unavailable'],
    [{ Running: false, Paused: true }, 'unavailable'],
  ]) {
    containerState = state;
    assert.equal((await runtime.status()).state, expected, JSON.stringify(state));
  }
  containerState = { Running: false };
  runtime.state = 'error'; runtime.error = 'Checkpoint setup failed';
  assert.equal((await runtime.status()).state, 'error');
  assert.equal((await runtime.status()).error, 'Checkpoint setup failed');
});

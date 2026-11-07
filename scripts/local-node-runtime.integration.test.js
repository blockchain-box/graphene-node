import { test } from 'node:test';
import dgram from 'node:dgram';
import HyperDHT from 'hyperdht';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalNodeRuntime, composeDefinition, bootstrapNetwork } from './local-node-runtime.js';
import { generateAll } from '../agents/validator-agent/src/keygen.js';
import { encryptSecrets } from '../agents/lib/keystore.js';
import { publicNodeSetup } from '../agents/lib/node-setup.js';

// Explicit opt-in: uses only newly generated test keys, containers and volumes.
// The registration lookup is a fixture; the chain and peer synchronization are real.
test('Docker launcher bootstrap, agent startup, stop and restart preserve signing state', { skip: process.env.GRAPHENE_DOCKER_TEST !== '1', timeout: 240000 }, async (t) => {
  const reservation = dgram.createSocket('udp4');
  await new Promise(resolve => reservation.bind(0, '0.0.0.0', resolve));
  const dhtPort = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const dhtHost = Object.values(os.networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address;
  assert.ok(dhtHost, 'A host IPv4 interface is required for the isolated Docker DHT test');
  const rendezvous = HyperDHT.bootstrapper(dhtPort, dhtHost); await rendezvous.ready();
  const previousDht = process.env.GRAPHENE_DHT_BOOTSTRAP;
  process.env.GRAPHENE_DHT_BOOTSTRAP = dhtHost + ':' + dhtPort;
  t.after(async () => { if (previousDht === undefined) delete process.env.GRAPHENE_DHT_BOOTSTRAP; else process.env.GRAPHENE_DHT_BOOTSTRAP = previousDht; await rendezvous.destroy(); });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'graphene-launch-integration-'));
  const secrets = generateAll();
  const setup = publicNodeSetup('validator', secrets, 'launcher-integration');
  const wallet = '0x' + '1'.repeat(40);
  const passphrase = 'temporary integration password';
  const keystorePath = path.join(directory, 'keystore.enc');
  fs.writeFileSync(keystorePath, encryptSecrets(secrets, passphrase), { mode: 0o600 });
  const runtime = new LocalNodeRuntime({ directory, read: async (url) => {
    if (url.includes('/validators/')) return { ...setup, wallet, registered: true, networkPublicKey: setup.consensusPublicKey };
    return (await fetch(url)).json();
  } });
  runtime.unlock({ setup, secrets, passphrase, keystorePath });
  t.after(async () => {
    await runtime.stop().catch(() => {});
    if (fs.existsSync(runtime.file)) await runtime.run(['compose', '-p', runtime.project, '-f', runtime.file, 'down', '-v']);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const waitFor = async (predicate) => {
    for (let count = 0; count < 45; count++) {
      const status = await runtime.status();
      if (predicate(status)) return status;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('The temporary node did not reach the expected state.');
  };
  // Exercise migration from the original host-agent profile.
  const bootstrapStatus = (await (await fetch('http://127.0.0.1:26657/status')).json()).result;
  const bootstrap = JSON.parse(await runtime.run(['inspect', 'tendermint-dev']))[0];
  const network = await bootstrapNetwork(bootstrap, runtime.run);
  const legacy = composeDefinition(path.join(runtime.folder, 'tendermint'), `${bootstrapStatus.node_info.id}@tendermint-dev:26656`, network, { role: 'validator', secretsPath: keystorePath });
  delete legacy.services.agent; delete legacy.volumes['agent-logs'];
  fs.mkdirSync(runtime.folder, { recursive: true, mode: 0o700 });
  fs.writeFileSync(runtime.file, JSON.stringify(legacy), { mode: 0o600 });
  const databaseBefore = JSON.stringify(legacy.services.db);
  await runtime.start(wallet);
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(runtime.file)).services.db), databaseBefore, 'Migration preserves DB credentials and data volumes');
  const first = await waitFor((status) => BigInt(status.height || '0') > 0n && Number(status.peers) > 0);
  assert.equal(first.votingPower, '0'); // This random identity is NOT an on-chain validator.
  for (let count = 0; count < 30; count++) {
    if ((await runtime.compose(['logs', 'agent'])).includes('Validator agent running.')) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const agentLog = await runtime.compose(['logs', 'agent']);
  assert.match(agentLog, /Validator agent running\./);
  assert.equal(agentLog.includes(secrets.grph.seed), false, 'Transport seed must never appear in logs');
  const statePath = path.join(runtime.folder, 'tendermint/data/priv_validator_state.json');
  const signingState = fs.readFileSync(statePath);
  const key = fs.readFileSync(path.join(runtime.folder, 'tendermint/config/priv_validator_key.json'));
  await runtime.stop();
  assert.deepEqual(fs.readFileSync(statePath), signingState);
  assert.equal((await runtime.status()).state, 'stopped');
  await runtime.start(wallet);
  const second = await waitFor((status) => BigInt(status.height || '0') >= BigInt(first.height));
  assert.deepEqual(fs.readFileSync(path.join(runtime.folder, 'tendermint/config/priv_validator_key.json')), key);
  assert.equal(second.consensusAddress, first.consensusAddress);
  assert.deepEqual(fs.readFileSync(statePath), signingState);
  console.log(`Verified height ${first.height} → ${second.height}, ${second.peers} peer(s), no voting or user transactions.`);
});

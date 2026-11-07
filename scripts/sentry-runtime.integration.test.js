import { test } from 'node:test';
import dgram from 'node:dgram';
import HyperDHT from 'hyperdht';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import z32 from 'z32';
import { LocalNodeRuntime, installIdentity } from './local-node-runtime.js';
import { generateAll } from '../agents/validator-agent/src/keygen.js';
import { publicNodeSetup } from '../agents/lib/node-setup.js';
import { encryptSecrets } from '../agents/lib/keystore.js';
import { sealInviteKey } from '../agents/validator-agent/src/monitor.js';

const exec = promisify(execFile);
const run = async (args, options = {}) => (await exec('docker', args, { timeout: 180000, maxBuffer: 512000, ...options })).stdout;
const listen = (server, host = '127.0.0.1') => new Promise((resolve) => server.listen(0, host, resolve));
const pause = () => new Promise((resolve) => setTimeout(resolve, 1000));

// Isolated kvstore nodes test the real DHT tunnel and authenticated Tendermint
// handshake without replaying or modifying the user's chain or using their keys.
test('sentry Docker runtime verifies a local peer and disconnects it on revocation', { skip: process.env.GRAPHENE_DOCKER_TEST !== '1', timeout: 240000 }, async (t) => {
  const reservation = dgram.createSocket('udp4');
  await new Promise(resolve => reservation.bind(0, '0.0.0.0', resolve));
  const dhtPort = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const dhtHost = Object.values(os.networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address;
  assert.ok(dhtHost, 'A host IPv4 interface is required for the isolated Docker DHT test');
  const rendezvous = HyperDHT.bootstrapper(dhtPort, dhtHost); await rendezvous.ready();
  const previousDht = process.env.GRAPHENE_DHT_BOOTSTRAP;
  process.env.GRAPHENE_DHT_BOOTSTRAP = dhtHost + ':' + dhtPort;
  t.after(async () => { if (previousDht === undefined) delete process.env.GRAPHENE_DHT_BOOTSTRAP; else process.env.GRAPHENE_DHT_BOOTSTRAP = previousDht; await rendezvous.destroy(); });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'grph-sentry-integration-'));
  const reference = generateAll(), secrets = generateAll();
  const referenceName = `grph-node-${reference.agent.address.slice(2).toLowerCase()}-node-1`;
  const home = path.join(directory, 'reference');
  const genesis = { genesis_time: new Date().toISOString(), chain_id: referenceName.slice(0, 40), initial_height: '1', validators: [{ address: reference.tendermint.validator.address, pub_key: reference.tendermint.validator.publicKey, power: '10', name: 'test-reference' }], app_hash: '', app_state: {} };
  installIdentity(home, reference, genesis);
  let runtime, api; let revoked = false;
  t.after(async () => {
    await run(['rm', '-f', referenceName + '-agent']).catch(() => {});
    if (runtime && fs.existsSync(runtime.file)) { await runtime.stop().catch(() => {}); await runtime.compose(['down', '-v']).catch(() => {}); }
    await run(['rm', '-f', referenceName]).catch(() => {});
    if (api) await new Promise((resolve) => api.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await run(['run', '--rm', '--entrypoint', 'tendermint', '-v', `${home}:/tendermint`, 'tendermint:dev', 'init', '--home', '/tendermint']);
  const bootstrap = JSON.parse(await run(['inspect', 'tendermint-dev']))[0];
  const network = Object.keys(bootstrap.NetworkSettings.Networks).find((name) => name.startsWith('graphene-local_'));
  await run(['run', '-d', '--name', referenceName, '--network', network, '-v', `${home}:/tendermint`, '-p', '127.0.0.1::26656', '-p', '127.0.0.1::26657', '--entrypoint', 'tendermint', 'tendermint:dev', 'node', '--home', '/tendermint', '--proxy_app', 'kvstore', '--rpc.laddr', 'tcp://0.0.0.0:26657', '--log_level', 'error']);
  const refContainer = JSON.parse(await run(['inspect', referenceName]))[0];
  const p2p = Number(refContainer.NetworkSettings.Ports['26656/tcp'][0].HostPort);

  const encrypted = sealInviteKey(z32.encode(Buffer.from(reference.grph.keyPair.publicKey, 'hex')), secrets.x25519.publicKey);
  const wallet = '0x' + '1'.repeat(40), validator = '0x' + '2'.repeat(40);
  api = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.includes('/assignments?agent=')) return res.end('[]');
    if (req.url.includes('/assignments')) return res.end(JSON.stringify(revoked ? [] : [{ id: '0x01', validator, sentryId: secrets.agent.address, status: 'Active', encryptedConnectionString: encrypted }]));
    return res.end(JSON.stringify({ nodeId: reference.tendermint.node.nodeId, agentAddress: reference.agent.address }));
  });
  await listen(api, '0.0.0.0');
  const referenceStore = path.join(directory, 'reference-keystore.enc');
  const referencePassword = 'temporary reference password';
  fs.writeFileSync(referenceStore, encryptSecrets(reference, referencePassword), { mode: 0o600 });
  await run(['build', '-t', 'graphene-validator-agent:local', '-f', 'agents/validator-agent/Dockerfile', process.cwd()]);
  await run(['run', '-d', '--name', referenceName + '-agent', '--network', network, '--add-host', 'host.docker.internal:host-gateway', '-v', `${referenceStore}:/app/secrets/keystore.enc:ro`, '-e', 'KEYSTORE_PATH=/app/secrets/keystore.enc', '-e', 'KEYSTORE_PASSPHRASE', '-e', 'GRAPHENE_DHT_BOOTSTRAP=' + process.env.GRAPHENE_DHT_BOOTSTRAP, '-e', 'MANAGE_TENDERMINT=false', '-e', 'MANAGE_PEERS=false', '-e', 'AGENT_HOST=' + referenceName, '-e', 'AGENT_PORT=26656', '-e', `RPC_URL=http://host.docker.internal:${api.address().port}/graphene-evm/rpc`, '-e', 'CONTRACT_ADDRESS=0x0000000000000000000000000000000000000004', 'graphene-validator-agent:local'], { env: { ...process.env, KEYSTORE_PASSPHRASE: referencePassword } });
  const portReservation = http.createServer(); await listen(portReservation); const sentryPort = portReservation.address().port; await new Promise((resolve) => portReservation.close(resolve));
  const setup = publicNodeSetup('sentry', secrets, 'test-sentry', { host: 'sentry.local', port: sentryPort });
  const keystorePath = path.join(directory, 'sentry-secrets.json'), passphrase = 'temporary test password';
  fs.writeFileSync(keystorePath, encryptSecrets(secrets, passphrase), { mode: 0o600 });
  runtime = new LocalNodeRuntime({ directory, read: async (url) => {
    if (url.endsWith('/sentries')) return [{ ...setup, active: true, operator: wallet, sentryId: setup.agentAddress, tendermintNodeId: setup.nodeId }];
    if (url.endsWith('/genesis')) return { result: { genesis } };
    if (url.endsWith('/status')) return { result: { node_info: { network: genesis.chain_id, id: reference.tendermint.node.nodeId } } };
    throw new Error('Unexpected fixture read');
  }, run: async (args, options) => {
    if (args[0] === 'compose' && args.includes('up')) {
      const definition = JSON.parse(fs.readFileSync(runtime.file));
      definition.services.node.command = ['node', '--home', '/tendermint', '--proxy_app', 'kvstore', '--rpc.laddr', 'tcp://0.0.0.0:26657', '--rpc.unsafe=true', '--p2p.pex=false', '--log_level', 'error'];
      delete definition.services.node.depends_on;
      definition.services.agent.environment.RPC_URL = `http://host.docker.internal:${api.address().port}/graphene-evm/rpc`;
      definition.services.agent.environment.POLL_INTERVAL_MS = '1000';
      delete definition.services['bootstrap-source']; delete definition.services['bootstrap-tunnel'];
      delete definition.services.db; delete definition.services.mpt; delete definition.services.abci;
      fs.writeFileSync(runtime.file, JSON.stringify(definition), { mode: 0o600 });
    }
    try { return await run(args, options); }
    catch (error) {
      console.error('Fixture Docker failure:', error.stderr?.slice(-3000));
      if (args[0] === 'compose' && args.includes('up')) console.error(await run(['compose', '-p', runtime.project, '-f', runtime.file, 'logs', '--tail', '15']).catch(() => 'logs unavailable'));
      throw error;
    }
  } });
  runtime.unlock({ setup, secrets, keystorePath, passphrase });
  await runtime.start(wallet);
  let status;
  for (let count = 0; count < 90; count++) {
    status = await runtime.status();
    if (status.connections?.some((entry) => entry.peerConnected)) break;
    await pause();
  }
  assert.equal(status.connections?.[0]?.peerConnected, true, JSON.stringify(status));
  assert.equal(status.connections[0].nodeId, reference.tendermint.node.nodeId);
  assert.equal(status.connections[0].transport, 'grph');
  console.log('Verified authenticated Tendermint peer through the encrypted Grph P2P tunnel.');
  const signingStatePath = path.join(runtime.folder, 'tendermint/data/priv_validator_state.json');
  const signingState = fs.readFileSync(signingStatePath);
  await runtime.stop();
  await runtime.start(wallet);
  for (let count = 0; count < 60; count++) {
    status = await runtime.status();
    if (status.connections?.some((entry) => entry.peerConnected)) break;
    await pause();
  }
  if (!status.connections?.[0]?.peerConnected) { console.log('Restart status:', JSON.stringify(status)); console.log(await runtime.compose(['logs', '--tail', '20', 'node', 'agent'])); }
  assert.equal(status.connections?.[0]?.peerConnected, true, 'Restart must recover the approved tunnel');
  assert.deepEqual(fs.readFileSync(signingStatePath), signingState, 'Sentry restart must preserve its nonvoting signing state');
  console.log('Restart recovered the tunnel without replacing node identity or signing state.');
  revoked = true;
  for (let count = 0; count < 30; count++) {
    status = await runtime.status();
    if (status.agentRunning && status.connections?.length === 0 && Number(status.peers) === 0) break;
    await pause();
  }
  assert.equal(status.connections?.length, 0); assert.equal(Number(status.peers), 0);
  console.log('Revocation closed the tunnel and disconnected the peer.');
});

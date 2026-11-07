import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import dgram from 'node:dgram';
import HyperDHT from 'hyperdht';
import { openGrphServer } from '../agents/lib/grph-tunnel.js';
import { composeDefinition, installIdentity, LocalNodeRuntime, prepareBootstrapTunnel } from './local-node-runtime.js';
import { generateAll } from '../agents/validator-agent/src/keygen.js';
import { publicNodeSetup } from '../agents/lib/node-setup.js';
import { docker, inspect, json, exportBootstrap } from './checkpoint-docker.js';
import { verifyRestore } from './checkpoint-verify.js';
import { verifyManifest } from './checkpoint-core.js';

// Uses only synthetic keys, its own chain/network, and newly allocated volumes.
// The real graphene-local bootstrap is never stopped or changed by this test.
test('export, Grph P2P download, launcher restore and canonical catch-up on real Java ABCI/IAVL', { skip: process.env.GRAPHENE_DOCKER_TEST !== '1', timeout: 600000 }, async (t) => {
  const reservation = dgram.createSocket('udp4');
  await new Promise(resolve => reservation.bind(0, '0.0.0.0', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const host = Object.values(os.networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address;
  assert.ok(host, 'A host IPv4 interface is required for the isolated Docker DHT test');
  const rendezvous = HyperDHT.bootstrapper(port, host);
  await rendezvous.ready();
  const previousDht = process.env.GRAPHENE_DHT_BOOTSTRAP;
  process.env.GRAPHENE_DHT_BOOTSTRAP = `${host}:${port}`;
  t.after(async () => {
    if (previousDht === undefined) delete process.env.GRAPHENE_DHT_BOOTSTRAP;
    else process.env.GRAPHENE_DHT_BOOTSTRAP = previousDht;
    await rendezvous.destroy();
  });
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'graphene-checkpoint-donor-'));
  const home = path.join(folder, 'tendermint'), file = path.join(folder, 'compose.json');
  const project = `grph-donor-${crypto.randomBytes(6).toString('hex')}`;
  const compose = (args) => docker(['compose', '-p', project, '-f', file, ...args]);
  const keys = crypto.generateKeyPairSync('ed25519');
  let receiver, server, publication;
  try {
    fs.mkdirSync(home);
    await docker(['run', '--rm', '--entrypoint', 'tendermint', '-v', `${home}:/tendermint`, 'tendermint:dev', 'init', '--home', '/tendermint']);
    const key = JSON.parse(fs.readFileSync(path.join(home, 'config/priv_validator_key.json')));
    const genesisFile = path.join(home, 'config/genesis.json');
    const genesis = JSON.parse(fs.readFileSync(genesisFile)); genesis.chain_id = project;
    fs.writeFileSync(genesisFile, JSON.stringify(genesis));
    const profile = composeDefinition(home, '', 'unused', { project });
    delete profile.services.agent; delete profile.volumes['agent-logs']; delete profile.networks.bootstrap;
    delete profile.services['bootstrap-source']; delete profile.services['bootstrap-tunnel'];
    delete profile.services.node.depends_on['bootstrap-tunnel'];
    profile.services.node.networks = ['default'];
    const flag = profile.services.node.command.indexOf('--p2p.persistent_peers'); profile.services.node.command.splice(flag, 2);
    profile.services.abci.environment.GENESIS_VALIDATOR_PUBLIC_KEY = key.pub_key.value;
    fs.writeFileSync(file, JSON.stringify(profile), { mode: 0o600 });
    await compose(['up', '-d', '--wait', '--wait-timeout', '100']);
    const port = (await compose(['port', 'node', '26657'])).trim();
    const source = { project, tm: `${project}-node-1`, abci: `${project}-abci-1`, mpt: `${project}-mpt-1`, db: `${project}-db-1`, rpc: `http://${port}` };
    for (let attempt = 0; attempt < 60; attempt++) {
      try { if (Number((await json(`${source.rpc}/status`)).result.sync_info.latest_block_height) >= 5) break; } catch { /* startup */ }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const before = fs.readFileSync(path.join(home, 'config/priv_validator_key.json'));
    const output = path.join(folder, 'published');
    const result = await exportBootstrap({ output, privateKey: keys.privateKey, source, verifyRestore: (directory, trust) => verifyRestore(directory, trust, { reference: source }) });
    const envelope = JSON.parse(fs.readFileSync(path.join(output, 'latest.json')));
    assert.equal(verifyManifest(envelope, result.trust).height, result.manifest.height);
    assert.ok(result.manifest.verification.height > Number(result.manifest.height));
    assert.equal(result.manifest.verification.nonVoting, true);
    assert.deepEqual(fs.readFileSync(path.join(home, 'config/priv_validator_key.json')), before);
    assert.equal((await inspect(source.tm)).State.Running, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(result.directory, 'app-state.json'))).session_token, null);
    server = http.createServer((req, res) => {
      const name = req.url.replace(/^\//, '');
      if (name.includes('..') || !fs.existsSync(path.join(output, name)) || !fs.statSync(path.join(output, name)).isFile()) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Length', fs.statSync(path.join(output, name)).size);
      fs.createReadStream(path.join(output, name)).pipe(res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const trustFile = path.join(folder, 'receiver-trust.json');
    publication = await openGrphServer({ seed: crypto.randomBytes(32).toString('hex'), port: server.address().port });
    fs.writeFileSync(trustFile, JSON.stringify({ ...result.trust, manifestURL: `grph://${publication.key}/latest.json` }));
    const secrets = generateAll();
    receiver = new LocalNodeRuntime({ directory: path.join(folder, 'receiver'), checkpointTrustFile: trustFile });
    receiver.unlock({ secrets, setup: publicNodeSetup('validator', secrets, 'Checkpoint test receiver') });
    const receiverHome = path.join(receiver.folder, 'tendermint');
    installIdentity(receiverHome, secrets, genesis);
    await docker(['run', '--rm', '--entrypoint', 'tendermint', '-v', `${receiverHome}:/tendermint`, 'tendermint:dev', 'init', '--home', '/tendermint']);
    const receiverConfig = path.join(receiverHome, 'config/config.toml');
    fs.writeFileSync(receiverConfig, fs.readFileSync(receiverConfig, 'utf8').replace(/^addr_book_strict\s*=.*$/m, 'addr_book_strict = false'));
    const receiverKey = fs.readFileSync(path.join(receiverHome, 'config/priv_validator_key.json'));
    const receiverSigning = fs.readFileSync(path.join(receiverHome, 'data/priv_validator_state.json'));
    const bootstrap = await inspect(source.tm);
    const network = Object.keys(bootstrap.NetworkSettings.Networks)[0];
    const sourceStatus = (await json(`${source.rpc}/status`)).result;
    prepareBootstrapTunnel(receiver.folder, source.tm);
    const receiverProfile = composeDefinition(receiverHome, `${sourceStatus.node_info.id}@${source.tm}:26656`, network);
    delete receiverProfile.services.agent; delete receiverProfile.volumes['agent-logs'];
    fs.writeFileSync(receiver.file, JSON.stringify(receiverProfile));
    await receiver.bootstrapCheckpoint(receiverHome);
    assert.equal(receiver.checkpoint.phase, 'catching-up');
    assert.deepEqual(fs.readFileSync(path.join(receiverHome, 'config/priv_validator_key.json')), receiverKey);
    assert.deepEqual(fs.readFileSync(path.join(receiverHome, 'data/priv_validator_state.json')), receiverSigning);
    await receiver.compose(['up', '-d', '--wait', '--wait-timeout', '90']);
    let state;
    for (let attempt = 0; attempt < 90; attempt++) {
      state = await receiver.status();
      if (state.checkpoint?.phase === 'synchronized') break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.equal(state.checkpoint.phase, 'synchronized', JSON.stringify({ state: state.state, height: state.height, peers: state.peers, error: state.error, syncError: state.syncError }));
    assert.equal(state.votingPower, '0');
    const marker = fs.readFileSync(path.join(receiver.folder, 'checkpoint-state.json'));
    await receiver.bootstrapCheckpoint(receiverHome);
    assert.deepEqual(fs.readFileSync(path.join(receiver.folder, 'checkpoint-state.json')), marker, 'Restart resumes existing data without restoring again');
    // Exercise recovery against real existing stores on this synthetic nonvoter.
    await receiver.stop();
    const beforeReset = await json(`${source.rpc}/status`);
    await receiver.bootstrapCheckpoint(receiverHome, true);
    const resetJournal = JSON.parse(fs.readFileSync(path.join(receiver.folder, 'checkpoint-state.json')));
    assert.equal(resetJournal.phase, 'installed');
    assert.ok(fs.existsSync(path.join(resetJournal.backup, 'state.db')));
    assert.deepEqual(fs.readFileSync(path.join(receiverHome, 'config/priv_validator_key.json')), receiverKey);
    assert.deepEqual(fs.readFileSync(path.join(receiverHome, 'data/priv_validator_state.json')), receiverSigning);
    await receiver.compose(['up', '-d', '--wait', '--wait-timeout', '90']);
    for (let attempt = 0; attempt < 90; attempt++) {
      state = await receiver.status();
      if (state.checkpoint?.phase === 'synchronized') break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(state.checkpoint.phase, 'synchronized', JSON.stringify(state));
    const afterReset = await json(`${source.rpc}/status`);
    assert.ok(BigInt(afterReset.result.sync_info.latest_block_height) > BigInt(beforeReset.result.sync_info.latest_block_height));
    console.log('Verified existing-node checkpoint reset, retained backup, unchanged signer, and real canonical catch-up.');
    console.log('Verified Grph P2P signature/download, original receiver identity/signing state, and synchronized launcher progress.');
    console.log(`Verified checkpoint ${result.manifest.height} → ${result.manifest.verification.height} on isolated chain ${project}.`);
  } finally {
    if (receiver && fs.existsSync(receiver.file)) await receiver.compose(['down', '-v', '--remove-orphans']);
    await publication?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (fs.existsSync(file)) await compose(['down', '-v', '--remove-orphans']);
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

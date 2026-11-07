#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import HyperDHT from 'hyperdht';
import { tunnelPublicKey } from '../agents/lib/grph-tunnel.js';
import { atomicJSON, hash, validateProfile } from '../agents/lib/update-contracts.js';
import { UpdateStore, fileHash } from '../agents/lib/update-store.js';
import { genesisHash } from './checkpoint-core.js';

const cli = fileURLToPath(new URL('./update-cli.js', import.meta.url));
async function bounded(promise, milliseconds, label, signal) {
  let timer, aborted;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out.`)), milliseconds);
      if (signal) {
        aborted = () => reject(new Error('End-to-end run interrupted.'));
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted();
      }
    })]);
  } finally { clearTimeout(timer); if (aborted) signal.removeEventListener('abort', aborted); }
}

export async function runUpdateE2E({ directory, environment = 'local' } = {}) {
  const channels = { local: 'dev', test: 'candidate', prod: 'stable' };
  if (!Object.hasOwn(channels, environment)) throw new Error('Choose local, test or prod for the fixture environment.');
  if (directory) {
    directory = path.resolve(directory);
    if (fs.existsSync(directory) && fs.readdirSync(directory).length) throw new Error('Choose a new or empty E2E directory; existing data will not be overwritten.');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  } else directory = fs.mkdtempSync(path.join(os.tmpdir(), 'graphene-update-e2e-'));
  const logs = path.join(directory, 'logs');
  fs.mkdirSync(logs, { mode: 0o700 });
  const children = [], controller = new AbortController();
  const interrupted = () => controller.abort();
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  let dht, env;
  const report = { format: 1, scope: 'CLI publish -> real Grph P2P -> verified staging', directory,
    environment, channel: channels[environment], startedAt: new Date().toISOString(), activationSupported: false, steps: [] };
  const step = (name, details = {}) => { report.steps.push({ name, passed: true, ...details }); console.log(`PASS ${name}`); };
  const launch = (args, name) => {
    controller.signal.throwIfAborted();
    const out = fs.openSync(path.join(logs, `${name}.stdout.log`), 'wx', 0o600);
    const err = fs.openSync(path.join(logs, `${name}.stderr.log`), 'wx', 0o600);
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const task = { child, stdout: '', result: null };
    child.stdout.on('data', bytes => {
      fs.writeSync(out, bytes); task.stdout += bytes;
      if (task.stdout.length > 1024 ** 2) child.kill('SIGTERM');
    });
    child.stderr.on('data', bytes => fs.writeSync(err, bytes));
    task.done = new Promise(resolve => {
      child.once('error', error => { task.result = { code: -1, error: error.message }; });
      child.once('close', (code, signal) => {
        fs.closeSync(out); fs.closeSync(err);
        task.result ||= { code, signal }; resolve(task.result);
      });
    });
    children.push(task); return task;
  };
  const run = async (args, name, success = true) => {
    const task = launch(args, name);
    const result = await bounded(task.done, 45000, name, controller.signal);
    assert.equal(result.code === 0, success, `${name}: unexpected exit ${result.code}; inspect ${logs}`);
    return success ? JSON.parse(task.stdout) : result;
  };
  const waitFor = async (check, label) => {
    const deadline = Date.now() + 15000;
    for (;;) {
      controller.signal.throwIfAborted();
      const result = check(); if (result) return result;
      if (Date.now() >= deadline) throw new Error(`${label} timed out.`);
      await delay(25);
    }
  };
  const stop = async task => {
    if (!task || task.result) return;
    task.child.kill('SIGTERM');
    try { await bounded(task.done, 5000, 'CLI shutdown'); }
    catch { task.child.kill('SIGKILL'); await bounded(task.done, 5000, 'CLI forced shutdown'); }
  };
  console.log(`E2E artifacts: ${directory}`);
  try {
    const socket = dgram.createSocket('udp4');
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', resolve); });
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    // bootstrapper's host argument advertises an address; its socket defaults
    // to all interfaces unless host is also supplied in the options.
    dht = HyperDHT.bootstrapper(port, '127.0.0.1', { host: '127.0.0.1' });
    await bounded(dht.ready(), 10000, 'Local DHT startup', controller.signal);
    env = { ...process.env, GRAPHENE_DHT_BOOTSTRAP: `127.0.0.1:${port}` };

    const seed = crypto.randomBytes(32).toString('hex'), staleSeed = crypto.randomBytes(32).toString('hex');
    const releaseKeys = crypto.generateKeyPairSync('ed25519'), channelKeys = crypto.generateKeyPairSync('ed25519');
    const privateFile = (name, key) => {
      const file = path.join(directory, name);
      fs.writeFileSync(file, key.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 }); return file;
    };
    const releaseKeyFile = privateFile('fixture-release-private.pem', releaseKeys.privateKey);
    const channelKeyFile = privateFile('fixture-channel-private.pem', channelKeys.privateKey);
    const fixtureChain = `e2e-fixture-${environment}`;
    const profile = validateProfile({ format: 1, kind: 'graphene-update-profile', networkId: `e2e-isolated-${environment}`, environment,
      tendermintChainId: fixtureChain, chainId: 9876, genesisHash: genesisHash({ chain_id: fixtureChain, initial_height: '1' }),
      role: 'validator', channel: channels[environment], target: { os: 'linux', arch: 'arm64' }, currentVersion: '1.0.0', seeds: [tunnelPublicKey(seed)],
      keys: { release: { fixture: releaseKeys.publicKey.export({ type: 'spki', format: 'pem' }) },
        channel: { fixture: channelKeys.publicKey.export({ type: 'spki', format: 'pem' }) } },
      maxArtifactBytes: 8 * 1024 ** 2, maxCacheBytes: 64 * 1024 ** 2, bytesPerSecond: 4 * 1024 ** 2, pollIntervalMs: 10000 });
    const profileFile = path.join(directory, 'validator-profile.json'); atomicJSON(profileFile, profile);
    const sentryProfile = { ...profile, role: 'sentry' }, sentryFile = path.join(directory, 'sentry-profile.json'); atomicJSON(sentryFile, sentryProfile);
    const source = path.join(directory, 'fixture-artifact.bin');
    fs.writeFileSync(source, crypto.randomBytes(3 * 1024 ** 2 + 123), { mode: 0o600 });
    const hashV1 = await fileHash(source);
    const descriptor = { releaseId: '1.1.0', classification: 'compatible', compatibleFrom: ['1.0.0'],
      artifacts: [{ file: 'fixture-artifact.bin', component: 'e2e-fixture', role: 'all', os: 'linux', arch: 'arm64' }] };
    const descriptorFile = path.join(directory, 'release.json'); atomicJSON(descriptorFile, descriptor);
    const seedDirectory = path.join(directory, 'publisher'), staleDirectory = path.join(directory, 'stale-publisher');
    const receiverDirectory = path.join(directory, 'receiver');
    const seedStore = new UpdateStore(seedDirectory, profile), receiverStore = new UpdateStore(receiverDirectory, profile);
    atomicJSON(path.join(seedStore.directory, 'update-p2p.json'), { seed });
    const publish = sequence => run(['publish', '--profile', profileFile, '--directory', seedDirectory, '--descriptor', descriptorFile,
      '--release-key', releaseKeyFile, '--release-key-id', 'fixture', '--channel-key', channelKeyFile, '--channel-key-id', 'fixture',
      '--sequence', String(sequence), '--expires', new Date(Date.now() + 3600000).toISOString()], `publish-v${sequence}`);
    const startSeed = async (seedDir, expectedKey, name) => {
      const task = launch(['serve', '--profile', profileFile, '--directory', seedDir], name);
      await waitFor(() => {
        if (task.result) throw new Error(`${name} exited; inspect ${logs}`);
        const line = task.stdout.split('\n').slice(0, -1).find(line => line.startsWith('{'));
        if (!line) return false;
        const value = JSON.parse(line); assert.equal(value.publicKey, expectedKey); return true;
      }, `${name} readiness`);
      return task;
    };
    await publish(1); step('Publish signed release v1 using the real CLI');
    fs.cpSync(seedDirectory, staleDirectory, { recursive: true });
    const staleStore = new UpdateStore(staleDirectory, profile);
    atomicJSON(path.join(staleStore.directory, 'update-p2p.json'), { seed: staleSeed });
    await startSeed(seedDirectory, tunnelPublicKey(seed), 'seed-current');
    await startSeed(staleDirectory, tunnelPublicKey(staleSeed), 'seed-stale');
    step('Start independent Grph seed processes on an isolated local DHT');

    const transfer = launch(['stage', '--profile', profileFile, '--directory', receiverDirectory], 'validator-interrupted');
    await waitFor(() => {
      if (transfer.result) throw new Error('Transfer exited before the interruption check.');
      const state = receiverStore.state(); return state.phase === 'downloading' && state.completedChunk >= 1;
    }, 'First verified chunk');
    await stop(transfer);
    const chunkDirectory = path.dirname(receiverStore.chunkPath(hashV1, 0));
    const retainedChunks = fs.readdirSync(chunkDirectory).length;
    assert.ok(retainedChunks > 0); assert.equal(fs.existsSync(receiverStore.lockFile), false);
    step('Interrupt receiver and retain verified chunks', { retainedChunks });

    const staged = await run(['stage', '--profile', profileFile, '--directory', receiverDirectory], 'validator-resumed');
    assert.equal(staged.phase, 'staged'); assert.equal(staged.activationSupported, false);
    assert.equal(await fileHash(receiverStore.artifactPath(hashV1)), hashV1);
    step('Restart validator receiver, resume and verify complete bytes', { sha256: hashV1 });
    const sentry = await run(['stage', '--profile', sentryFile, '--directory', receiverDirectory], 'sentry-stage');
    assert.equal(sentry.phase, 'staged');
    const sentryStore = new UpdateStore(receiverDirectory, sentryProfile);
    assert.notEqual(sentryStore.directory, receiverStore.directory);
    assert.equal(await fileHash(sentryStore.artifactPath(hashV1)), hashV1);
    step('Stage the release for a separate sentry receiver');

    fs.writeFileSync(source, crypto.randomBytes(900000));
    const hashV2 = await fileHash(source);
    atomicJSON(descriptorFile, { ...descriptor, releaseId: '1.2.0' });
    await publish(2);
    const newer = await run(['stage', '--profile', profileFile, '--directory', receiverDirectory], 'validator-v2');
    assert.equal(newer.sequence, 2); assert.equal(newer.releaseId, '1.2.0');
    assert.equal(await fileHash(receiverStore.artifactPath(hashV2)), hashV2);
    step('Publish v2 and discover/stage the new release', { sha256: hashV2 });

    const staleProfileFile = path.join(directory, 'stale-only-profile.json');
    atomicJSON(staleProfileFile, { ...profile, seeds: [tunnelPublicKey(staleSeed)] });
    await run(['stage', '--profile', staleProfileFile, '--directory', receiverDirectory], 'reject-replayed-v1', false);
    assert.equal(receiverStore.state().sequence, 2);
    step('Reject an older correctly signed release from the stale seed');
    const wrongFile = path.join(directory, 'wrong-network-profile.json');
    atomicJSON(wrongFile, { ...profile, genesisHash: hash('a different network') });
    await run(['stage', '--profile', wrongFile, '--directory', path.join(directory, 'wrong-network-receiver')], 'reject-wrong-network', false);
    step('Reject a receiver bound to a different network');

    await run(['stage', '--profile', profileFile, '--directory', receiverDirectory], 'restore-current-staged-status');
    const status = await run(['status', '--profile', profileFile, '--directory', receiverDirectory], 'final-status');
    assert.equal(status.phase, 'staged'); assert.equal(status.sequence, 2); assert.equal(status.activationSupported, false);
    report.passed = true; report.finalStatus = status; report.receiverProfile = profileFile; report.receiverDirectory = receiverDirectory;
    report.note = 'Real separate CLI processes and Grph transport; fixture bytes only. No blockchain node was installed or restarted.';
    return report;
  } catch (error) { report.passed = false; report.error = error.message; throw error; }
  finally {
    const stopped = await Promise.allSettled(children.map(stop));
    const failures = stopped.filter(result => result.status === 'rejected');
    if (dht) { try { await bounded(dht.destroy(), 5000, 'DHT shutdown'); } catch (error) { failures.push({ reason: error }); } }
    process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
    if (failures.length) { report.passed = false; report.cleanupErrors = failures.map(result => String(result.reason)); process.exitCode = 1; }
    report.finishedAt = new Date().toISOString(); atomicJSON(path.join(directory, 'report.json'), report);
    console.log(`Report: ${path.join(directory, 'report.json')}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { directory: { type: 'string' }, environment: { type: 'string' } } });
  runUpdateE2E(values).then(report => {
    if (!report.passed) process.exit(1);
  }, error => {
    // Cleanup has already been attempted and the report written. A native UDP
    // bind failure can leave a library handle alive even after destroy rejects.
    console.error(error.message); process.exit(1);
  });
}

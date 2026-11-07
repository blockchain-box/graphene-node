import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { restoreExisting, restoreFresh } from './checkpoint-docker.js';
import { artifacts, fileHash, genesisHash, signManifest } from './checkpoint-core.js';

async function fixture(t, { fail, signedHeight = '40' } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'grph-reset-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const home = path.join(folder, 'tendermint'), directory = path.join(folder, 'published'), trie = path.join(folder, 'trie');
  for (const dir of [directory, trie, path.join(home, 'config'), path.join(home, 'data')]) fs.mkdirSync(dir, { recursive: true });
  const genesis = { chain_id: 'reset-test' };
  fs.writeFileSync(path.join(home, 'config/genesis.json'), JSON.stringify(genesis));
  fs.writeFileSync(path.join(home, 'config/node_key.json'), 'original peer key');
  fs.writeFileSync(path.join(home, 'config/priv_validator_key.json'), 'original consensus key');
  const signing = JSON.stringify({ height: signedHeight, round: 2, step: 3, signature: 'preserve exact signature', signbytes: 'preserve exact bytes' });
  fs.writeFileSync(path.join(home, 'data/priv_validator_state.json'), signing);
  const tmNames = ['blockstore.db', 'state.db', 'evidence.db', 'tx_index.db'];
  for (const name of [...tmNames, 'cs.wal']) {
    fs.mkdirSync(path.join(home, 'data', name)); fs.writeFileSync(path.join(home, 'data', name, 'original'), name);
  }
  fs.mkdirSync(path.join(trie, 'db')); fs.writeFileSync(path.join(trie, 'db/original'), 'old trie');
  const payload = path.join(folder, 'payload'); fs.mkdirSync(payload);
  for (const name of tmNames) { fs.mkdirSync(path.join(payload, name)); fs.writeFileSync(path.join(payload, name, 'CURRENT'), name); }
  execFileSync('tar', ['--format=ustar', '-czf', path.join(directory, 'tendermint.tar.gz'), '-C', payload, ...tmNames], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  for (const name of ['state', 'blocks', 'transactions', 'receipts']) fs.mkdirSync(path.join(payload, 'db', name), { recursive: true });
  execFileSync('tar', ['--format=ustar', '-czf', path.join(directory, 'mpt.tar.gz'), '-C', payload, 'db'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const metadata = { chain_id: 9876, current_height: 42, current_app_root: '0x' + 'a'.repeat(64), current_block_hash: '0x' + 'b'.repeat(64), genesis_app_root: '0x' + 'c'.repeat(64), genesis_block_hash: '0x' + 'd'.repeat(64), genesis_versions: '["v0"]', session_token: null };
  const previous = { ...metadata, current_height: 40, session_token: 'old private session' };
  fs.writeFileSync(path.join(directory, 'app-state.json'), JSON.stringify(metadata));
  fs.writeFileSync(path.join(directory, 'genesis.json'), JSON.stringify(genesis));
  const images = { abci: 'abci-id', mpt: 'mpt-id', tendermint: 'tendermint-id', postgres: 'postgres-id' };
  const files = {};
  for (const name of artifacts) files[name] = { bytes: fs.statSync(path.join(directory, name)).size, sha256: await fileHash(path.join(directory, name)) };
  const manifest = { format: 1, kind: 'graphene-local-checkpoint', id: 'height-42-test', chainId: 9876, genesisHash: genesisHash(genesis), height: '42', appHash: 'a'.repeat(64), blockHash: 'b'.repeat(64), createdAt: new Date().toISOString(), files, images, verification: { caughtUp: true, height: 45, appHash: 'd'.repeat(64) } };
  const keys = crypto.generateKeyPairSync('ed25519');
  const trust = { chainId: 9876, genesisHash: manifest.genesisHash, publicKey: keys.publicKey };
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(signManifest(manifest, keys.privateKey)));
  const journal = path.join(folder, 'checkpoint-state.json');
  const oldJournal = JSON.stringify({ phase: 'installed', height: '10', id: 'old-checkpoint' });
  fs.writeFileSync(journal, oldJournal);
  const calls = [];
  let sql = '', sqlWrites = 0;
  const project = 'grph-node-test';
  const run = async args => {
    calls.push(args);
    if (args[0] === 'image') return JSON.stringify([{ Id: images[args[2].split(':')[0].replace('app-', '').replace('-db', '').replace('postgresql', 'postgres')] }]);
    if (args[0] === 'ps') return `${project}-node-1\n${project}-mpt-1\n${project}-db-1`;
    if (args[0] === 'inspect') {
      const service = args[1].split('-').at(-2);
      return JSON.stringify([{ Config: { Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': service } }, State: { Running: fail === 'running' && service === 'node' }, Mounts: [{ Type: 'volume', Name: 'fixture_mpt', Destination: '/data' }] }]);
    }
    if (args[0] === 'start' || args[0] === 'stop') return '';
    if (args[0] === 'exec') {
      if (args[2] === 'psql') {
        if (args.includes('-Atc')) return JSON.stringify(previous);
        sql = args.at(-1);
        if (fail === 'sql' && ++sqlWrites === 1) throw new Error('injected SQL failure');
        return '';
      }
      return JSON.stringify({ root: fail === 'root' ? 'f'.repeat(64) : manifest.appHash });
    }
    if (args[0] === 'run') {
      const mounts = {};
      for (let i = 0; i < args.length; i++) if (args[i] === '-v') {
        const [source, target] = args[i + 1].split(':'); mounts[target.slice(1)] = source === 'fixture_mpt' ? trie : source;
      }
      const script = args.at(-1).replace(/\/(checkpoint|target|tm)(?=\/|;| |$)/g, (_, name) => mounts[name]);
      if (fail === 'extract' && script.includes('tar -xzf')) throw new Error('injected extraction failure');
      execFileSync('sh', ['-ec', script]);
      return '';
    }
    throw new Error(`Unexpected fixture command: ${args.join(' ')}`);
  };
  return { home, directory, manifest, trust, project, run, signing, journal, oldJournal, trie, calls, tmNames, previous, getSQL: () => sql };
}

test('existing reset installs checkpoint, retains complete old stores and WAL, and preserves signer bytes', async t => {
  const f = await fixture(t);
  await restoreExisting(f);
  const state = JSON.parse(fs.readFileSync(f.journal));
  assert.equal(state.phase, 'installed');
  for (const name of f.tmNames) {
    assert.equal(fs.readFileSync(path.join(f.home, 'data', name, 'CURRENT'), 'utf8'), name);
    assert.equal(fs.readFileSync(path.join(state.backup, name, 'original'), 'utf8'), name);
  }
  assert.ok(fs.existsSync(path.join(state.backup, 'cs.wal/original')));
  assert.ok(!fs.existsSync(path.join(f.home, 'data/cs.wal')));
  assert.equal(fs.readFileSync(path.join(f.home, 'data/priv_validator_state.json'), 'utf8'), f.signing);
  assert.equal(fs.readFileSync(path.join(f.home, 'config/priv_validator_key.json'), 'utf8'), 'original consensus key');
  assert.equal(fs.readFileSync(path.join(f.home, 'config/node_key.json'), 'utf8'), 'original peer key');
  assert.equal(fs.readFileSync(path.join(f.trie, state.mptBackup, 'original'), 'utf8'), 'old trie');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state.backup, 'app-state.json'))), f.previous);
  assert.ok(!f.calls.some(args => args.some(arg => arg === 'tendermint-dev' || arg === 'app-abci-dev')));
});

for (const fail of ['extract', 'sql', 'root']) test(`reset rolls back ${fail} failure to original chain, trie, journal and signer`, async t => {
  const f = await fixture(t, { fail });
  await assert.rejects(restoreExisting(f));
  for (const name of [...f.tmNames, 'cs.wal']) assert.equal(fs.readFileSync(path.join(f.home, 'data', name, 'original'), 'utf8'), name);
  assert.equal(fs.readFileSync(path.join(f.trie, 'db/original'), 'utf8'), 'old trie');
  assert.equal(fs.readFileSync(f.journal, 'utf8'), f.oldJournal);
  assert.equal(fs.readFileSync(path.join(f.home, 'data/priv_validator_state.json'), 'utf8'), f.signing);
  if (fail !== 'extract') assert.match(f.getSQL(), /json_populate_record/);
});

for (const signedHeight of ['43', 'invalid']) test(`reset rejects signing height ${signedHeight} before any Docker writes`, async t => {
  const f = await fixture(t, { signedHeight });
  await assert.rejects(restoreExisting(f), /signing history/);
  assert.equal(f.calls.length, 0);
});

test('reset rejects running containers and interrupted restore journals without replacing data', async t => {
  const f = await fixture(t, { fail: 'running' });
  await assert.rejects(restoreExisting(f), /Stop the node/);
  assert.ok(!f.calls.some(args => ['start', 'stop', 'run', 'exec'].includes(args[0])));
  fs.writeFileSync(f.journal, '{"phase":"restoring"}'); f.calls.length = 0;
  await assert.rejects(restoreExisting(f), /previous checkpoint attempt/);
  assert.equal(f.calls.length, 0);
});

test('ordinary fresh restore still refuses existing data even if caller supplies resetExisting', async t => {
  const f = await fixture(t);
  await assert.rejects(restoreFresh({ ...f, resetExisting: true }), /fresh node/);
  assert.equal(f.calls.length, 0);
});

test('legacy existing node without a restore journal can recover at its exact last signed height', async t => {
  const f = await fixture(t, { signedHeight: '42' }); fs.unlinkSync(f.journal);
  await restoreExisting(f);
  assert.equal(JSON.parse(fs.readFileSync(f.journal)).phase, 'installed');
  assert.equal(fs.readFileSync(path.join(f.home, 'data/priv_validator_state.json'), 'utf8'), f.signing);
});

test('reset refuses unsigned or changed artifacts before swapping any stores', async t => {
  const f = await fixture(t);
  const file = path.join(f.directory, 'manifest.json'), original = fs.readFileSync(file);
  const envelope = JSON.parse(original); envelope.manifest.verification = null; fs.writeFileSync(file, JSON.stringify(envelope));
  await assert.rejects(restoreExisting({ ...f, requireVerified: false }), /signature|verified/i);
  assert.equal(f.calls.length, 0);
  fs.writeFileSync(file, original); fs.appendFileSync(path.join(f.directory, 'mpt.tar.gz'), 'changed');
  await assert.rejects(restoreExisting(f), /files changed/);
  assert.ok(!f.calls.some(args => ['start', 'stop', 'run'].includes(args[0])));
  assert.equal(fs.readFileSync(f.journal, 'utf8'), f.oldJournal);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { initializeValidator, installValidatorFiles, writeValidatorReceipt } from '../agents/lib/validator-files.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graphene-home-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), bundle = path.join(root, 'bundle');
  const identity = initializeValidator(home, 'dev', 19876, '0x'+'1'.repeat(40), 'home-test-passphrase-'+'a'.repeat(32));
  const write = (name, value) => {
    const file = path.join(bundle, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const genesis = { validators: [{ address: 'GENESIS', pub_key: { value: 'genesis-signer' } }] };
  write('identity/tendermint/config/genesis.json', genesis);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(bundle, 'identity/tendermint/config/genesis.json'))).digest('hex');
  const network = { network_id: 'test-network', stage: 'dev', chain_id: 19876, file_hashes: { 'genesis.json': hash } };
  write('network.json', network);
  write('validator-admission.json', { schema: 1, networkId: network.network_id, identity });
  write('compose.json', { name: 'graphene-dev', services: { abci: { environment: { CHAIN_ID: '19876' } } } });
  write('tunnel-policy.json', { allowed_peer: 'public-cloud-peer' });
  write('identity/tendermint/config/config.toml', '# agreed config\n');
  return { home, bundle, identity, write, network };
}

test('graphene-node owns initialization and refuses to overwrite an existing home identity', t => {
  const { home, identity } = fixture(t);
  assert.equal(identity.role, 'home');
  assert.equal(identity.chain_id, 19876);
  assert.equal('seed' in identity, false);
  assert.throws(() => initializeValidator(home, 'dev', 19876, '0x'+'1'.repeat(40), 'a'.repeat(32)), /never overwritten/);
});

test('install imports setup files but preserves home keys, signing history and credentials', t => {
  const { home, bundle, write } = fixture(t);
  const stateFile = path.join(home, 'identity/tendermint/data/priv_validator_state.json');
  const state = '{"height":"123","round":0,"step":3}';
  fs.writeFileSync(stateFile, state);
  const protectedFiles = ['identity/keystore.enc', 'identity/tunnel.json', 'identity/tendermint/config/node_key.json', 'identity/tendermint/config/priv_validator_key.json'];
  const before = protectedFiles.map(file => fs.readFileSync(path.join(home, file)));
  write('.env', 'MPT_DB_API_TOKEN=untrusted-controller-value\n');
  installValidatorFiles(home, bundle);
  const env = fs.readFileSync(path.join(home, '.env'), 'utf8');
  assert.ok(!env.includes('untrusted-controller-value'));
  assert.match(env, /MPT_DB_API_TOKEN=[a-f0-9]{64}/);
  installValidatorFiles(home, bundle);
  assert.equal(fs.readFileSync(path.join(home, '.env'), 'utf8'), env);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), state);
  protectedFiles.forEach((file, index) => assert.deepEqual(fs.readFileSync(path.join(home, file)), before[index]));
});

test('wrong stage, changed genesis, changed network and missing signing state are rejected', t => {
  const { home, bundle, write, network, identity } = fixture(t);
  write('network.json', { ...network, stage: 'production' });
  assert.throws(() => installValidatorFiles(home, bundle), /stage or chain/);
  write('network.json', { ...network, file_hashes: { 'genesis.json': 'wrong' } });
  assert.throws(() => installValidatorFiles(home, bundle), /frozen network/);
  write('network.json', network);
  installValidatorFiles(home, bundle);
  write('network.json', { ...network, network_id: 'other-network' });
  write('validator-admission.json', { schema: 1, networkId: 'other-network', identity });
  assert.throws(() => installValidatorFiles(home, bundle), /another frozen network/);
  write('network.json', network);
  write('validator-admission.json', { schema: 1, networkId: network.network_id, identity });
  fs.unlinkSync(path.join(home, 'identity/tendermint/data/priv_validator_state.json'));
  assert.throws(() => installValidatorFiles(home, bundle), /Signing history is missing/);
  assert.equal(fs.existsSync(path.join(home, 'identity/tendermint/data/priv_validator_state.json')), false);
});

test('the public installation receipt binds the exact home runtime and genesis', t => {
  const { home, bundle, identity, network } = fixture(t);
  installValidatorFiles(home, bundle);
  const file = writeValidatorReceipt(home);
  const receipt = JSON.parse(fs.readFileSync(file));
  assert.equal(receipt.stage, 'dev');
  assert.equal(receipt.chain_id, 19876);
  assert.equal(receipt.network_id, network.network_id);
  assert.equal(receipt.validator_public_key, identity.validator_public_key);
  assert.equal(receipt.compose_sha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(home, 'compose.json'))).digest('hex'));
  assert.equal('seed' in receipt, false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a coordinated release fence blocks installation before runtime or signing history can change', t => {
  const {home,bundle}=fixture(t);
  const key=path.join(home,'identity/tendermint/config/priv_validator_key.json');
  const state=path.join(home,'identity/tendermint/data/priv_validator_state.json');
  const before=[fs.readFileSync(key),fs.readFileSync(state)];
  fs.writeFileSync(path.join(home,'.rollout-fence.json'),JSON.stringify({operationId:'a'.repeat(24)}));
  assert.throws(()=>installValidatorFiles(home,bundle),/fenced/);
  assert.deepEqual(fs.readFileSync(key),before[0]);assert.deepEqual(fs.readFileSync(state),before[1]);
  assert.equal(fs.existsSync(path.join(home,'compose.json')),false);
});



import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { initializeValidator, installValidatorFiles, writeValidatorReceipt, installValidator } from './deployment-validator.js';
import {fileURLToPath} from 'node:url';
import { spawnSync } from 'node:child_process';

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
  const genesis = { validators: [{ address: identity.validator_address, pub_key: { value: identity.validator_public_key } }] };
  write('identity/tendermint/config/genesis.json', genesis);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(bundle, 'identity/tendermint/config/genesis.json'))).digest('hex');
  const network = { network_id: 'test-network', stage: 'dev', chain_id: 19876, file_hashes: { 'genesis.json': hash } };
  write('network.json', network);
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
  const { home, bundle, write, network } = fixture(t);
  write('network.json', { ...network, stage: 'production' });
  assert.throws(() => installValidatorFiles(home, bundle), /stage or chain/);
  write('network.json', { ...network, file_hashes: { 'genesis.json': 'wrong' } });
  assert.throws(() => installValidatorFiles(home, bundle), /frozen network/);
  write('network.json', network);
  installValidatorFiles(home, bundle);
  write('network.json', { ...network, network_id: 'other-network' });
  assert.throws(() => installValidatorFiles(home, bundle), /another frozen network/);
  write('network.json', network);
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

test('home initialization accepts a Node env file without shell evaluation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graphene-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'home.env'), home = path.join(root, 'home');
  fs.writeFileSync(file, 'GRAPHENE_STAGE=staging\nGRAPHENE_CHAIN_ID=29876\nGRAPHENE_HOME_DIRECTORY='+home+'\nGRAPHENE_OPERATOR_ADDRESS=0x'+'1'.repeat(40)+'\nGRAPHENE_HOME_PASSPHRASE='+('x'.repeat(32))+'\n', { mode: 0o600 });
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('GRAPHENE_')) delete env[name];
  const script = new URL('./deployment-validator.js', import.meta.url).pathname;
  const result = spawnSync(process.execPath, ['--env-file='+file, script, 'init'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'public.json'))).stage, 'staging');
  const wrong = spawnSync(process.execPath, ['--env-file='+file, script, 'init'], { env: { ...env, GRAPHENE_EXPECTED_STAGE: 'production' }, encoding: 'utf8' });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /does not match/);
});

test('the home wrapper creates a private env file without overwriting filled settings', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graphene-wrapper-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config/deployment'), { recursive: true });
  fs.copyFileSync(new URL('../deploy-validator.sh', import.meta.url), path.join(root, 'deploy-validator.sh'));
  const file = path.join(root, 'config/deployment/dev.env');
  fs.writeFileSync(file+'.example', 'GRAPHENE_STAGE=dev\n');
  const command = ['deploy-validator.sh', 'dev', 'init-env'];
  assert.equal(spawnSync('bash', command, { cwd: root }).status, 0);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, 'private-home-settings-canary');
  assert.notEqual(spawnSync('bash', command, { cwd: root }).status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), 'private-home-settings-canary');
});

test('missing setup bundle names the required setting instead of showing generic usage', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graphene-install-env-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GRAPHENE_')));
  env.GRAPHENE_HOME_DIRECTORY=path.join(root,'home');
  const result=spawnSync(process.execPath,[new URL('./deployment-validator.js',import.meta.url).pathname,'install'],{env,encoding:'utf8'});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/GRAPHENE_SETUP_BUNDLE is empty/);
  assert.match(result.stderr,/Home bundle/);
});

test('home wrapper accepts an explicit bundle folder and preserves spaces without evaluating it', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'graphene-install-wrapper-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'config/deployment'),{recursive:true});
  fs.mkdirSync(path.join(root,'scripts'));
  fs.copyFileSync(new URL('../deploy-validator.sh',import.meta.url),path.join(root,'deploy-validator.sh'));
  fs.writeFileSync(path.join(root,'config/deployment/dev.env'),'GRAPHENE_STAGE=dev\nGRAPHENE_SETUP_BUNDLE=/old/bundle\n',{mode:0o600});
  fs.writeFileSync(path.join(root,'scripts/deployment-validator.js'),'console.log(JSON.stringify({bundle:process.env.GRAPHENE_SETUP_BUNDLE,action:process.argv[2]}));');
  const bundle=path.join(root,'bundle $(never-execute) folder');
  const result=spawnSync('bash',['deploy-validator.sh','dev','install',bundle],{cwd:root,env:{...process.env,GRAPHENE_NODE_BINARY:process.execPath},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),{bundle,action:'install'});
  assert.notEqual(spawnSync('bash',['deploy-validator.sh','dev','install',bundle,'extra'],{cwd:root}).status,0);
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


test('deferred checkpoint installation refuses signing history and existing ledger before running Docker',t=>{
 const {home,bundle}=fixture(t),state=path.join(home,'identity/tendermint/data/priv_validator_state.json');
 fs.writeFileSync(state,JSON.stringify({height:'12',round:0,step:3}));
 assert.throws(()=>installValidator(home,bundle,{deferStart:true}),/fresh unsigned/);
 const cli=spawnSync(process.execPath,[fileURLToPath(new URL('./deployment-validator.js',import.meta.url)),'install',home,bundle,'--defer-start'],{encoding:'utf8'});
 assert.notEqual(cli.status,0);assert.match(cli.stderr,/fresh unsigned/);
 fs.writeFileSync(state,JSON.stringify({height:'0',round:0,step:0}));fs.mkdirSync(path.join(home,'data/abci-postgres'),{recursive:true});
 assert.throws(()=>installValidator(home,bundle,{deferStart:true}),/Existing chain data/);
 assert.equal(fs.existsSync(path.join(home,'compose.json')),false);
});

test('a generated source reserved for a cloud host cannot start through the local installer', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'graphene-reserved-genesis-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'.rollout-fence.json'),JSON.stringify({kind:'genesis-source-exported'}));
  assert.throws(()=>installValidator(root,path.join(root,'unused-bundle')),/reserved for its remote genesis host/);
});

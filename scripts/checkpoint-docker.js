import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { artifacts, appStateSQL, sanitizeAppState, canonical, fileHash, genesisHash, signManifest, verifyManifest, verifyArchive } from './checkpoint-core.js';

const exec = promisify(execFile);
export const docker = async (args, options = {}) => (await exec('docker', args, { timeout: 180000, maxBuffer: 1024 * 1024, ...options })).stdout;
export const inspect = async (name, run = docker) => JSON.parse(await run(['inspect', name]))[0];
export async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Checkpoint reference node is unavailable.');
  const value = await response.json();
  if (value.error) throw new Error(value.error.message || 'Reference RPC failed.');
  return value;
}
export async function volume(container, destination, run = docker) {
  const mount = (await inspect(container, run)).Mounts.find((item) => item.Type === 'volume' && item.Destination === destination);
  if (!mount || !/^[a-zA-Z0-9_.-]+$/.test(mount.Name)) throw new Error('Expected a managed checkpoint data volume.');
  return mount.Name;
}
async function row(db, run = docker) {
  const value = await run(['exec', db, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres_username', '-d', 'grapheneDB', '-Atc', 'SELECT row_to_json(t) FROM local_abci_schema.app_states t WHERE chain_id=9876;']);
  return value.trim() ? JSON.parse(value) : null;
}
async function imageIDs(run = docker) {
  const result = {};
  for (const [key, tag] of Object.entries({ abci: 'app-abci:dev', mpt: 'mpt-db:dev', tendermint: 'tendermint:dev', postgres: 'postgresql:dev' })) result[key] = JSON.parse(await run(['image', 'inspect', tag]))[0].Id;
  return result;
}
const withoutPrefix = (hash) => hash.replace(/^0x/, '').toLowerCase();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const localSource = { project: 'graphene-local', tm: 'tendermint-dev', abci: 'app-abci-dev', evm: 'app-evm-dev', mpt: 'mpt-db-dev', db: 'postgresql-dev', rpc: 'http://127.0.0.1:26657' };
export async function exportBootstrap({ output, privateKey, verifyRestore, progress = console.log, source = localSource }) {
  if (typeof verifyRestore !== 'function') throw new Error('Isolated restore verification is required before publication.');
  if (source === localSource) {
    const bootstrap = await inspect(source.tm);
    const project = bootstrap.Config.Labels?.['com.docker.compose.project'];
    if (!bootstrap.State.Running || bootstrap.Config.Labels?.['com.docker.compose.service'] !== 'tendermint' || !/^[a-z0-9][a-z0-9_-]*$/.test(project || '')) throw new Error('Start the local Graphene Compose Tendermint service before export.');
    source = { ...source, project };
  }
  const initial = (await json(`${source.rpc}/status`)).result.sync_info;
  let advanced = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    await pause(1000);
    const current = (await json(`${source.rpc}/status`)).result.sync_info;
    if (!current.catching_up && BigInt(current.latest_block_height) > BigInt(initial.latest_block_height)) { advanced = true; break; }
  }
  if (!advanced) throw new Error('Reference chain is not advancing. Restore validator quorum first; no writers were stopped and no checkpoint was published.');
  const names = [source.tm, source.abci, source.evm, source.mpt].filter(Boolean);
  const records = await Promise.all(names.map((name) => inspect(name)));
  if (records.some((container) => container.Config.Labels?.['com.docker.compose.project'] !== source.project)) throw new Error('Checkpoint export requires the expected source stack.');
  const running = names.filter((_, index) => records[index].State.Running);
  if (!running.includes(source.tm) || !running.includes(source.abci)) throw new Error('Start the healthy bootstrap stack before exporting.');
  const appEnv = (await inspect(source.abci)).Config.Env || [];
  const flag = (key) => appEnv.find((entry) => entry.startsWith(key + '='))?.slice(key.length + 1);
  if (flag('GENESIS_INIT_CHAIN_OVERRIDE_VALIDATORS') === 'false' || flag('GRAPHENE_SESSION_SAVEPOINTS_REQUIRED') === 'false' || (flag('QUARKUS_PROFILE') && flag('QUARKUS_PROFILE') !== 'prod')) throw new Error('Checkpoint export supports only the matching standard local application profile.');
  const images = await imageIDs();
  for (const [name, key] of [[source.tm, 'tendermint'], [source.abci, 'abci'], [source.mpt, 'mpt']]) if ((await inspect(name)).Image !== images[key]) throw new Error('Running node images differ from local image tags; coordinate the upgrade before export.');
  const genesis = JSON.parse(await docker(['exec', source.tm, 'cat', '/tendermint/config/genesis.json']));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'graphene-checkpoint-stage-'));
  let metadata;
  // Always resume exactly the services that were running before export.
  try {
    progress('Preparing: briefly stopping bootstrap writers at a committed boundary.');
    await docker(['stop', source.tm]);
    await docker(['stop', ...running.filter((name) => name !== source.tm)]);
    metadata = sanitizeAppState(await row(source.db));
    fs.writeFileSync(path.join(stage, 'genesis.json'), canonical(genesis));
    fs.writeFileSync(path.join(stage, 'app-state.json'), canonical(metadata));
    const mpt = await volume(source.mpt, '/data');
    const tmMounts = (await inspect(source.tm)).Mounts;
    const tmVolume = tmMounts.find((mount) => mount.Type === 'volume' && mount.Destination === '/tendermint/data');
    const tmHome = tmMounts.find((mount) => mount.Type === 'bind' && mount.Destination === '/tendermint');
    const tm = tmVolume?.Name || (tmHome && path.join(tmHome.Source, 'data'));
    if (!tm) throw new Error('Expected managed Tendermint data storage.');
    await docker(['run', '--rm', '-v', `${mpt}:/source:ro`, '-v', `${stage}:/output`, 'alpine:3.20', 'tar', '-C', '/source', '-czf', '/output/mpt.tar.gz', 'db']);
    await docker(['run', '--rm', '-v', `${tm}:/source:ro`, '-v', `${stage}:/output`, 'alpine:3.20', 'tar', '-C', '/source', '-czf', '/output/tendermint.tar.gz', 'blockstore.db', 'state.db', 'evidence.db', 'tx_index.db']);
  } finally {
    await docker(['start', ...running.filter((name) => name !== source.tm)]);
    try {
      for (let attempt = 0; attempt < 45; attempt++) {
        if ((await inspect(source.abci)).State.Health?.Status === 'healthy') break;
        await pause(1000);
      }
    } finally {
      await docker(['start', source.tm]);
      const publishedPort = (await inspect(source.tm)).NetworkSettings.Ports?.['26657/tcp']?.[0];
      if (publishedPort && ['127.0.0.1', '0.0.0.0'].includes(publishedPort.HostIp)) source.rpc = `http://127.0.0.1:${publishedPort.HostPort}`;
      for (let attempt = 0; attempt < 45; attempt++) {
        try { await json(`${source.rpc}/status`); break; } catch { await pause(1000); }
      }
    }
  }
  const result = await publishCheckpoint({ inputDirectory: stage, output, privateKey, verifyRestore, source, progress });
  fs.rmSync(stage, { recursive: true, force: true });
  return result;
}

// Publish an earlier, already-captured checkpoint without pausing chain writers.
// This also permits bootstrap when the current tip has lost validator quorum:
// the checkpoint itself must still anchor to an available canonical next header.
export async function publishCheckpoint({ inputDirectory, output, privateKey, verifyRestore, source = localSource, progress = console.log }) {
  if (typeof verifyRestore !== 'function') throw new Error('Isolated restore verification is required.');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'graphene-checkpoint-stage-'));
  for (const name of artifacts) {
    const file = path.join(inputDirectory, name);
    if (!fs.statSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('Checkpoint inputs must be regular files.');
    fs.copyFileSync(file, path.join(stage, name));
  }
  const metadata = sanitizeAppState(JSON.parse(fs.readFileSync(path.join(stage, 'app-state.json'))));
  fs.writeFileSync(path.join(stage, 'app-state.json'), canonical(metadata));
  const genesis = JSON.parse(fs.readFileSync(path.join(stage, 'genesis.json')));
  const referenceGenesis = (await json(`${source.rpc}/genesis`)).result.genesis;
  if (genesisHash(genesis) !== genesisHash(referenceGenesis)) throw new Error('Snapshot genesis does not match the trusted reference chain.');
  const images = await imageIDs();
  await verifyArchive(path.join(stage, 'mpt.tar.gz'), 'mpt');
  await verifyArchive(path.join(stage, 'tendermint.tar.gz'), 'tendermint');
  const height = Number(metadata.current_height);
  let next;
  for (let attempt = 0; attempt < 45; attempt++) {
    try { next = (await json(`${source.rpc}/block?height=${height + 1}`)).result; break; } catch { await pause(1000); }
  }
  if (!next || withoutPrefix(metadata.current_app_root) !== next.block.header.app_hash.toLowerCase()) throw new Error('Exported application state does not match canonical committed history. Nothing published.');
  const block = (await json(`${source.rpc}/block?height=${height}`)).result;
  const files = {};
  for (const name of artifacts) files[name] = { bytes: fs.statSync(path.join(stage, name)).size, sha256: await fileHash(path.join(stage, name)) };
  const manifest = { format: 1, kind: 'graphene-local-checkpoint', id: `height-${height}-${crypto.randomBytes(6).toString('hex')}`, chainId: 9876, network: genesis.chain_id, genesisHash: genesisHash(genesis), height: String(height), appHash: withoutPrefix(metadata.current_app_root), blockHash: block.block_id.hash, createdAt: new Date().toISOString(), images, files };
  const trust = { chainId: 9876, genesisHash: manifest.genesisHash, publicKey: crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }), maxAgeHours: 24 };
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(signManifest(manifest, privateKey), null, 2));
  progress('Verifying: restoring into an isolated nonvoting node and checking canonical catch-up.');
  manifest.verification = await verifyRestore(stage, trust);
  verifyManifest(signManifest(manifest, privateKey), trust);
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(signManifest(manifest, privateKey), null, 2));
  const destination = path.join(output, manifest.id);
  fs.mkdirSync(output, { recursive: true });
  fs.cpSync(stage, destination + '.partial', { recursive: true, errorOnExist: true, force: false });
  fs.chmodSync(destination + '.partial', 0o755);
  for (const name of [...artifacts, 'manifest.json']) fs.chmodSync(path.join(destination + '.partial', name), 0o644);
  fs.renameSync(destination + '.partial', destination);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.copyFileSync(path.join(destination, 'manifest.json'), path.join(output, 'latest.json.tmp'));
  fs.renameSync(path.join(output, 'latest.json.tmp'), path.join(output, 'latest.json'));
  progress(`Published verified checkpoint at height ${height}.`);
  return { manifest, trust, directory: destination };
}

function identityFiles(home) {
  const files = ['config/node_key.json', 'config/priv_validator_key.json', 'config/genesis.json', 'data/priv_validator_state.json'];
  return Object.fromEntries(files.filter((name) => fs.existsSync(path.join(home, name))).map((name) => {
    const file = path.join(home, name);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Identity files must not be symbolic links.');
    return [name, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')];
  }));
}
export function assertFreshHome(home, manifest) {
  if (['state.db', 'blockstore.db', 'evidence.db', 'tx_index.db'].some((name) => fs.existsSync(path.join(home, 'data', name)))) throw new Error('Automatic checkpoint restore is only allowed on a fresh node. Existing chain data has been preserved.');
  const state = JSON.parse(fs.readFileSync(path.join(home, 'data/priv_validator_state.json')));
  if (BigInt(state.height) !== 0n) throw new Error('This node has signing history. Automatic checkpoint restore is disabled.');
  if (genesisHash(JSON.parse(fs.readFileSync(path.join(home, 'config/genesis.json')))) !== manifest.genesisHash) throw new Error('Checkpoint genesis does not match this node.');
}
// Recovery never rewinds the signer. A checkpoint at the last signed height is
// safe because Tendermint resumes consensus at the following height.
export function assertResetHome(home, manifest) {
  identityFiles(home);
  const state = JSON.parse(fs.readFileSync(path.join(home, 'data/priv_validator_state.json')));
  if (!/^\d+$/.test(state.height) || !/^\d+$/.test(manifest.height) || BigInt(manifest.height) < BigInt(state.height)) throw new Error('Checkpoint is older than this node’s signing history. Ask the provider for a newer checkpoint; signing state is preserved.');
  if (genesisHash(JSON.parse(fs.readFileSync(path.join(home, 'config/genesis.json')))) !== manifest.genesisHash) throw new Error('Checkpoint genesis does not match this node.');
}
export const restoreFresh = options => restoreCheckpoint({ ...options, resetExisting: false });
export const restoreExisting = options => restoreCheckpoint({ ...options, resetExisting: true, requireVerified: true });
async function restoreCheckpoint({ directory, manifest, trust, home, project, run = docker, progress = () => {}, requireVerified = true, resetExisting = false }) {
  const envelope = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
  const checked = verifyManifest(envelope, trust, { requireVerified });
  if (canonical(checked) !== canonical(manifest)) throw new Error('Checkpoint manifest changed before restoration.');
  if (resetExisting) assertResetHome(home, manifest);
  else assertFreshHome(home, manifest);
  const journal = path.join(home, '..', 'checkpoint-state.json');
  const previousJournal = fs.existsSync(journal) ? fs.readFileSync(journal) : null;
  if (previousJournal && (!resetExisting || JSON.parse(previousJournal).phase !== 'installed')) throw new Error('A previous checkpoint attempt needs provider inspection; no data was overwritten.');
  const protectedBefore = identityFiles(home);
  const ids = await imageIDs(run);
  if (canonical(ids) !== canonical(manifest.images)) throw new Error('Checkpoint images are incompatible. Ask the provider for matching software.');
  const containerIDs = (await run(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`])).trim().split(/\s+/).filter(Boolean);
  for (const id of containerIDs) {
    const c = await inspect(id, run);
    if (c.Config.Labels?.['com.docker.compose.project'] !== project || ((c.State.Running || c.State.Restarting || c.State.Paused) && c.Config.Labels?.['com.docker.compose.service'] !== 'db')) throw new Error('Stop the node, agent, ABCI and trie services before checkpoint restoration.');
  }
  const db = `${project}-db-1`, mpt = await volume(`${project}-mpt-1`, '/data', run);
  const previous = await row(db, run);
  if (!resetExisting && previous && Number(previous.current_height) > 0) throw new Error('Existing committed application data cannot be overwritten automatically.');
  // A missing Tendermint store is not sufficient proof that a trie is fresh.
  if (!resetExisting) {
    await run(['start', `${project}-mpt-1`]);
    try {
      for (const trie of ['state', 'blocks', 'transactions', 'receipts']) {
        let root;
        for (let attempt = 0; attempt < 30; attempt++) {
          try { root = JSON.parse(await run(['exec', `${project}-mpt-1`, 'wget', '-qO-', `http://127.0.0.1:3000/graphene-mpt/${trie}/root`])).root; break; } catch { await pause(500); }
        }
        if (root !== '') throw new Error('Existing or unreadable trie state cannot be overwritten automatically.');
      }
    } finally { await run(['stop', `${project}-mpt-1`]); }
  }
  for (const name of artifacts) if (fs.statSync(path.join(directory, name)).size !== manifest.files[name].bytes || await fileHash(path.join(directory, name)) !== manifest.files[name].sha256) throw new Error('Checkpoint files changed before restoration.');
  const metadata = sanitizeAppState(JSON.parse(fs.readFileSync(path.join(directory, 'app-state.json'))));
  if (String(metadata.current_height) !== manifest.height || withoutPrefix(metadata.current_app_root) !== manifest.appHash) throw new Error('Checkpoint application metadata does not match its manifest.');
  if (genesisHash(JSON.parse(fs.readFileSync(path.join(directory, 'genesis.json')))) !== manifest.genesisHash) throw new Error('Checkpoint artifact genesis mismatch.');
  await verifyArchive(path.join(directory, 'mpt.tar.gz'), 'mpt');
  await verifyArchive(path.join(directory, 'tendermint.tar.gz'), 'tendermint');
  const suffix = crypto.randomBytes(8).toString('hex'), stage = path.join(home, '..', `checkpoint-stage-${suffix}`);
  fs.mkdirSync(stage, { mode: 0o700 });
  const backup = path.join(home, '..', `checkpoint-backup-${suffix}`);
  fs.mkdirSync(backup, { mode: 0o700 });
  if (previousJournal) fs.writeFileSync(path.join(backup, 'checkpoint-state.json'), previousJournal, { mode: 0o600 });
  fs.writeFileSync(path.join(backup, 'app-state.json'), JSON.stringify(previous), { mode: 0o600 });
  const journalBody = JSON.stringify({ phase: 'restoring', id: manifest.id, height: manifest.height, backup, mptBackup: `checkpoint-backup-${suffix}`, previous });
  if (previousJournal) {
    fs.writeFileSync(journal + '.tmp', journalBody, { mode: 0o600 }); fs.renameSync(journal + '.tmp', journal);
  } else fs.writeFileSync(journal, journalBody, { mode: 0o600, flag: 'wx' });
  const tmNames = ['blockstore.db', 'state.db', 'evidence.db', 'tx_index.db'];
  let swapped = false, committed = false;
  const moved = [], installed = [];
  try {
    progress({ phase: 'restoring', height: manifest.height });
    await run(['run', '--rm', '-v', `${directory}:/checkpoint:ro`, '-v', `${mpt}:/target`, '-v', `${stage}:/tm`, 'alpine:3.20', 'sh', '-ec', `mkdir /target/checkpoint-stage-${suffix}; tar -xzf /checkpoint/mpt.tar.gz -C /target/checkpoint-stage-${suffix}; tar -xzf /checkpoint/tendermint.tar.gz -C /tm`]);
    swapped = true;
    await run(['run', '--rm', '-v', `${mpt}:/target`, 'alpine:3.20', 'sh', '-ec', `mv /target/db /target/checkpoint-backup-${suffix}; mv /target/checkpoint-stage-${suffix}/db /target/db`]);
    if (resetExisting) {
      for (const name of fs.readdirSync(path.join(home, 'data')).filter(name => name !== 'priv_validator_state.json')) {
        fs.renameSync(path.join(home, 'data', name), path.join(backup, name)); moved.push(name);
      }
    }
    for (const name of tmNames) { fs.renameSync(path.join(stage, name), path.join(home, 'data', name)); installed.push(name); }
    committed = true;
    await run(['exec', db, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres_username', '-d', 'grapheneDB', '-c', appStateSQL(metadata)]);
    await run(['start', `${project}-mpt-1`]);
    let root;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { root = JSON.parse(await run(['exec', `${project}-mpt-1`, 'wget', '-qO-', 'http://127.0.0.1:3000/graphene-mpt/blocks/root'])).root; break; } catch { await pause(500); }
    }
    await run(['stop', `${project}-mpt-1`]);
    if (withoutPrefix(root || '') !== manifest.appHash) throw new Error('Restored trie root does not match the signed application hash.');
    if (canonical(identityFiles(home)) !== canonical(protectedBefore)) throw new Error('Protected identity/signing files changed.');
    fs.writeFileSync(journal, JSON.stringify({ phase: 'installed', id: manifest.id, height: manifest.height, preserved: protectedBefore, backup, mptBackup: `checkpoint-backup-${suffix}`, installedAt: new Date().toISOString() }), { mode: 0o600 });
    progress({ phase: 'catching-up', height: manifest.height });
  } catch (error) {
    try {
      await run(['stop', `${project}-mpt-1`]);
      if (swapped) await run(['run', '--rm', '-v', `${mpt}:/target`, 'alpine:3.20', 'sh', '-ec', `if [ -d /target/checkpoint-backup-${suffix} ]; then rm -rf /target/db; mv /target/checkpoint-backup-${suffix} /target/db; fi`]);
      for (const name of installed) fs.rmSync(path.join(home, 'data', name), { recursive: true, force: true });
      for (const name of moved) fs.renameSync(path.join(backup, name), path.join(home, 'data', name));
      if (committed) {
        const insert = previous ? `INSERT INTO local_abci_schema.app_states SELECT * FROM json_populate_record(NULL::local_abci_schema.app_states, '${JSON.stringify(previous).replaceAll("'", "''")}'::json);` : '';
        await run(['exec', db, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres_username', '-d', 'grapheneDB', '-c', `BEGIN; DELETE FROM local_abci_schema.app_states WHERE chain_id=9876; ${insert} COMMIT;`]);
      }
      if (previousJournal) fs.writeFileSync(journal, previousJournal, { mode: 0o600 });
      else fs.unlinkSync(journal);
    } catch { throw new Error('Checkpoint restore failed; automatic rollback needs provider inspection. Services remain stopped and signing files are preserved.'); }
    throw error;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

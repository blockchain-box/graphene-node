import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { composeDefinition, bootstrapNetwork, prepareBootstrapTunnel } from './local-node-runtime.js';
import { docker, inspect, restoreFresh, json, localSource } from './checkpoint-docker.js';
import { verifyManifest } from './checkpoint-core.js';
import { archiveNames, materializePublication } from './checkpoint-storage.js';

export async function verifyRestore(directory, trust, { timeout = 900000, reference = localSource, run = docker, read = json } = {}) {
  const envelope = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
  const manifest = verifyManifest(envelope, trust, { requireVerified: false });
  const project = `grph-check-${crypto.randomBytes(8).toString('hex')}`;
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'graphene-checkpoint-test-'));
  const home = path.join(folder, 'tendermint'), file = path.join(folder, 'compose.json');
  const compose = (args) => run(['compose', '-p', project, '-f', file, ...args]);
  try {
    if (manifest.incremental && archiveNames.some(name => !fs.existsSync(path.join(directory, name)))) directory = await materializePublication(directory, manifest, path.join(folder, 'snapshot'));
    fs.mkdirSync(home, { mode: 0o700 });
    await run(['run', '--rm', '--entrypoint', 'tendermint', '-v', `${home}:/tendermint`, 'tendermint:dev', 'init', '--home', '/tendermint']);
    fs.copyFileSync(path.join(directory, 'genesis.json'), path.join(home, 'config/genesis.json'));
    const configFile = path.join(home, 'config/config.toml');
    fs.writeFileSync(configFile, fs.readFileSync(configFile, 'utf8').replace(/^addr_book_strict\s*=.*$/m, 'addr_book_strict = false'));
    const bootstrap = await inspect(reference.tm, run);
    const network = reference.tm === localSource.tm
      ? await bootstrapNetwork(bootstrap, run)
      : Object.keys(bootstrap.NetworkSettings.Networks).find((name) => name.startsWith(`${reference.project}_`));
    if (!network) throw new Error('The checkpoint reference Docker network was not found.');
    const status = (await read(`${reference.rpc}/status`)).result;
    prepareBootstrapTunnel(folder, reference.tm);
    const profile = composeDefinition(home, `${status.node_info.id}@${reference.tm}:26656`, network, { project });
    delete profile.services.agent; delete profile.volumes['agent-logs'];
    fs.writeFileSync(file, JSON.stringify(profile), { mode: 0o600 });
    await compose(['up', '-d', '--wait', '--wait-timeout', '90', 'db', 'mpt', 'abci']);
    await compose(['stop', 'abci', 'mpt']);
    await restoreFresh({ directory, manifest, trust, home, project, run, requireVerified: false });
    await compose(['up', '-d', '--wait', '--wait-timeout', '90', 'db', 'mpt', 'abci', 'node']);
    const address = (await compose(['port', 'node', '26657'])).trim();
    if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error('Verifier RPC must be local.');
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      let local;
      try { local = (await read(`http://${address}/status`)).result; }
      catch { await new Promise((resolve) => setTimeout(resolve, 1000)); continue; }
      if (BigInt(local.validator_info.voting_power) !== 0n) throw new Error('Checkpoint verifier must never be a voting validator.');
      const h = Number(local.sync_info.latest_block_height);
      if (!local.sync_info.catching_up && h > Number(manifest.height)) {
        try {
          const info = (await read(`http://${address}/abci_info`)).result.response;
          const height = Number(info.last_block_height);
          const canonical = (await read(`${reference.rpc}/block?height=${height + 1}`)).result.block.header.app_hash.toLowerCase();
          const actual = Buffer.from(info.last_block_app_hash, 'base64').toString('hex');
          if (actual !== canonical) throw new Error('Verifier committed application hash differs from canonical history.');
          return { caughtUp: true, height, appHash: actual, verifiedAt: new Date().toISOString(), nonVoting: true };
        } catch (error) { if (!/unavailable|failed/i.test(error.message)) throw error; }
        // At a stalled tip there may be no next header yet. Native Tendermint
        // has validated state through h-1 before accepting block h. Verify that
        // complete canonical block/header, without claiming the unanchored tip
        // application root has independent confirmation.
        if (h - 1 > Number(manifest.height)) {
          const localBlock = (await read(`http://${address}/block?height=${h}`)).result;
          const referenceBlock = (await read(`${reference.rpc}/block?height=${h}`)).result;
          if (localBlock.block_id.hash !== referenceBlock.block_id.hash || localBlock.block.header.app_hash !== referenceBlock.block.header.app_hash) throw new Error('Verifier tip differs from canonical block history.');
          return { caughtUp: true, height: h - 1, tipHeight: h, appHash: localBlock.block.header.app_hash.toLowerCase(), verifiedAt: new Date().toISOString(), nonVoting: true, proof: 'canonical-next-header' };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('Checkpoint verification timed out before canonical catch-up.');
  } finally {
    try { if (fs.existsSync(file)) await compose(['down', '-v', '--remove-orphans']); }
    finally { fs.rmSync(folder, { recursive: true, force: true }); }
  }
}

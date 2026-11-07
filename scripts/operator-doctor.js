#!/usr/bin/env node
// Read-only prerequisite checks. Never installs software or changes chain data.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bootstrapNetwork } from './local-node-runtime.js';

let failures = 0;
const jsonOutput=process.argv.includes('--json'),checks=[];
const note='Read-only prerequisite checks. These do not establish chain liveness or accepted votes.';
function check(label, ok, hint = '') {
  checks.push({label,ok:!!ok,hint:ok?'':hint});
  if(!jsonOutput)console.log(`${ok ? 'PASS' : 'ACTION NEEDED'}: ${label}${!ok && hint ? ` — ${hint}` : ''}`);
  if (!ok) failures++;
}
function command(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 15000, windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
}
check(`Node.js ${process.versions.node}`, Number(process.versions.node.split('.')[0]) === 24, 'Install the supported Node.js 24 LTS release from nodejs.org.');
if (!process.argv.includes('--identity-only')) {
  check('Docker Engine accessible', !!command(['version', '--format', '{{.Server.Version}}']), 'Start Docker, or ask your server provider to grant Docker access.');
  check('Docker Compose available', !!command(['compose', 'version', '--short']), 'Install the Docker Compose plugin.');
  for (const image of ['postgresql:dev', 'mpt-db:dev', 'app-abci:dev', 'tendermint:dev']) {
    check(`Local chain image ${image}`, !!command(['image', 'inspect', image, '--format', '{{.Id}}']), 'Ask your provider to prepare the local Graphene development stack.');
  }
  let bootstrapReady = false;
  let bootstrapHint = 'Start the local Graphene development stack.';
  try {
    const [bootstrap] = JSON.parse(command(['inspect', 'tendermint-dev']) || '[]');
    await bootstrapNetwork(bootstrap, async (args) => {
      const output = command(args);
      if (!output) throw new Error('Could not inspect the bootstrap Docker network.');
      return output;
    });
    bootstrapReady = true;
  } catch (error) { bootstrapHint = error.message; }
  check('Local Graphene bootstrap and network ready', bootstrapReady, bootstrapHint);
  const trustFile = process.env.GRAPHENE_CHECKPOINT_TRUST || fileURLToPath(new URL('../.checkpoints/trust.json', import.meta.url));
  let pinned = false;
  try {
    const trust = JSON.parse(fs.readFileSync(path.resolve(trustFile)));
    pinned = trust.chainId === 9876 && /^[a-f0-9]{64}$/.test(trust.genesisHash) && crypto.createPublicKey(trust.publicKey).asymmetricKeyType === 'ed25519' && typeof trust.manifestURL === 'string';
  } catch { /* Missing or invalid provider enrollment is an actionable failure. */ }
  check('Checkpoint publisher and genesis pin configured', pinned, 'Ask the provider for its trusted enrollment file and set GRAPHENE_CHECKPOINT_TRUST before launching a fresh node.');
  if(!jsonOutput)console.log('Start node verifies signature, archive integrity, compatible images and restored trie root before catching up. These prerequisite checks do not establish chain liveness or accepted votes.');
} else {
  if(!jsonOutput)console.log('Identity preparation only. This does not check or provision node services.');
}
if(jsonOutput)console.log(JSON.stringify({ok:failures===0,checks,note,checkedAt:new Date().toISOString()}));
process.exitCode = failures ? 1 : 0;

import fs from 'node:fs';
import path from 'node:path';
import { atomicJSON, canonical, loadProfile, networkIdentity } from '../agents/lib/update-contracts.js';
import { genesisHash } from './checkpoint-core.js';

// The current launcher provisions development 9876 only. Other environments
// can use the standalone staging worker, but cannot silently reuse this stack.
export function bindLocalUpdates({ profileFile, folder, genesis, role }) {
  const profile = loadProfile(profileFile);
  if (profile.environment !== 'local' || profile.chainId !== 9876) throw new Error('The local development runtime cannot provision a test or production network.');
  if (profile.role !== role || profile.tendermintChainId !== genesis.chain_id || profile.genesisHash !== genesisHash(genesis)) {
    throw new Error('Update profile does not match this node role or pinned chain genesis.');
  }
  const bindingFile = path.join(folder, 'update-network.json');
  const binding = { ...networkIdentity(profile), role };
  if (fs.existsSync(bindingFile) && canonical(JSON.parse(fs.readFileSync(bindingFile))) !== canonical(binding)) {
    throw new Error('This node already has a different update network binding. Network changes require a separate node.');
  }
  atomicJSON(bindingFile, binding);
  const snapshot = path.join(folder, 'update-profile.json');
  atomicJSON(snapshot, profile);
  const directory = path.join(folder, 'updates');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return { profileFile: snapshot, directory };
}

export function configureAgentUpdates(service, binding) {
  if (!binding) return;
  service.environment.GRAPHENE_UPDATE_PROFILE = '/app/update-profile.json';
  service.environment.GRAPHENE_UPDATE_DIRECTORY = '/app/update-state';
  service.volumes = service.volumes.filter(mount => !mount.endsWith(':/app/update-profile.json:ro') && !mount.endsWith(':/app/update-state'));
  service.volumes.push(`${binding.profileFile}:/app/update-profile.json:ro`, `${binding.directory}:/app/update-state`);
}

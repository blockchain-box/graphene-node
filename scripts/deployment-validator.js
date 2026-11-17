#!/usr/bin/env node
// Fresh-chain home validator setup belongs to graphene-node. Cloud deployment
// receives only public.json; the home operator installs the agreed runtime bundle.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {initializeValidator, installValidatorFiles as installHostFiles, writeValidatorReceipt} from '../agents/lib/validator-files.js';
import { homePlatform, macDocker, checkMacImages, macOwnership } from './deployment-host.js';

export const checkpointInstallProtocol = 1;
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function requireValue(condition, message) { if (!condition) throw new Error(message); }
function write(file, content, flag = 'w') {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2)+'\n', { mode: 0o600, flag });
}

export {initializeValidator, writeValidatorReceipt};
export function installValidatorFiles(directory, bundle) {
  return installHostFiles(directory, bundle, {allowGenesis:true});
}

function run(binary, args, directory) {
  const result = spawnSync(binary, args, { cwd: directory, stdio: 'inherit' });
  requireValue(!result.error && result.status === 0, 'Command failed: '+binary);
}

export function installValidator(directory, bundle, { deferStart = false } = {}) {
  if (deferStart) {
    const state=read(path.join(directory,'identity/tendermint/data/priv_validator_state.json'));
    requireValue(String(state.height)==='0' && Number(state.round)===0 && Number(state.step)===0, 'Checkpoint installation requires a fresh unsigned validator');
    requireValue(!['state.db','blockstore.db','evidence.db','tx_index.db'].some(name=>fs.existsSync(path.join(directory,'identity/tendermint/data',name))) && !fs.existsSync(path.join(directory,'data/abci-postgres')), 'Existing chain data cannot be replaced by checkpoint installation');
  }
  const host = homePlatform(process.platform, process.arch, process.platform === 'linux' ? fs.readFileSync('/etc/os-release','utf8') : '');
  if (host === 'macos') {
    const docker = macDocker();
    checkMacImages(read(path.join(bundle,'compose.json')),docker,bundle);
    const identity = installValidatorFiles(directory,bundle);
    if (deferStart) write(path.join(directory,'.rollout-fence.json'),{kind:'snapshot-bootstrap-pending',networkId:read(path.join(directory,'network.json')).network_id}, 'wx');
    if (process.getuid() === 0) macOwnership(directory,Number(process.env.SUDO_UID),Number(process.env.SUDO_GID));
    try {
      const multiple = read(path.join(bundle,'identity/tendermint/config/genesis.json')).validators.length > 1 || fs.existsSync(path.join(bundle,'validator-admission.json'));
      if (!deferStart) docker(['compose','-f','compose.json','up','-d',...(multiple ? [] : ['--wait','--wait-timeout','600'])],directory);
    } catch (error) {
      throw new Error(error.message+' Keep Docker Desktop running and share '+directory+' in its File sharing settings.');
    }
    if (deferStart) { console.log('Validator runtime prepared; consensus remains stopped for checkpoint restoration.'); return identity; }
    console.log('Home validator started through Docker Desktop. Keep the Mac awake and Docker Desktop running. The existing Compose restart policies resume services when Docker Desktop starts.');
    console.log('Copy this public installation receipt to the controller: '+writeValidatorReceipt(directory));
    return identity;
  }
  requireValue(process.getuid() === 0, 'Run install locally on the home host with sudo');
  requireValue(/^\/[a-zA-Z0-9/._-]+$/.test(directory) && path.normalize(directory) === directory && directory !== '/', 'Use an absolute home directory without whitespace or shell syntax');
  const identity = installValidatorFiles(directory, bundle);
  if (deferStart) write(path.join(directory,'.rollout-fence.json'),{kind:'snapshot-bootstrap-pending',networkId:read(path.join(directory,'network.json')).network_id}, 'wx');
  run('apt-get', ['update']);
  run('apt-get', ['install', '-y', 'docker.io', 'docker-compose-v2']);
  run('systemctl', ['enable', '--now', 'docker']);
  run('docker', ['compose', '-f', 'compose.json', 'pull'], directory);
  const name = read(path.join(directory,'compose.json')).name+'.service';
  const unit = '[Unit]\nAfter=docker.service network-online.target\nRequires=docker.service\nRequiresMountsFor='+directory+'/data '+directory+'/identity\n[Service]\nType=oneshot\nRemainAfterExit=yes\nWorkingDirectory='+directory+'\nExecStartPre=/usr/bin/test -s '+directory+'/identity/tendermint/data/priv_validator_state.json\nExecStartPre=/usr/bin/test ! -e '+directory+'/.rollout-fence.json\nExecStart=/usr/bin/docker compose -f compose.json up -d\nExecStop=/usr/bin/docker compose -f compose.json stop\n[Install]\nWantedBy=multi-user.target\n';
  fs.writeFileSync('/etc/systemd/system/'+name, unit, { mode: 0o644 });
  run('systemctl', ['daemon-reload']);
  run('systemctl', deferStart ? ['enable', name] : ['enable', '--now', name]);
  const multiple = read(path.join(bundle,'identity/tendermint/config/genesis.json')).validators.length > 1 || fs.existsSync(path.join(bundle,'validator-admission.json'));
  if (!deferStart) run('docker', ['compose', '-f', 'compose.json', 'up', '-d', ...(multiple ? [] : ['--wait', '--wait-timeout', '600'])], directory);
  if (deferStart) { console.log('Validator runtime prepared; consensus remains stopped for checkpoint restoration.'); return identity; }
  console.log('Home validator started. Copy this public installation receipt to the controller: '+writeValidatorReceipt(directory));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.umask(0o077);
  const [action, suppliedDirectory, ...args] = process.argv.slice(2);
  const directory = suppliedDirectory || process.env.GRAPHENE_HOME_DIRECTORY;
  try {
    if (process.env.GRAPHENE_EXPECTED_STAGE) requireValue(process.env.GRAPHENE_EXPECTED_STAGE === process.env.GRAPHENE_STAGE, 'Env stage does not match the selected stage');
    if (action === 'init') {
      initializeValidator(directory, args[0] || process.env.GRAPHENE_STAGE, args[1] || process.env.GRAPHENE_CHAIN_ID, args[2] || process.env.GRAPHENE_OPERATOR_ADDRESS);
      console.log('Home identity created. Export only '+path.join(directory, 'public.json')+' to grph-deployment.');
    } else if (action === 'install') {
      const bundle = args[0] || process.env.GRAPHENE_SETUP_BUNDLE;
      requireValue(directory, 'GRAPHENE_HOME_DIRECTORY is empty. Set it in config/deployment/<stage>.env to the initialized home validator directory.');
      requireValue(bundle, 'GRAPHENE_SETUP_BUNDLE is empty. In Stage setup, prepare and download the Home bundle, extract it on this home host, then set GRAPHENE_SETUP_BUNDLE to that absolute folder in config/deployment/<stage>.env, or run ./deploy-validator.sh <stage> install /absolute/path/to/extracted-bundle.');
      requireValue(path.isAbsolute(bundle), 'Use an absolute bundle directory. GRAPHENE_SETUP_BUNDLE does not expand ~ or $HOME.');
      requireValue(fs.existsSync(path.join(bundle, 'compose.json')) && fs.existsSync(path.join(bundle, 'network.json')), 'Bundle directory must contain compose.json and network.json. Extract the downloaded Home bundle and choose its folder, not the ZIP file.');
      if (process.env.GRAPHENE_EXPECTED_STAGE) {
        const identity = read(path.join(directory, 'public.json'));
        requireValue(identity.stage === process.env.GRAPHENE_EXPECTED_STAGE && identity.chain_id === Number(process.env.GRAPHENE_CHAIN_ID), 'Home identity does not match the selected env stage/chain');
      }
      installValidator(path.resolve(directory), path.resolve(bundle), { deferStart: args.includes('--defer-start') });
    } else throw new Error('Usage: deployment-validator.js init HOME_DIRECTORY STAGE CHAIN_ID OPERATOR_ADDRESS | install HOME_DIRECTORY BUNDLE_DIRECTORY');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fetchCheckpoint, genesisHash } from './checkpoint-core.js';
import { restoreFresh, restoreExisting, assertResetHome } from './checkpoint-docker.js';
import { loadTunnelSeed, tunnelPublicKey, dhtBootstrap } from '../agents/lib/grph-tunnel.js';
import { bindLocalUpdates, configureAgentUpdates } from './update-runtime.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const rpc = 'http://127.0.0.1:3003/graphene-evm';
const tm = 'http://127.0.0.1:26657';
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
async function json(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('The local chain is unavailable. Start the local Graphene development stack first.');
  return res.json();
}
export async function bootstrapNetwork(bootstrap, run) {
  const labels = bootstrap?.Config?.Labels || {};
  const project = labels['com.docker.compose.project'];
  if (!bootstrap?.State?.Running || labels['com.docker.compose.service'] !== 'tendermint'
    || typeof project !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(project)) {
    throw new Error('Start the local Graphene development stack: tendermint-dev must be a running Compose Tendermint service.');
  }
  const matches = [];
  for (const name of Object.keys(bootstrap.NetworkSettings?.Networks || {})) {
    const [network] = JSON.parse(await run(['network', 'inspect', name]));
    if (network?.Name === name && network.Labels?.['com.docker.compose.project'] === project
      && network.Labels?.['com.docker.compose.network'] === 'graphene-net-dev') matches.push(name);
  }
  if (matches.length !== 1) throw new Error(`Expected one Graphene development network owned by Compose project "${project}"; found ${matches.length}.`);
  return matches[0];
}

export function verifyRegistration(record, setup, wallet) {
  if (!record?.registered || !same(record.wallet, wallet) || !same(record.agentAddress, setup.agentAddress)
    || !same(record.nodeId, setup.nodeId) || record.networkPublicKey !== setup.consensusPublicKey
    || !same((record.encryptionPublicKey || '').replace(/^0x/, ''), setup.encryptionPublicKey.replace(/^0x/, ''))) {
    throw new Error('This unlocked identity does not match the wallet’s registered validator. Reopen its original setup file.');
  }
}
export function verifySentryRegistration(record, setup, wallet) {
  if (!record?.active || !same(record.operator, wallet) || !same(record.sentryId, setup.agentAddress)
    || !same(record.tendermintNodeId, setup.nodeId)
    || !same((record.encryptionPublicKey || '').replace(/^0x/, ''), setup.encryptionPublicKey.replace(/^0x/, ''))
    || record.p2pHost !== setup.p2pHost || Number(record.p2pPort) !== Number(setup.p2pPort)) {
    throw new Error('This identity or endpoint does not match the wallet’s registered sentry. Unlock its original sentry keystore.');
  }
}
export function installIdentity(home, secrets, genesis, role = 'validator') {
  const config = path.join(home, 'config');
  const data = path.join(home, 'data');
  fs.mkdirSync(config, { recursive: true, mode: 0o700 });
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  const files = {
    'node_key.json': { priv_key: secrets.tendermint.node.privateKey },
    ...(role === 'validator' ? { 'priv_validator_key.json': { address: secrets.tendermint.validator.address, pub_key: secrets.tendermint.validator.publicKey, priv_key: secrets.tendermint.validator.privateKey } } : {}),
    'genesis.json': genesis,
  };
  for (const [name, value] of Object.entries(files)) {
    const target = path.join(config, name);
    if (fs.existsSync(target)) {
      if (JSON.stringify(JSON.parse(fs.readFileSync(target))) !== JSON.stringify(value)) throw new Error('Saved node identity or genesis differs. Existing signing files have been preserved.');
    } else fs.writeFileSync(target, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    fs.chmodSync(target, 0o600);
  }
  const state = path.join(data, 'priv_validator_state.json');
  if (!fs.existsSync(state)) fs.writeFileSync(state, JSON.stringify({ height: '0', round: 0, step: 0 }), { flag: 'wx', mode: 0o600 });
}
// All Compose callers must prepare these bind-mounted files before startup.
export function prepareBootstrapTunnel(folder, host, port = 26656) {
  const seed = loadTunnelSeed(path.join(folder, 'bootstrap-seed.json'));
  const bootstrap = dhtBootstrap();
  fs.writeFileSync(path.join(folder, 'bootstrap-source.json'), JSON.stringify({ seed, host, port, bootstrap }), { mode: 0o600 });
  fs.writeFileSync(path.join(folder, 'bootstrap-client.json'), JSON.stringify({ key: tunnelPublicKey(seed), bootstrap }), { mode: 0o600 });
}

export function configureMptAuth(profile) {
  const mpt = profile.services.mpt.environment;
  const abci = profile.services.abci.environment;
  const token = mpt.MPT_DB_API_TOKEN || abci.MPT_DB_API_TOKEN || crypto.randomBytes(32).toString('hex');
  mpt.MPT_DB_API_TOKEN = token;
  abci.MPT_DB_API_TOKEN = token;
}

export function composeDefinition(home, peer, network, options = {}) {
  const project = options.project || path.basename(path.dirname(home));
  // Nodes and the tunnel share only this project's default network. The short
  // service alias also avoids Docker DNS's 63-character hostname limit.
  const tunnelPeer = `${peer.split('@')[0]}@bootstrap-tunnel:26656`;
  const tunnelImage = `graphene-${options.role === 'sentry' ? 'sentry' : 'validator'}-agent:local`;
  const tunnelHealth = { interval: '3s', timeout: '5s', retries: 40, start_period: '10s', test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:3001').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"] };
  const health = { interval: '3s', timeout: '15s', retries: 40, start_period: '10s' };
  const dbEnv = { POSTGRES_USER: 'postgres_username', POSTGRES_PASSWORD: crypto.randomBytes(24).toString('hex'), POSTGRES_DB: 'grapheneDB', APP_ABCI_DB_USER: 'abci_user', APP_ABCI_DB_PASSWORD: 'abci_password', APP_ABCI_DB_SCHEMA: 'local_abci_schema', APP_EVM_DB_USER: 'evm_user', APP_EVM_DB_PASSWORD: 'evm_password', APP_EVM_DB_SCHEMA: 'local_evm_schema' };
  const definition = {
    services: {
      'bootstrap-source': { image: tunnelImage, entrypoint: ['node', 'agents/lib/p2p-service.js', 'server', '/app/p2p/config.json'], volumes: [`${path.resolve(home, '..', 'bootstrap-source.json')}:/app/p2p/config.json:ro`], networks: ['bootstrap', 'default'], healthcheck: tunnelHealth, extra_hosts: ['host.docker.internal:host-gateway'], restart: 'unless-stopped' },
      'bootstrap-tunnel': { image: tunnelImage, entrypoint: ['node', 'agents/lib/p2p-service.js', 'client', '/app/p2p/config.json'], volumes: [`${path.resolve(home, '..', 'bootstrap-client.json')}:/app/p2p/config.json:ro`], networks: ['default'], depends_on: { 'bootstrap-source': { condition: 'service_healthy' } }, healthcheck: tunnelHealth, extra_hosts: ['host.docker.internal:host-gateway'], restart: 'unless-stopped' },
      db: { image: 'postgresql:dev', environment: dbEnv, volumes: ['postgres:/var/lib/postgresql'], healthcheck: { ...health, test: ['CMD', 'pg_isready', '-U', dbEnv.POSTGRES_USER, '-d', 'grapheneDB'] } },
      mpt: { image: 'mpt-db:dev', environment: { MPT_DB_DATA_DIR: '/data/db', MPT_DB_LOG_LEVEL: 'error' }, volumes: ['mpt:/data'], healthcheck: { ...health, test: ['CMD-SHELL', 'wget -qO- http://127.0.0.1:3000/graphene-mpt/health/ready | grep -q UP'] } },
      abci: { image: 'app-abci:dev', environment: { TENDERMINT_HOST: 'node', APP_ABCI_HOST: 'abci', MPT_DB_HOST: 'mpt', POSTGRESSQL_DB_HOST: 'db', APP_ABCI_DB_USER: 'abci_user', APP_ABCI_DB_PASSWORD: 'abci_password', APP_ABCI_DB_SCHEMA: 'local_abci_schema', CHAIN_ID: '9876', COIN_SYMBOL: 'GRPH', QUARKUS_LOG_LEVEL: 'WARN' }, depends_on: { db: { condition: 'service_healthy' }, mpt: { condition: 'service_healthy' } }, healthcheck: { ...health, test: ['CMD', '/deployments/healthcheck.sh'] } },
      node: { labels: { 'com.graphene.launcher.home': home, 'com.graphene.launcher.role': options.role || 'validator' }, image: 'tendermint:dev', entrypoint: ['tendermint'], command: ['node', '--home', '/tendermint', '--proxy_app', 'tcp://abci:26658', '--rpc.laddr', 'tcp://0.0.0.0:26657', '--p2p.persistent_peers', tunnelPeer, '--p2p.seeds=', '--p2p.pex=false', '--log_level', 'error'], volumes: [`${home}:/tendermint`], ports: ['127.0.0.1::26657', '127.0.0.1::26656'], networks: ['default'], depends_on: { abci: { condition: 'service_healthy' }, 'bootstrap-tunnel': { condition: 'service_healthy' } } },
    },
    volumes: { postgres: {}, mpt: {} },
    networks: { default: {}, bootstrap: { external: true, name: network } },
  };
  if (options.role === 'sentry') {
    definition.services.node.command.push('--rpc.unsafe=true');
    definition.services.node.ports[1] = `127.0.0.1:${options.p2pPort}:26656`;
    definition.services.agent = {
      image: 'graphene-sentry-agent:local',
      environment: { RPC_URL: 'http://host.docker.internal:3003/graphene-evm/rpc', GRAPHENE_DHT_BOOTSTRAP: process.env.GRAPHENE_DHT_BOOTSTRAP || '',
        SECRETS_PATH: '/app/secrets/sentry-secrets.json', KEYSTORE_PASSPHRASE: '${GRAPHENE_NODE_PASSWORD:-}',
        TENDERMINT_RPC_URL: `http://${path.basename(path.dirname(home))}-node-1:26657`, PROXY_HOST: '0.0.0.0', PEER_HOST: `${path.basename(path.dirname(home))}-agent-1`,
        STATE_PATH: '/app/state', STATE_DIR: '/app/state', LOG_PATH: '/app/logs/sentry-agent.log',
        PORT_RANGE_START: '40001', PORT_RANGE_END: '40999', HEALTH_PORT: '3001' },
      volumes: [`${options.secretsPath}:/app/secrets/sentry-secrets.json:ro`, 'agent-state:/app/state', 'agent-logs:/app/logs'],
      networks: ['default'], ports: ['127.0.0.1::3001'], extra_hosts: ['host.docker.internal:host-gateway'],
      depends_on: { node: { condition: 'service_started' } },
    };
    definition.volumes['agent-state'] = {};
    definition.volumes['agent-logs'] = {};
  }
  else {
    definition.services.agent = {
      image: 'graphene-validator-agent:local',
      environment: { RPC_URL: 'http://host.docker.internal:3003/graphene-evm/rpc', GRAPHENE_DHT_BOOTSTRAP: process.env.GRAPHENE_DHT_BOOTSTRAP || '',
        KEYSTORE_PATH: '/app/secrets/keystore.enc', KEYSTORE_PASSPHRASE: '${GRAPHENE_NODE_PASSWORD:-}',
        CONTRACT_ADDRESS: '0x0000000000000000000000000000000000000004',
        MANAGE_TENDERMINT: 'false', MANAGE_PEERS: 'false', AGENT_HOST: `${path.basename(path.dirname(home))}-node-1`, AGENT_PORT: '26656',
        STATE_DIR: '/app/state', HEALTH_PORT: '3001' },
      volumes: [`${options.secretsPath}:/app/secrets/keystore.enc:ro`, `${path.resolve(home, '..', 'agent-state')}:/app/state`, 'agent-logs:/app/logs'],
      networks: ['default'], ports: ['127.0.0.1::3001'], extra_hosts: ['host.docker.internal:host-gateway'],
      depends_on: { node: { condition: 'service_started' } },
    };
    definition.volumes['agent-logs'] = {};
  }
  // Nodes can share an external bootstrap network. Service aliases such as
  // "abci"/"node" may identify a different project on that network.
  definition.services.node.command[definition.services.node.command.indexOf('--proxy_app') + 1] = `tcp://${project}-abci-1:26658`;
  Object.assign(definition.services.abci.environment, { TENDERMINT_HOST: `${project}-node-1`, APP_ABCI_HOST: `${project}-abci-1`, MPT_DB_HOST: `${project}-mpt-1`, POSTGRESSQL_DB_HOST: `${project}-db-1` });
  configureMptAuth(definition);
  return definition;
}

// A deliberately fixed local development profile: browser input never selects executables,
// Compose files, images, networks, remote URLs, environment values or filesystem paths.
export class LocalNodeRuntime {
  constructor({ directory, checkpointCacheDirectory = path.join(directory, 'checkpoint-cache'), read = json, checkpointTrustFile = process.env.GRAPHENE_CHECKPOINT_TRUST || path.join(root, '.checkpoints/trust.json'), updateProfileFile = process.env.GRAPHENE_UPDATE_PROFILE, run = async (args, options = {}) => (await exec('docker', args, { timeout: 180000, maxBuffer: 256 * 1024, ...options })).stdout } = {}) {
    this.directory = directory;
    this.checkpointCacheDirectory = checkpointCacheDirectory;
    this.read = read;
    this.run = run;
    this.identity = null;
    this.state = 'locked';
    this.verifiedStopped = false;
    this.error = null;
    this.operation = false;
    this.checkpointTrustFile = checkpointTrustFile;
    this.checkpoint = null;
    this.updateProfileFile = updateProfileFile;
  }
  unlock(identity) {
    if (this.identity && this.identity.setup.agentAddress !== identity.setup.agentAddress) throw new Error('Stop and restart the launcher before changing node identities.');
    this.identity = identity;
    this.project = `grph-node-${identity.setup.agentAddress.slice(2).toLowerCase()}`;
    this.folder = path.join(this.directory, 'runtime', this.project);
    this.file = path.join(this.folder, 'compose.json');
    if (this.state === 'locked') this.state = 'stopped';
  }
  requiresCheckpoint() {
    if (!this.folder) return true;
    const data = path.join(this.folder, 'tendermint/data');
    return !['state.db', 'blockstore.db'].some(name => fs.existsSync(path.join(data, name)));
  }
  async checkpointNetwork() {
    const saved = this.folder && path.join(this.folder, 'tendermint/config/genesis.json');
    const genesis = saved && fs.existsSync(saved) ? JSON.parse(fs.readFileSync(saved)) : (await this.read(`${tm}/genesis`)).result.genesis;
    return genesisHash(genesis);
  }
  async checkpointSource({ confirmServing = false } = {}) {
    if (!this.identity || this.operation) throw new Error('Unlock the source node and wait for its current operation to finish.');
    const status = await this.status();
    if (status.state !== 'running' || String(status.votingPower) !== '0') throw new Error('Choose a synchronized, nonvoting source node. Voting nodes cannot be paused for checkpoints.');
    let activeValidatorCount = 0;
    if (this.identity.setup.role === 'sentry') {
      const assignments = await this.read(`${rpc}/graphene/state/platform/assignments?sentryId=${this.identity.setup.agentAddress.toLowerCase()}`);
      if (!Array.isArray(assignments)) throw new Error('Sentry assignments could not be verified. Refresh and try again.');
      activeValidatorCount = assignments.filter(assignment => String(assignment.status).toLowerCase() === 'active' && (!assignment.sentryId || assignment.sentryId.toLowerCase() === this.identity.setup.agentAddress.toLowerCase())).length;
      if (activeValidatorCount > 0 && confirmServing !== true) throw new Error('Confirm that checkpoint capture will pause this serving sentry and interrupt its validator connections.');
    }
    const address = (await this.compose(['port', 'node', '26657'])).trim();
    if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error('The source node RPC must be a managed loopback endpoint.');
    const rpcURL = `http://${address}`;
    const [live, sourceGenesis, referenceGenesis] = await Promise.all([json(rpcURL + '/status'), json(rpcURL + '/genesis'), this.read(`${tm}/genesis`)]);
    if (live.result.sync_info.catching_up || String(live.result.validator_info?.voting_power) !== '0') throw new Error('The source is catching up or voting. Choose another node.');
    if (genesisHash(sourceGenesis.result.genesis) !== genesisHash(referenceGenesis.result.genesis)) throw new Error('The source node belongs to a different network.');
    return { project: this.project, tm: `${this.project}-node-1`, abci: `${this.project}-abci-1`, mpt: `${this.project}-mpt-1`, db: `${this.project}-db-1`, rpc: rpcURL, agentAddress: this.identity.setup.agentAddress, role: this.identity.setup.role, activeValidatorCount };
  }
  async start(wallet, { resetCheckpoint = false, checkpointTrustFile } = {}) {
    if (!this.identity) throw new Error('Unlock your node identity in the local launcher first.');
    if (this.operation) throw new Error('A node operation is already in progress.');
    this.operation = true;
    this.verifiedStopped = false;
    this.state = 'starting'; this.error = null;
    try {
      const { setup, secrets } = this.identity;
      if (setup.role === 'sentry') {
        const sentries = await this.read(`${rpc}/graphene/state/platform/sentries`);
        verifySentryRegistration(sentries.find((sentry) => same(sentry.sentryId, setup.agentAddress)), setup, wallet);
      } else {
        const record = await this.read(`${rpc}/graphene/state/platform/validators/${wallet}`);
        verifyRegistration(record, setup, wallet);
      }
      const [{ result: status }, { result: genesisResponse }] = await Promise.all([this.read(`${tm}/status`), this.read(`${tm}/genesis`)]);
      const genesis = genesisResponse.genesis;
      if (genesis.chain_id !== status.node_info.network) throw new Error('Local chain genesis does not match its network.');
      const updateBinding = this.updateProfileFile ? bindLocalUpdates({ profileFile: this.updateProfileFile, folder: this.folder, genesis, role: setup.role }) : null;
      const bootstrap = JSON.parse(await this.run(['inspect', 'tendermint-dev']))[0];
      const network = await bootstrapNetwork(bootstrap, this.run);
      for (const image of ['postgresql:dev', 'mpt-db:dev', 'app-abci:dev', 'tendermint:dev']) await this.run(['image', 'inspect', image]);
      const home = path.join(this.folder, 'tendermint');
      const existing = (await this.run(['ps', '-aq', '--filter', `label=com.docker.compose.project=${this.project}`, '--filter', 'label=com.docker.compose.service=node'])).trim();
      if (existing) {
        const containers = JSON.parse(await this.run(['inspect', ...existing.split(/\s+/)]));
        if (containers.some((container) => container.Config.Labels['com.graphene.launcher.home'] !== home || (container.Config.Labels['com.graphene.launcher.role'] || 'validator') !== setup.role)) throw new Error('This identity is already deployed from another directory. Use its original launcher and signing state.');
      }
      if (resetCheckpoint) {
        if (!fs.existsSync(this.file) || !fs.existsSync(path.join(home, 'data/priv_validator_state.json'))) throw new Error('Reset requires an existing saved node. Use Start node for a fresh node.');
        const ids = (await this.run(['ps', '-aq', '--filter', `label=com.docker.compose.project=${this.project}`])).trim().split(/\s+/).filter(Boolean);
        for (const id of ids) {
          const [container] = JSON.parse(await this.run(['inspect', id]));
          if (container.Config.Labels?.['com.docker.compose.project'] !== this.project || ((container.State.Running || container.State.Restarting || container.State.Paused) && container.Config.Labels?.['com.docker.compose.service'] !== 'db')) throw new Error('Stop this node and its services before resetting from a checkpoint.');
        }
      }
      installIdentity(home, secrets, genesis, setup.role);
      this.claimLauncher();
      prepareBootstrapTunnel(this.folder, 'tendermint-dev');
      if (!fs.existsSync(path.join(home, 'config', 'config.toml'))) {
        await this.run(['run', '--rm', '--entrypoint', 'tendermint', '-v', `${home}:/tendermint`, 'tendermint:dev', 'init', '--home', '/tendermint']);
      }
      const configPath = path.join(home, 'config', 'config.toml');
      fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8').replace(/^addr_book_strict\s*=.*$/m, 'addr_book_strict = false'), { mode: 0o600 });
      // Do not allow the image's initializer to replace preinstalled signing keys.
      installIdentity(home, secrets, genesis, setup.role);
      const desired = composeDefinition(home, `${status.node_info.id}@tendermint-dev:26656`, network, { role: setup.role, secretsPath: this.identity.keystorePath, p2pPort: setup.p2pPort });
      if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, JSON.stringify(desired, null, 2), { flag: 'wx', mode: 0o600 });
      const existingProfile = JSON.parse(fs.readFileSync(this.file));
      // Persist one shared token, including when upgrading a pre-auth profile.
      configureMptAuth(existingProfile);
      const proxy = existingProfile.services.node.command.indexOf('--proxy_app') + 1;
      if (proxy > 0 && existingProfile.services.node.command[proxy] === 'tcp://abci:26658') {
        existingProfile.services.node.command[proxy] = desired.services.node.command[proxy];
        for (const field of ['TENDERMINT_HOST', 'APP_ABCI_HOST', 'MPT_DB_HOST', 'POSTGRESSQL_DB_HOST']) existingProfile.services.abci.environment[field] = desired.services.abci.environment[field];
        fs.writeFileSync(this.file, JSON.stringify(existingProfile, null, 2), { mode: 0o600 });
      }
      if (!existingProfile.services.agent) {
        if (setup.role !== 'validator') throw new Error('This identity already has a validator deployment. Use the sentry’s separate registered identity.');
        // Upgrade only the agent service; leave DB credentials, keys, chain volumes
        // and Tendermint service configuration exactly as deployed.
        existingProfile.services.agent = desired.services.agent;
        existingProfile.volumes['agent-logs'] = {};
        fs.writeFileSync(this.file, JSON.stringify(existingProfile, null, 2), { mode: 0o600 });
      }
      for (const field of ['TENDERMINT_RPC_URL', 'AGENT_HOST']) {
        if (desired.services.agent.environment[field] && existingProfile.services.agent.environment[field] !== desired.services.agent.environment[field]) {
          existingProfile.services.agent.environment[field] = desired.services.agent.environment[field];
          fs.writeFileSync(this.file, JSON.stringify(existingProfile, null, 2), { mode: 0o600 });
        }
      }
      // Upgrade transport only. Keep DB credentials, consensus keys, signing state and volumes.
      for (const service of ['bootstrap-source', 'bootstrap-tunnel']) existingProfile.services[service] = desired.services[service];
      const peerFlag = existingProfile.services.node.command.indexOf('--p2p.persistent_peers');
      if (peerFlag >= 0) existingProfile.services.node.command[peerFlag + 1] = desired.services.node.command[desired.services.node.command.indexOf('--p2p.persistent_peers') + 1];
      else existingProfile.services.node.command.push('--p2p.persistent_peers', desired.services.node.command[desired.services.node.command.indexOf('--p2p.persistent_peers') + 1]);
      existingProfile.services.node.command = existingProfile.services.node.command.filter(arg => !arg.startsWith('--p2p.seeds='));
      existingProfile.services.node.command.push('--p2p.seeds=');
      existingProfile.services.node.networks = ['default'];
      existingProfile.services.node.depends_on = { ...existingProfile.services.node.depends_on, 'bootstrap-tunnel': { condition: 'service_healthy' } };
      existingProfile.services.agent.networks = ['default'];
      delete existingProfile.services.agent.environment.LOCAL_DOCKER_PEERS;
      if (setup.role === 'sentry') existingProfile.services.agent.environment.PEER_HOST = desired.services.agent.environment.PEER_HOST;
      configureAgentUpdates(existingProfile.services.agent, updateBinding);
      fs.writeFileSync(this.file, JSON.stringify(existingProfile, null, 2), { mode: 0o600 });
      if (setup.role === 'validator') fs.mkdirSync(path.join(this.folder, 'agent-state'), { recursive: true, mode: 0o700 });
      await this.bootstrapCheckpoint(home, resetCheckpoint, checkpointTrustFile);
      const role = setup.role === 'sentry' ? 'sentry' : 'validator';
      await this.run(['build', '-t', `graphene-${role}-agent:local`, '-f', path.join(root, `agents/${role}-agent/Dockerfile`), root], { timeout: 600000 });
      await this.compose(['up', '-d', '--wait', '--wait-timeout', '150']);
      const p2p = (await this.compose(['port', 'node', '26656'])).trim();
      if (!/^127\.0\.0\.1:\d+$/.test(p2p)) throw new Error('The local node P2P port is unavailable.');
      this.p2pPort = Number(p2p.split(':')[1]);
      this.state = 'running';
    } catch (error) {
      this.state = 'error';
      if (this.checkpoint) this.checkpoint = { ...this.checkpoint, phase: 'error' };
      // Docker stderr can contain deployment configuration. Keep it out of the browser.
      this.error = error.code ? 'Docker could not start the node. Check Docker and the local chain; inspect the node services in Docker.' : error.message;
      throw new Error(this.error);
    } finally { this.operation = false; }
  }
  async bootstrapCheckpoint(home, resetExisting = false, selectedTrustFile = this.checkpointTrustFile) {
    const journal = path.join(this.folder, 'checkpoint-state.json');
    if (fs.existsSync(journal)) {
      const previous = JSON.parse(fs.readFileSync(journal));
      if (previous.phase !== 'installed') throw new Error('An interrupted checkpoint restore needs provider inspection. Existing signing files are preserved.');
      this.checkpoint = { phase: 'catching-up', height: previous.height };
    }
    // Ordinary Start resumes saved data; only explicit recovery replaces it.
    if (!resetExisting && (fs.existsSync(path.join(home, 'data/state.db')) || fs.existsSync(path.join(home, 'data/blockstore.db')))) return;
    if (!resetExisting && BigInt(JSON.parse(fs.readFileSync(path.join(home, 'data/priv_validator_state.json'))).height) !== 0n) throw new Error('Signing history exists. Ask your provider to recover the original chain data.');
    if (!selectedTrustFile || !fs.existsSync(selectedTrustFile)) throw new Error('Choose an enrolled checkpoint source before starting this node. Existing nodes are unaffected.');
    this.checkpoint = { phase: 'preparing' };
    const trust = JSON.parse(fs.readFileSync(selectedTrustFile));
    if (trust.genesisHash !== genesisHash(JSON.parse(fs.readFileSync(path.join(home, 'config/genesis.json'))))) {
      throw new Error('The checkpoint trust configuration does not match the running chain genesis. A provider must publish and pin a verified checkpoint for this chain; your node identity is preserved.');
    }
    const checkpoint = await fetchCheckpoint(trust, this.checkpointCacheDirectory, (value) => { this.checkpoint = value; });
    if (resetExisting) {
      assertResetHome(home, checkpoint.manifest);
      await this.compose(['up', '-d', '--wait', '--wait-timeout', '90', 'db']);
    }
    else {
      await this.compose(['up', '-d', '--wait', '--wait-timeout', '90', 'db', 'mpt', 'abci']);
      await this.compose(['stop', 'abci', 'mpt']);
    }
    await (resetExisting ? restoreExisting : restoreFresh)({ ...checkpoint, trust, home, project: this.project, run: this.run, progress: (value) => { this.checkpoint = value; } });
  }
  compose(args) {
    return this.run(['compose', '-p', this.project, '-f', this.file, ...args], { env: { ...process.env, GRAPHENE_NODE_PASSWORD: this.identity?.passphrase || '' } });
  }
  claimLauncher() {
    const lock = path.join(this.folder, 'launcher.lock');
    if (fs.existsSync(lock)) {
      const pid = Number(fs.readFileSync(lock, 'utf8'));
      if (pid === process.pid) return;
      if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid launcher lock. Ask your node operator to inspect it.');
      try { process.kill(pid, 0); } catch (error) {
        if (error.code !== 'ESRCH') throw new Error('Another launcher owns this node.');
        fs.unlinkSync(lock);
      }
      if (fs.existsSync(lock)) throw new Error('Another launcher owns this node. Close it before continuing.');
    }
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  }
  async stop() {
    if (this.operation) throw new Error('A node operation is already in progress.');
    if (!this.file || !fs.existsSync(this.file)) return;
    this.operation = true;
    try {
      await this.compose(['stop']);
      this.state = 'stopped'; this.verifiedStopped = true; this.error = null;
    } catch {
      this.state = 'error'; this.error = 'Docker could not stop the node. Check Docker.';
      throw new Error(this.error);
    } finally { this.operation = false; }
  }
  async offlineStatus(result) {
    if (this.verifiedStopped) return { ...result, state: 'stopped' };
    try {
      // A saved profile can exist before Compose has created any containers.
      // Query Docker successfully before treating a missing RPC port as stopped.
      const ids = (await this.run(['ps', '-aq', '--filter', `label=com.docker.compose.project=${this.project}`, '--filter', 'label=com.docker.compose.service=node'])).trim();
      const containers = ids ? JSON.parse(await this.run(['inspect', ...ids.split(/\s+/)])) : [];
      if (!containers.length || containers.every(container => !container.State.Running && !container.State.Restarting && !container.State.Paused)) {
        return { ...result, state: this.error ? 'error' : 'stopped' };
      }
    } catch { /* Docker is unreachable: preserve the unknown running state. */ }
    return { ...result, state: 'unavailable', statusError: 'Cannot check the node. Make sure Docker is running on its host, then refresh its status.' };
  }
  async status() {
    const result = { role: this.identity?.setup.role || 'validator', state: this.state, agentAddress: this.identity?.setup.agentAddress, error: this.error, agentRunning: false, checkpoint: this.checkpoint };
    if (!this.file || !fs.existsSync(this.file) || this.operation) return result;
    try {
      const port = (await this.compose(['port', 'node', '26657'])).trim();
      if (!/^127\.0\.0\.1:\d+$/.test(port)) return this.offlineStatus(result);
      const [{ result: status }, { result: peers }] = await Promise.all([json(`http://${port}/status`), json(`http://${port}/net_info`)]);
      let agentStatus = {};
      {
        try {
          const address = (await this.compose(['port', 'agent', '3001'])).trim();
          if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error('No agent endpoint');
          const health = await json(`http://${address}/status`);
          const fresh = Date.now() - Date.parse(health.details.lastPollTime) < 45000;
          agentStatus = { agentRunning: true, updates: health.details.updates || { enabled: false }, connections: fresh ? (health.details.connections || []) : [], agentError: !fresh ? 'Agent assignment verification is stale.' : Object.values(health.details.errors || {}).length ? String(Object.values(health.details.errors)[0].lastError || 'Tunnel setup failed').slice(0, 300) : null };
        } catch { agentStatus = { agentRunning: false, connections: [], agentError: 'Node agent status unavailable.' }; }
      }
      let syncError = null;
      if (this.lastHeight !== status.sync_info.latest_block_height) { this.lastHeight = status.sync_info.latest_block_height; this.heightSeenAt = Date.now(); }
      if (status.sync_info.catching_up && Date.now() - this.heightSeenAt > 30000) syncError = 'Chain replay has not advanced for 30 seconds. A peer connection alone does not confirm synchronization. Check node logs for a chain-state mismatch; signing data has been preserved.';
      if (status.sync_info.catching_up && Number(peers.n_peers) === 0) {
        const logs = await this.compose(['logs', '--tail', '60', 'node']);
        if (/wrong Block.Header.AppHash/.test(logs)) syncError = 'Chain state mismatch during replay. Connection controls cannot repair consensus state; signing data has been preserved.';
      }
      if (this.checkpoint?.height && !status.sync_info.catching_up && BigInt(status.sync_info.latest_block_height) > BigInt(this.checkpoint.height)) this.checkpoint = { ...this.checkpoint, phase: 'synchronized' };
      return { ...result, ...agentStatus, checkpoint: this.checkpoint, observedAt: Date.now(), syncError, state: status.sync_info.catching_up ? 'syncing' : 'running', height: status.sync_info.latest_block_height, peers: peers.n_peers, votingPower: status.validator_info.voting_power, consensusAddress: status.validator_info.address };
    } catch { return this.offlineStatus(result); }
  }
}

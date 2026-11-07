import { runHostDoctor } from './node-diagnostics.js';
import { createHostMonitor } from './node-monitor.js';
import { tendermintValidatorAddress } from '../agents/lib/node-setup.js';
import { isEncryptionPublicKey } from '../agents/lib/connection-keys.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LauncherP2P, parseGrphLink, validGrphKey } from '../agents/lib/grph-tunnel.js';
import { prepareNodeIdentity } from './node-identity.js';
import { prepareWalletAction, nodeChainState, chainJson, walletNodes } from './node-wallet.js';
const idPattern = /^[a-z0-9-]{1,64}$/;
const safeError = message => Object.assign(new Error(message), { status: 400 });

export class NodeManager {
 constructor({ directory, keystorePath, sentrySecretsPath, runtimeFactory, readChain = chainJson, remoteFetch = fetch, p2p, doctorRunner=runHostDoctor }) {
  this.doctorRunner=doctorRunner;this.doctorPromise=null;
  this.directory = directory; this.legacyPaths = { directory, keystorePath, sentrySecretsPath };
  this.monitor = createHostMonitor(directory);
  this.runtimeFactory = runtimeFactory; this.readChain = readChain; this.remoteFetch = remoteFetch;
  this.unlocked = new Map(); this.operations = new Map(); this.remoteTokens = new Map(); this.remoteConnections = new Map();
  this.p2p = p2p || new LauncherP2P({ directory });
  this.catalog = path.join(directory, 'node-catalog.json'); this.hostsFile = path.join(directory, 'remote-hosts.json');
  this.nodes = fs.existsSync(this.catalog) ? JSON.parse(fs.readFileSync(this.catalog)) : [];
  this.remotes = fs.existsSync(this.hostsFile) ? JSON.parse(fs.readFileSync(this.hostsFile)).filter(host => host.transport === 'grph' && validGrphKey(host.publicKey)) : [];
  for (const role of ['validator', 'sentry']) {
   const key = role === 'validator' ? keystorePath : sentrySecretsPath;
   if (key && fs.existsSync(key) && !this.nodes.some(n => n.id === 'legacy-' + role)) this.nodes.push({ id: 'legacy-' + role, role, name: 'Existing ' + role, setup: null, legacy: true });
  }
 }
 write(file, data) {
  fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  const temporary = file + '.tmp'; fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 }); fs.renameSync(temporary, file);
 }
 save() { this.write(this.catalog, this.nodes); }
 find(id) { const node = this.nodes.find(n => n.id === id && !n.archivedAt); if (!node || !idPattern.test(id)) throw safeError('Choose a node from this launcher.'); return node; }
 paths(node) { return node.legacy ? this.legacyPaths : { directory: path.join(this.directory, 'node-profiles', node.id) }; }
 attach(node, identity) {
  const current = this.unlocked.get(node.id);
  if (this.operations.has(node.id)) throw safeError('Wait for this node’s current operation to finish.');
  const runtime = current || this.runtimeFactory(identity.setup.role, { checkpointCacheDirectory: path.join(this.directory, 'checkpoint-cache', identity.setup.agentAddress.slice(2).toLowerCase()) });
  runtime.unlock(identity); this.unlocked.set(node.id, runtime);
  Object.assign(node, { name: identity.setup.name, role: identity.setup.role, setup: identity.setup });
  delete node.archivedAt;
  this.save(); return runtime;
 }
 async list() {
  return { nodes: await Promise.all(this.nodes.filter(node => !node.archivedAt).map(async node => {
   const runtime = this.unlocked.get(node.id);
   let status = { state: 'locked' };
   try { if (runtime) status = await runtime.status(); } catch { status = { state: 'unavailable', error: 'Live status cannot be checked. Your node may still be running.' }; }
   if (this.operations.has(node.id)) status.state = this.operations.get(node.id);
   return { ...node, setup:node.setup&&node.role==='validator'?{...node.setup,tendermintValidatorAddress:tendermintValidatorAddress(node.setup.consensusPublicKey)}:node.setup, unlocked: !!runtime, status };
  })) };
 }
 add(body) {
  if (body.mode !== 'new' && body.mode !== 'import') throw safeError('Choose new setup or import a setup file.');
  let node;
  if (body.mode === 'import') {
   if (!body.expectedIdentity?.agentAddress) throw safeError('Choose your public setup JSON first.');
   node = this.nodes.find(n => n.setup?.agentAddress.toLowerCase() === body.expectedIdentity.agentAddress.toLowerCase() && n.role === body.role);
   if (!node) {
    const key = body.role === 'validator' ? this.legacyPaths.keystorePath : this.legacyPaths.sentrySecretsPath;
    if (!key || !fs.existsSync(key)) throw safeError('This host has no saved identity for that setup file. Use the original node host or restore its encrypted identity and signing state with your provider.');
    node = this.nodes.find(n => n.id === 'legacy-' + body.role) || { id: 'legacy-' + body.role, legacy: true };
   }
  } else node = { id: crypto.randomUUID(), legacy: false };
  const identity = prepareNodeIdentity(this.paths(node), body.mode === 'new' ? { ...body, expectedIdentity: undefined } : body);
  if (!this.nodes.includes(node)) this.nodes.push(node);
  this.attach(node, identity);
  return { node: { ...node, unlocked: true }, setup: identity.setup };
 }
 unlock(node, passphrase) {
  if (!node.setup) throw safeError('Import this node’s public setup JSON to reopen its original identity.');
  const { setup } = node;
  const expectedIdentity = Object.fromEntries(['agentAddress','nodeId','encryptionPublicKey','consensusPublicKey','transportPublicKey'].filter(f => setup[f]).map(f => [f, setup[f]]));
  this.attach(node, prepareNodeIdentity(this.paths(node), { ...setup, host: setup.p2pHost, port: setup.p2pPort, passphrase, expectedIdentity }));
  return { unlocked: true };
 }
 async remove(node) {
  const runtime = this.unlocked.get(node.id);
  if (!runtime) throw safeError('Unlock this node so its stopped status can be checked before deleting it from the launcher.');
  if (this.operations.has(node.id)) throw safeError('Wait for this node’s current operation to finish.');
  this.operations.set(node.id, 'removing');
  try {
   if ((await runtime.status()).state !== 'stopped') throw safeError('Only a stopped node can be deleted from the launcher. Running nodes and nodes with unknown status must be kept.');
   // Retain the original profile and signing data; importing its public setup can restore it.
   node.archivedAt = new Date().toISOString();
   try { this.save(); } catch (error) { delete node.archivedAt; throw error; }
   runtime.identity = null;
   this.unlocked.delete(node.id);
   return { removed: true, retainedIdentity: true, nodeId: node.id };
  } finally { this.operations.delete(node.id); }
 }
 async act(node, action, wallet) {
  const runtime = this.unlocked.get(node.id);
  if (!runtime) throw safeError('Unlock this node with its original password first.');
  if (this.operations.has(node.id)) throw safeError('This node is already starting or stopping.');
  if (['start', 'reset'].includes(action) && !/^0x[0-9a-f]{40}$/i.test(wallet || '')) throw safeError('Connect the wallet that registered this node before starting.');
  this.operations.set(node.id, action === 'stop' ? 'stopping' : 'starting');
  try {
   if (action === 'reset' && (await runtime.status()).state !== 'stopped') throw safeError('Stop this node before resetting from a checkpoint.');
   if (action === 'stop' && node.role === 'validator' && (await runtime.status()).state !== 'stopped') {
    if (!/^0x[0-9a-f]{40}$/i.test(wallet || '')) throw safeError('Connect the validator owner wallet to verify a safe stop.');
    const state = await nodeChainState(node.setup, wallet, this.readChain);
    if (!state.ownerMatches || !state.exit.safeToStop) throw safeError('Keep this validator running. Request exit and wait until consensus removal is confirmed before stopping.');
   }
  } catch (error) {
   this.operations.delete(node.id);
   throw error;
  }
  Promise.resolve().then(() => action === 'reset' ? runtime.start(wallet, { resetCheckpoint: true }) : action === 'start' ? runtime.start(wallet) : runtime.stop()).catch(() => {}).finally(() => this.operations.delete(node.id));
  return { accepted: true, nodeId: node.id };
 }
 hosts() { return { hosts: [{ id: 'local', label: 'This computer / server', connected: true }, ...this.remotes.map(({ origin, ...r }) => ({ ...r, transport:'grph', connected: this.remoteTokens.has(r.id) }))] }; }
 async connect(body, ownOrigin) {
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (!label || label.length > 64) throw safeError('Give this server a name of 1–64 characters.');
  const { key, token } = parseGrphLink(body.link);
  if (this.p2p.publication && (await this.p2p.publication).key === key) throw safeError('This is the current launcher. Use the P2P link from another server.');
  const connection = await this.p2p.connect(key);
  const origin = connection.origin;
  let response, info;
  try {
   response = await this.remoteFetch(origin + '/launcher', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000), redirect: 'error' });
   info = await response.json();
   if (!response.ok || info.service !== 'graphene-launcher' || !info.features?.includes('p2p-manager-v1')) throw new Error('The P2P connection link is invalid or the remote launcher needs an update.');
  } catch (error) { await connection.close(); throw safeError(error.message.includes('link') ? error.message : 'Cannot reach this peer through Grph P2P. Check the remote launcher and UDP/DHT connectivity.'); }

  const id = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  let host = this.remotes.find(r => r.id === id);
  if (!host) { host = { id, publicKey:key, transport:'grph', label }; this.remotes.push(host); } else host.label = label;
  await this.remoteConnections.get(id)?.close();
  this.remoteConnections.set(id, connection);
  this.remoteTokens.set(id, token); this.write(this.hostsFile, this.remotes);
  return { host: { ...host, connected: true } };
 }
 async proxy(id, body) {
  const host = this.remotes.find(r => r.id === id), token = this.remoteTokens.get(id), connection = this.remoteConnections.get(id);
  if (!host || !token || !connection) throw safeError('Reconnect this server using its Grph P2P connection link.');
  const nodeRoute = /^\/(nodes(?:\/[a-z0-9-]{1,64}(?:\/(?:unlock|start|reset|stop|lock|remove|setup|transaction|chain\/(?:0x[0-9a-fA-F]{40})))?)?|rpc)$/;
  const walletRoute = /^\/wallets\/0x[0-9a-fA-F]{40}\/nodes(?:\/(?:validator|sentry)\/0x[0-9a-fA-F]{40}\/(?:chain|transaction))?$/;
  if (!['GET', 'POST'].includes(body.method) || typeof body.route !== 'string' || !(nodeRoute.test(body.route) || walletRoute.test(body.route) || body.route==='/doctor'&&body.method==='POST' || ['/capabilities','/monitor'].includes(body.route)&&body.method==='GET')) throw safeError('This remote action is not supported.');
  const response = await this.remoteFetch(connection.origin + '/manager' + body.route, { method: body.method, headers: { Origin: connection.origin, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body.method === 'POST' ? { body: JSON.stringify(body.body || {}) } : {}), signal: AbortSignal.timeout(20000), redirect: 'error' }).catch(() => { throw safeError('Remote peer is unavailable. Check its launcher and the P2P tunnel. Its nodes may still be running.'); });
  const value = await response.json();
  if (!response.ok) throw safeError(value.error || 'The remote server could not complete this action.');
  return value;
 }
 async prepareTransaction(node, body) {
   if (!node.setup) throw safeError('Import the node’s public setup file first.');
   const state = await nodeChainState(node.setup, body.wallet, this.readChain);
   const isStatus = (record, value) => String(record.status).toLowerCase() === value;
   const registering = ['registerValidator', 'registerSentry'].includes(body.action);
   if (registering && state.registration && (node.role === 'sentry' || state.registration.registered)) throw safeError('This wallet or node is already registered. Use its existing registration.');
   if (!registering && !state.ownerMatches) throw safeError('Connect the wallet that owns this registered node.');
   if (state.exit.requested && ['delegateStake', 'removeValidator', 'applyToSentry'].includes(body.action)) throw safeError('Validator exit is already requested. Keep signing until removal is confirmed.');
   if (body.action === 'unlockStake' && state.staking && (!state.exit.canWithdraw || state.assignments.some(r => isStatus(r, 'active')))) throw safeError('Wait for exit unbonding to finish and revoke the sentry connections before withdrawing.');
   if (body.action === 'applyToSentry') {
    const sentryId = String(body.input?.sentryId || '').toLowerCase();
    if (!state.sentries.some(s => s.active && s.sentryId?.toLowerCase() === sentryId)) throw safeError('Choose an active sentry.');
    if (state.applications.some(r => r.sentryId?.toLowerCase() === sentryId && isStatus(r, 'pending')) || state.assignments.some(r => r.sentryId?.toLowerCase() === sentryId && isStatus(r, 'active'))) throw safeError('This sentry already has a pending request or active connection for your validator.');
    if(!isEncryptionPublicKey(state.sentries.find(s=>s.sentryId?.toLowerCase()===sentryId)?.encryptionPublicKey))throw safeError('This sentry has an invalid registered encryption key. Its owner must correct the registration before a validator can connect.');
   }
   let connection;
   if (['approveApplication','rejectApplication','cancelApplication','revokeAssignment'].includes(body.action)) {
    const list = body.action === 'revokeAssignment' ? state.assignments : state.applications;
    const record = list.find(r => String(r.id) === String(body.input?.id));
    if (!record || (node.role === 'sentry' ? record.sentryId?.toLowerCase() !== node.setup.agentAddress.toLowerCase() : record.validator?.toLowerCase() !== body.wallet.toLowerCase())) throw safeError('This request or connection belongs to a different node.');
    connection={id:String(record.id),validator:record.validator,sentryId:record.sentryId};
    if (!isStatus(record, body.action === 'revokeAssignment' ? 'active' : 'pending')) throw safeError('This request or connection has already changed. Refresh before reviewing another action.');
   }
   return {...prepareWalletAction(node.setup, body.wallet, body.action, body.input),...(connection?{connection}:{})};
 }
 async dispatch(route, method, body, { ownOrigin, localPort, token } = {}) {
  if (route === '/share' && method === 'POST') { const published = await this.p2p.publish(localPort); return { link: 'grph://' + published.key + '#' + token, transport: 'grph' }; }
  if(route==='/capabilities'&&method==='GET')return {features:['agent-funding-v1','host-doctor-v1','drawer-tabs-v1','host-monitor-v1','saved-node-removal-v1','checkpoint-reset-v1']};
  if(route==='/monitor'&&method==='GET')return this.monitor();
  if(route==='/doctor'&&method==='POST'){if(Object.keys(body||{}).length)throw safeError('Doctor accepts no command arguments.');if(!this.doctorPromise)this.doctorPromise=Promise.resolve().then(()=>this.doctorRunner()).finally(()=>{this.doctorPromise=null;});return this.doctorPromise;}
  if (route === '/hosts' && method === 'GET') return this.hosts();
  if (route === '/remotes' && method === 'POST') return this.connect(body, ownOrigin);
  const remote = /^\/remotes\/([a-f0-9]{16})\/proxy$/.exec(route);
  if (remote && method === 'POST') return this.proxy(remote[1], body);
  const walletRoute = /^\/wallets\/(0x[0-9a-fA-F]{40})\/nodes(?:\/(validator|sentry)\/(0x[0-9a-fA-F]{40})\/(chain|transaction))?$/.exec(route);
  if (walletRoute) {
   if (!walletRoute[2]) { if (method === 'GET') return walletNodes(walletRoute[1], this.readChain); throw safeError('Wallet discovery is read-only.'); }
   const inventory = await walletNodes(walletRoute[1], this.readChain);
   const node = inventory.nodes.find(n => n.role === walletRoute[2] && n.setup.agentAddress.toLowerCase() === walletRoute[3].toLowerCase());
   if (!node) throw safeError('This node is not registered to the selected wallet. Refresh the wallet list.');
   if (walletRoute[4] === 'chain' && method === 'GET') return nodeChainState(node.setup, inventory.wallet, this.readChain);
   if (walletRoute[4] === 'transaction' && method === 'POST') {
    if (typeof body.wallet !== 'string' || body.wallet.toLowerCase() !== inventory.wallet) throw safeError('Connect the wallet that owns this registered node.');
    if (['registerValidator', 'registerSentry'].includes(body.action)) throw safeError('This node is already registered.');
    return this.prepareTransaction(node, body);
   }
   throw safeError('This wallet action is not supported.');
  }
  if (route === '/nodes' && method === 'GET') return this.list();
  if (route === '/nodes' && method === 'POST') return this.add(body);
  if (route === '/rpc' && method === 'POST') {
   if (!['eth_chainId', 'eth_getTransactionReceipt', 'eth_getBalance', 'eth_getBlockByNumber', 'eth_blockNumber', 'eth_getTransactionCount', 'eth_sendRawTransaction', 'eth_estimateGas', 'eth_gasPrice', 'eth_call', 'eth_getCode', 'eth_getTransactionByHash', 'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'net_version', 'web3_clientVersion'].includes(body.method)) throw safeError('This network read is not supported.');
   return this.readChain('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: body.method, params: body.params || [] }) });
  }
  const match = /^\/nodes\/([a-z0-9-]{1,64})\/(unlock|start|reset|stop|lock|remove|setup|transaction|chain\/(0x[0-9a-fA-F]{40}))$/.exec(route);
  if (!match) throw safeError('This launcher action is not supported.');
  const node = this.find(match[1]), action = match[2];
  if (action === 'setup' && method === 'GET') { if (!node.setup) throw safeError('Import this node’s original setup file first.'); return { setup: node.setup }; }
  if (action.startsWith('chain/') && !node.setup) throw safeError('Import this node’s public setup JSON first.');
  if (action.startsWith('chain/') && method === 'GET') return nodeChainState(node.setup, match[3], this.readChain);
  if (method !== 'POST') throw safeError('This action requires a confirmation.');
  if (action === 'remove') return this.remove(node);
  if (action === 'unlock') return this.unlock(node, body.passphrase);
  if (action === 'lock') { if (this.operations.has(node.id)) throw safeError('Wait for this node’s current operation to finish.'); const runtime = this.unlocked.get(node.id); if (runtime) { runtime.identity = null; } this.unlocked.delete(node.id); return { locked: true }; }
  if (action === 'reset' && body.confirmReset !== true) throw safeError('Confirm checkpoint reset for the selected stopped node.');
  if (action === 'start' || action === 'stop' || action === 'reset') return this.act(node, action, body.wallet);
  if (action === 'transaction') {
   return this.prepareTransaction(node, body);
  }
  throw safeError('This action is not supported.');
 }
}

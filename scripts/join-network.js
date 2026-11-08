#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { renderNodeGuide } from './node-guide.js';
import { NodeManager } from './node-manager.js';
import { LocalNodeRuntime } from './local-node-runtime.js';
import { checkpointDownloadPath, serveCheckpointDownload } from './checkpoint-serving.js';
import { LauncherCheckpoints } from './launcher-checkpoints.js';

export function createSetupServer({ directory, token = crypto.randomBytes(32).toString('hex'),
  keystorePath = path.join(directory, 'keystore.enc'), sentrySecretsPath = path.join(directory, 'sentry-secrets.json'),
  runtime, managerReadChain, p2p, checkpoints, checkpointDirectory = process.env.GRAPHENE_CHECKPOINT_PUBLICATION_DIR || fileURLToPath(new URL('../.checkpoints/publication', import.meta.url)), runtimeFactory = (role, options = {}) => new LocalNodeRuntime({ directory, ...options }) }) {
  const manager = new NodeManager({ directory, keystorePath, sentrySecretsPath, readChain: managerReadChain, p2p, checkpoints: checkpoints || new LauncherCheckpoints({ output: checkpointDirectory }), runtimeFactory: (role, options) => runtime || runtimeFactory(role, options) });
  const server = http.createServer(async (req, res) => {
    // Grph P2P clients use ephemeral loopback ports. Trust only literal loopback
    // hostnames; authenticated mutation origins must still match this exact Host.
    const host = req.headers.host || '';
    const loopback = /^(127\.0\.0\.1|localhost):([0-9]{1,5})$/.exec(host);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const reply = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (!loopback || Number(loopback[2]) < 1 || Number(loopback[2]) > 65535) return reply(403, { error: 'Open the local setup address shown in your launcher.' });
    if (req.url === '/checkpoints/enrollment.json' && req.method === 'GET') {
      try { return reply(200, manager.checkpoints.publicEnrollment()); }
      catch { return reply(404, { error: 'No public checkpoint publisher configuration is available.' }); }
    }
    const checkpointFile = checkpointDownloadPath.exec(req.url);
    if (checkpointFile && req.method === 'GET') {
      return serveCheckpointDownload(req, res, checkpointDirectory, checkpointFile[1]);
    }
    if (req.url === '/launcher' && req.method === 'GET') {
      if (req.headers.origin || req.headers.authorization !== `Bearer ${token}`) return reply(403, { error: 'Launcher authentication required.' });
      return reply(200, { service: 'graphene-launcher', pid: process.pid, features: ['checkpoint-bootstrap-v1', 'public-setup-import-v1', 'node-manager-v1', 'p2p-manager-v1', 'operator-guide-v1', 'wallet-discovery-v1','agent-funding-v1','host-doctor-v1','drawer-tabs-v1','host-monitor-v1','saved-node-removal-v1','checkpoint-reset-v1','checkpoint-objects-v1','launcher-checkpoints-v1','checkpoint-node-selection-v1','serving-sentry-checkpoints-v1'] });
    }
    const pageUrl = new URL(req.url, 'http://' + host);
    if (['/', '/operator', '/operator/guide', '/guide'].includes(pageUrl.pathname) && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (['/operator/guide', '/guide'].includes(pageUrl.pathname)) return res.end(renderNodeGuide({ role: pageUrl.searchParams.get('role') || (Number(loopback[2]) === 8788 ? 'sentry' : 'validator'), hosted: pageUrl.searchParams.get('location') === 'server' }));
      return res.end(fs.readFileSync(new URL('./node-manager.html', import.meta.url)));
    }
    const icon=/^\/launcher-icons\/([a-z0-9-]{1,64}\.svg)$/.exec(pageUrl.pathname);
    if(icon&&req.method==='GET'){
      try{const root=fs.realpathSync(new URL('./launcher-icons/',import.meta.url)),file=fs.realpathSync(new URL('./launcher-icons/'+icon[1],import.meta.url));if(!file.startsWith(root+path.sep)||!fs.statSync(file).isFile())return reply(404,{error:'Icon not found'});res.writeHead(200,{'Content-Type':'image/svg+xml; charset=utf-8'});return res.end(fs.readFileSync(file));}catch{return reply(404,{error:'Icon not found'});}
    }
    if(pageUrl.pathname==='/launcher-assets/graphene-logo.png'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'image/png'});return res.end(fs.readFileSync(new URL('./launcher-assets/graphene-logo.png',import.meta.url)));}
    const publicFiles = { '/manager-ui.js': './node-manager-ui.js', '/checkpoint-manager-ui.js': './checkpoint-manager-ui.js', '/guide-ui.js': './node-guide-ui.js', '/operator-guide.md': '../README.md' };
    if (Object.hasOwn(publicFiles, pageUrl.pathname) && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': pageUrl.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/markdown; charset=utf-8' });
      return res.end(fs.readFileSync(new URL(publicFiles[pageUrl.pathname], import.meta.url)));
    }
    const walletNetwork = /^\/wallet-rpc\/(local|[a-f0-9]{16})$/.exec(req.url);
    if (walletNetwork) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (req.method !== 'POST') return reply(405, { error: 'Use the wallet RPC through your wallet.' });
      let request;
      try {
        let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 131072) throw new Error('RPC request too large.'); }
        request = JSON.parse(raw);
        if (!request || Array.isArray(request) || request.jsonrpc !== '2.0') throw new Error('Send one JSON-RPC request at a time.');
        const body = { method: request.method, params: request.params };
        const value = walletNetwork[1] === 'local' ? await manager.dispatch('/rpc', 'POST', body) : await manager.proxy(walletNetwork[1], { route: '/rpc', method: 'POST', body });
        return reply(200, { ...value, jsonrpc: '2.0', id: request.id ?? null });
      } catch (error) { return reply(200, { jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32000, message: error.message } }); }
    }
    const origin = req.headers.origin;
    const local = origin === `http://${host}` && req.headers.authorization === `Bearer ${token}`;
    const readBody = async () => {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 4096) throw new Error('Request is too large.');
      }
      return JSON.parse(raw || '{}');
    };
    if (req.url.startsWith('/manager/')) {
      const readAllowed = req.method === 'GET' && (!origin || origin === `http://${host}`);
      if (req.headers.authorization !== `Bearer ${token}` || (!local && !readAllowed)) return reply(403, { error: 'Open your private launcher link again.' });
      try {
        const body = req.method === 'GET' ? {} : await readBody();
        const value = await manager.dispatch(req.url.slice('/manager'.length), req.method, body, { ownOrigin: `http://${host}`, localPort: server.address().port, token });
        return reply(value.accepted ? 202 : 200, value);
      } catch (error) { return reply(error.status || 400, { error: error.message }); }
    }
    return reply(404, { error: 'Not found' });
  });
  server.on('close', () => { void manager.p2p.close(); });
  const resumePublication = () => fs.existsSync(path.join(directory, 'launcher-p2p.json'))
    ? manager.p2p.publish(server.address().port) : Promise.resolve(null);
  return { server, token, resumePublication };
}

export async function startSetupLauncher({ directory, port = 8787, ...options }) {
  directory = path.resolve(directory);
  const recordPath = path.join(directory, 'launcher.json');
  const config = JSON.stringify([path.resolve(options.keystorePath || path.join(directory, 'keystore.enc')), path.resolve(options.sentrySecretsPath || path.join(directory, 'sentry-secrets.json'))]);
  const { server, token, resumePublication } = createSetupServer({ directory, ...options });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    try {
      const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
      if (record.port !== port || record.config !== config || !/^[a-f0-9]{64}$/.test(record.token)) throw new Error('Different launcher');
      const response = await fetch(`http://127.0.0.1:${port}/launcher`, { headers: { Authorization: `Bearer ${record.token}` }, redirect: 'error', signal: AbortSignal.timeout(2000) });
      const result = await response.json();
      if (!response.ok || result.service !== 'graphene-launcher' || result.pid !== record.pid) throw new Error('Unverified launcher');
      if (!result.features?.includes('checkpoint-bootstrap-v1')) throw Object.assign(new Error('Older launcher'), { code: 'OUTDATED_LAUNCHER' });
      if (!result.features?.includes('public-setup-import-v1')) throw Object.assign(new Error('Older import support'), { code: 'OUTDATED_IMPORT' });
      if (!result.features?.includes('node-manager-v1')) throw Object.assign(new Error('Older manager support'), { code: 'OUTDATED_MANAGER' });
      if (!result.features?.includes('p2p-manager-v1')) throw Object.assign(new Error('Older P2P support'), { code: 'OUTDATED_P2P' });
      if (!result.features?.includes('operator-guide-v1')) throw Object.assign(new Error('Older operator guide support'), { code: 'OUTDATED_GUIDE' });
      if (!result.features?.includes('wallet-discovery-v1')) throw Object.assign(new Error('Older wallet inventory support'), { code: 'OUTDATED_WALLET_INVENTORY' });
      if(!result.features?.includes('agent-funding-v1')||!result.features?.includes('host-doctor-v1'))throw Object.assign(new Error('Older funding and Doctor support'),{code:'OUTDATED_DRAWER'});
      if (!result.features?.includes('host-monitor-v1')) throw Object.assign(new Error('Older Monitor support'), { code: 'OUTDATED_MONITOR' });
      if (!result.features?.includes('saved-node-removal-v1')) throw Object.assign(new Error('Older saved node removal support'), { code: 'OUTDATED_NODE_REMOVAL' });
      if (!result.features?.includes('checkpoint-reset-v1')) throw Object.assign(new Error('Older checkpoint reset support'), { code: 'OUTDATED_CHECKPOINT_RESET', launcherPid: record.pid });
      if (!result.features?.includes('checkpoint-objects-v1')) throw Object.assign(new Error('Older incremental checkpoint support'), { code: 'OUTDATED_CHECKPOINT_OBJECTS' });
      if (!result.features?.includes('launcher-checkpoints-v1')) throw Object.assign(new Error('Older launcher checkpoint controls'), { code: 'OUTDATED_CHECKPOINT_CONTROLS' });
      if (!result.features?.includes('checkpoint-node-selection-v1')) throw Object.assign(new Error('Older checkpoint source selection'), { code: 'OUTDATED_CHECKPOINT_SELECTION' });
      if (!result.features?.includes('serving-sentry-checkpoints-v1')) throw Object.assign(new Error('Older serving-sentry checkpoint support'), { code: 'OUTDATED_SERVING_CHECKPOINT' });
      return { server: null, token: record.token, reused: true, url: `http://127.0.0.1:${port}/#${record.token}` };
    } catch (error) {
      if (error.code === 'OUTDATED_SERVING_CHECKPOINT') throw new Error(`Port ${port} runs an older launcher that blocks serving sentries from checkpoint creation. Close that launcher terminal and reopen from the updated folder, then unlock the source node again. Docker node services keep running.`);
      if (error.code === 'OUTDATED_CHECKPOINT_SELECTION') throw new Error(`Port ${port} runs an older launcher without wallet-node checkpoint selection. Close its launcher terminal and reopen the updated launcher. Docker node services keep running.`);
      if (error.code === 'OUTDATED_CHECKPOINT_CONTROLS') throw new Error(`Port ${port} runs an older launcher without checkpoint creation and enrollment controls. Close its launcher terminal and reopen the updated launcher. Docker node services keep running.`);
      if (error.code === 'OUTDATED_CHECKPOINT_OBJECTS') throw new Error(`Port ${port} runs an older launcher without incremental checkpoint downloads. Close its launcher terminal and reopen the updated launcher before publishing checkpoints. Docker node services keep running.`);
      if (error.code === 'OUTDATED_CHECKPOINT_RESET') throw new Error(`Port ${port} is still served by launcher process ${error.launcherPid} without checkpoint reset. Close that original launcher process and reopen from the updated folder; opening a second launcher reuses the existing backend. Docker node services keep running.`);
      if (error.code === 'OUTDATED_NODE_REMOVAL') throw new Error(`Port ${port} runs an older launcher without saved node deletion. Close its launcher terminal and reopen the updated launcher. Docker node services keep running.`);
      if (error.code === 'OUTDATED_MONITOR') throw new Error(`Port ${port} runs an older launcher without Monitor. Close its launcher terminal and reopen npm run join (or join:sentry) from the updated folder. Docker node services keep running.`);
      if (error.code === 'OUTDATED_WALLET_INVENTORY') throw new Error(`Port ${port} runs an older launcher without wallet node discovery. Close its terminal and reopen the updated launcher. Docker nodes keep running.`);
      if (error.code === 'OUTDATED_GUIDE') throw new Error(`Port ${port} runs an older launcher without the integrated operator guide. Close its terminal and reopen the updated launcher. Docker nodes keep running.`);
      if (error.code === 'OUTDATED_P2P') throw new Error(`Port ${port} runs an older launcher without P2P remote management. Close its terminal and reopen the updated launcher. Docker nodes keep running.`);
      if (error.code === 'OUTDATED_MANAGER') throw new Error(`Port ${port} runs an older launcher without the multi-node dashboard. Close its setup terminal and reopen the updated Join Graphene launcher. Docker node services keep running.`);
      if (error.code === 'OUTDATED_IMPORT') throw new Error(`Port ${port} runs an older launcher without setup file import support. Close its setup terminal and reopen the updated Join Graphene launcher. Docker node services keep running.`);
      if(error.code==='OUTDATED_DRAWER')throw new Error(`Port ${port} runs an older launcher backend. Close its launcher terminal and reopen npm run join (or join:sentry) to enable agent funding and Doctor. Docker node services keep running.`);
      if (error.code === 'OUTDATED_LAUNCHER') throw new Error(`Port ${port} runs an older launcher without checkpoint support. Close its setup terminal and reopen the updated Join Graphene launcher. Docker node services keep running.`);
      throw new Error(`Port ${port} is already in use. Open the existing launcher's private link, or close that launcher before reopening Join Graphene. No running service has been stopped.`);
    }
  }
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(recordPath, JSON.stringify({ port: server.address().port, token, pid: process.pid, config }), { mode: 0o600 });
    fs.chmodSync(recordPath, 0o600);
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  server.once('close', () => {
    try { if (JSON.parse(fs.readFileSync(recordPath)).token === token) fs.unlinkSync(recordPath); } catch { /* Already removed. */ }
  });
  // A pinned checkpoint URL uses this saved Grph identity across restarts.
  // Resume only hosts that have already enabled publication.
  try { await resumePublication(); }
  catch { console.warn('Could not resume Grph publication. Check UDP/DHT connectivity and use Share this server to retry. Checkpoint downloads need this publication online.'); }
  return { server, token, reused: false, url: `http://127.0.0.1:${server.address().port}/#${token}` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.resolve(process.env.GRAPHENE_SECRETS_DIR || './secrets');
  try {
    const { url, reused } = await startSetupLauncher({ directory, port: Number(process.env.SETUP_PORT || 8787), keystorePath: process.env.KEYSTORE_PATH, sentrySecretsPath: process.env.SECRETS_PATH });
    if (reused) console.log('Your Graphene launcher is already running. Reopening its existing setup page.');
    console.log(`\nGraphene node manager — open this private link on this computer:\n${url}\n`);
    console.log('Remote management: open the dashboard on the node host and choose Share this server to create a private Grph P2P connection link. Do not expose the HTTP setup port publicly.');
    if (process.env.GRAPHENE_P2P_SHARE === '1' || process.argv.includes('--share')) {
      const address = new URL(url);
      const response = await fetch(address.origin + '/manager/share', { method: 'POST', headers: { Origin: address.origin, Authorization: 'Bearer ' + address.hash.slice(1), 'Content-Type': 'application/json' }, body: '{}' });
      const share = await response.json();
      if (!response.ok) throw new Error(share.error || 'P2P sharing failed.');
      console.log(`Private Grph P2P connection link (keep private):\n${share.link}\n`);
    }
    if (!reused) console.log('Keep this terminal open while managing your nodes. Closing it leaves Docker nodes running.');
    if (!process.env.SSH_CONNECTION && !process.env.GRAPHENE_NO_OPEN) {
      const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
      const child = spawn(command, [url], { stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
    }
  } catch (error) {
    console.error(`Could not open setup: ${error.message}`); process.exitCode = 1;
  }
}

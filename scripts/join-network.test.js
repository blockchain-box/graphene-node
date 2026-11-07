import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSetupServer } from './join-network.js';
import http from 'node:http';

test('updated launcher refuses to silently reuse an older server without checkpoint support', async (t) => {
  const { startSetupLauncher } = await import('./join-network.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'graphene-old-launcher-'));
  const old = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ service: 'graphene-launcher', pid: process.pid })); });
  await new Promise((resolve) => old.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => old.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  const port = old.address().port;
  fs.writeFileSync(path.join(directory, 'launcher.json'), JSON.stringify({ port, pid: process.pid, token: 'a'.repeat(64), config: JSON.stringify([path.join(directory, 'keystore.enc'), path.join(directory, 'sentry-secrets.json')]) }));
  await assert.rejects(startSetupLauncher({ directory, port }), /older launcher without checkpoint support/);
  assert.equal(old.listening, true, 'An old server is never killed automatically');
});

test('launcher refuses to reuse a backend without Monitor even when its other drawer features exist', async t => {
  const { startSetupLauncher } = await import('./join-network.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'graphene-old-monitor-'));
  const features = ['checkpoint-bootstrap-v1','public-setup-import-v1','node-manager-v1','p2p-manager-v1','operator-guide-v1','wallet-discovery-v1','agent-funding-v1','host-doctor-v1','drawer-tabs-v1'];
  const old = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json');res.end(JSON.stringify({ service: 'graphene-launcher', pid: process.pid, features })); });
  await new Promise(resolve => old.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => old.close(resolve));fs.rmSync(directory, { recursive: true, force: true }); });
  const port = old.address().port;
  fs.writeFileSync(path.join(directory, 'launcher.json'), JSON.stringify({ port, pid: process.pid, token: 'a'.repeat(64), config: JSON.stringify([path.join(directory, 'keystore.enc'), path.join(directory, 'sentry-secrets.json')]) }));
  await assert.rejects(startSetupLauncher({ directory, port }), /without Monitor/);
  assert.equal(old.listening, true);
});

test('opening the launcher twice reuses the authenticated instance and its private link', async (t) => {
  const { startSetupLauncher } = await import('./join-network.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'graphene-reopen-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = await startSetupLauncher({ directory, port: 0 });
  t.after(() => new Promise((resolve) => first.server.close(resolve)));
  const second = await startSetupLauncher({ directory, port: first.server.address().port });
  assert.equal(second.reused, true);
  assert.equal(second.url, first.url);
  assert.equal(second.server, null);
  assert.equal(fs.statSync(path.join(directory, 'launcher.json')).mode & 0o777, 0o600);
  const endpoint = new URL('/launcher', first.url);
  assert.equal((await fetch(endpoint)).status, 403);
  assert.equal((await fetch(endpoint, { headers: { Origin: 'https://evil.example', Authorization: `Bearer ${first.token}` } })).status, 403);
  const wrongDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'graphene-other-'));
  t.after(() => fs.rmSync(wrongDirectory, { recursive: true, force: true }));
  await assert.rejects(startSetupLauncher({ directory: wrongDirectory, port: first.server.address().port }), /already in use/);
});

test('launcher reuse requires import support before opening the new import UI', async (t) => {
  const { startSetupLauncher } = await import('./join-network.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'graphene-old-import-'));
  const old = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ service: 'graphene-launcher', pid: process.pid, features: ['checkpoint-bootstrap-v1'] })); });
  await new Promise((resolve) => old.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => old.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  const port = old.address().port;
  fs.writeFileSync(path.join(directory, 'launcher.json'), JSON.stringify({ port, pid: process.pid, token: 'a'.repeat(64), config: JSON.stringify([path.join(directory, 'keystore.enc'), path.join(directory, 'sentry-secrets.json')]) }));
  await assert.rejects(startSetupLauncher({ directory, port }), /older launcher without setup file import support/);
  assert.equal(old.listening, true);
});

test('retired assistant and explorer pairing endpoints are unavailable', async t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'graphene-retired-controls-'));
  const {server,token}=createSetupServer({directory,p2p:{close:async()=>{}}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(directory,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+server.address().port;
  for(const route of ['/setup-assistant','/setup','/pairing','/pair','/unpair','/node/status','/node/start','/node/stop']){
    const response=await fetch(base+route,{method:route==='/setup-assistant'||route==='/node/status'?'GET':'POST',headers:{Origin:'http://localhost:8080',Authorization:'Bearer '+token,'Content-Type':'application/json'}});
    assert.equal(response.status,404,route);assert.equal(response.headers.get('access-control-allow-origin'),null);
  }
  const dashboard=await fetch(base);assert.equal(dashboard.status,200);assert.match(await dashboard.text(),/Your nodes/);
  const publicInfo=await fetch(base+'/manager/nodes');assert.equal(publicInfo.status,403);
  assert.equal((await fetch(base+'/manager/nodes',{headers:{Authorization:'Bearer '+token}})).status,200);
});

test('restarting a previously shared launcher republishes the same checkpoint address', async (t) => {
  const { startSetupLauncher } = await import('./join-network.js');
  const { LauncherP2P, openGrphClient } = await import('../agents/lib/grph-tunnel.js');
  const { default: HyperDHT } = await import('hyperdht');
  const { default: dgram } = await import('node:dgram');
  const socket = dgram.createSocket('udp4');
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const dht = HyperDHT.bootstrapper(port, '127.0.0.1'); await dht.ready();
  const bootstrap = ['127.0.0.1:' + port];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'grph-publication-restart-'));
  const checkpointDirectory = path.join(directory, 'checkpoints'); fs.mkdirSync(checkpointDirectory);
  fs.writeFileSync(path.join(checkpointDirectory, 'latest.json'), '{"available":true}');
  const firstP2P = new LauncherP2P({ directory, bootstrap });
  let first, second, secondP2P, client;
  t.after(async () => {
    await client?.close();
    if (first?.server.listening) await new Promise(resolve => first.server.close(resolve));
    if (second?.server.listening) await new Promise(resolve => second.server.close(resolve));
    await firstP2P.close(); await secondP2P?.close(); await dht.destroy();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  first = await startSetupLauncher({ directory, port: 0, p2p: firstP2P, checkpointDirectory });
  const origin = new URL(first.url).origin;
  const response = await fetch(origin + '/manager/share', { method: 'POST', headers: { Origin: origin, Authorization: 'Bearer ' + first.token, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200);
  const { link } = await response.json(); const key = new URL(link).hostname;
  await new Promise(resolve => first.server.close(resolve)); await firstP2P.close();
  secondP2P = new LauncherP2P({ directory, bootstrap });
  second = await startSetupLauncher({ directory, port: 0, p2p: secondP2P, checkpointDirectory });
  assert.ok(secondP2P.publication, 'Saved Grph publication must resume before launcher startup completes');
  assert.equal((await secondP2P.publication).key, key);
  assert.notEqual(second.token, first.token);
  client = await openGrphClient(key, { bootstrap, timeoutMs: 10000 });
  const download = await fetch(client.origin + '/checkpoints/latest.json');
  assert.equal(download.status, 200);
  assert.deepEqual(await download.json(), { available: true });
});

test('a launcher that was never shared does not publish itself at startup', async (t) => {
  const { startSetupLauncher } = await import('./join-network.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'grph-unshared-launcher-'));
  const launcher = await startSetupLauncher({ directory, port: 0, p2p: { publish() { assert.fail('Unshared launcher must stay private'); }, close: async () => {} } });
  t.after(async () => { await new Promise(resolve => launcher.server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
});


test('reopening the launcher cannot silently reuse a backend without checkpoint reset', async t => {
 const {startSetupLauncher}=await import('./join-network.js');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'graphene-old-reset-'));
 const features=['checkpoint-bootstrap-v1','public-setup-import-v1','node-manager-v1','p2p-manager-v1','operator-guide-v1','wallet-discovery-v1','agent-funding-v1','host-doctor-v1','drawer-tabs-v1','host-monitor-v1','saved-node-removal-v1'];
 const old=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({service:'graphene-launcher',pid:process.pid,features}));});
 await new Promise(r=>old.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>old.close(r));fs.rmSync(directory,{recursive:true,force:true});});
 const port=old.address().port;
 fs.writeFileSync(path.join(directory,'launcher.json'),JSON.stringify({port,pid:process.pid,token:'a'.repeat(64),config:JSON.stringify([path.join(directory,'keystore.enc'),path.join(directory,'sentry-secrets.json')])}));
 await assert.rejects(startSetupLauncher({directory,port}),/original launcher process/);
 assert.equal(old.listening,true);
});

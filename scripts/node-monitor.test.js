import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHostMonitor } from './node-monitor.js';
import { NodeManager } from './node-manager.js';

const cpu = (idle, user) => ({ times: { idle, user, sys: 0, nice: 0, irq: 0 } });
test('host monitoring samples CPU deltas, RAM and available storage, sharing concurrent reads', async () => {
 let reads = 0, finish;
 const monitor = createHostMonitor('/state/new', {
  system: { cpus: () => ++reads === 1 ? [cpu(100, 100), cpu(100, 100)] : [cpu(175, 125), cpu(175, 125)], totalmem: () => 1000, freemem: () => 400, hostname: () => 'node-host' },
  wait: () => new Promise(resolve => { finish = resolve; }),
  readStorage: async folder => { if (folder === '/state/new') throw Object.assign(new Error(), { code: 'ENOENT' }); return { blocks: 100, bsize: 10, bfree: 40, bavail: 30 }; },
 });
 const first = monitor(), second = monitor();assert.equal(first, second);finish();
 const report = await first;
 assert.deepEqual(report.cpu, { cores: 2, usedPercent: 25, freePercent: 75 });
 assert.deepEqual(report.memory, { total: 1000, used: 600, free: 400, usedPercent: 60 });
 assert.deepEqual(report.storage, { total: 1000, used: 600, free: 300, reserved: 100, usedPercent: 60 });
 assert.equal(report.hostname, 'node-host');assert.ok(Number.isFinite(Date.parse(report.sampledAt)));
});

test('unavailable storage and missing CPU samples do not hide RAM usage', async () => {
 const monitor = createHostMonitor('/state', {
  system: { cpus: () => [], totalmem: () => 1000, freemem: () => 400, hostname: () => 'host' },
  wait: async () => {}, readStorage: async () => { throw new Error('denied'); },
 });
 const report = await monitor();assert.equal(report.cpu.usedPercent, null);assert.equal(report.memory.free, 400);assert.match(report.storage.error, /unavailable/);
});

test('monitor endpoint works without unlocking nodes and proxies only GET to the selected host', async t => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'node-monitor-'));
 t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
 const calls = [], manager = new NodeManager({ directory, p2p: {}, remoteFetch: async (url, options) => { calls.push({ url, options });return { ok: true, json: async () => ({ hostname: 'remote' }) }; } });
 const report = await manager.dispatch('/monitor', 'GET');assert.ok(report.cpu.cores > 0);assert.ok(report.memory.total > 0);
 manager.remotes = [{ id: 'remote' }];manager.remoteTokens.set('remote', 'private-token');manager.remoteConnections.set('remote', { origin: 'http://127.0.0.1:1234' });
 assert.equal((await manager.proxy('remote', { route: '/monitor', method: 'GET' })).hostname, 'remote');
 assert.equal(calls[0].url, 'http://127.0.0.1:1234/manager/monitor');assert.equal(calls[0].options.method, 'GET');
 await assert.rejects(manager.proxy('remote', { route: '/monitor', method: 'POST' }), /not supported/);
 await assert.rejects(manager.dispatch('/monitor', 'POST', {}), /not supported/);
});

test('Monitor reads the selected node host and never substitutes the host of a wallet-only registration', async () => {
 const elements = new Map(), element = id => {
  if (!elements.has(id)) elements.set(id, { value: '', textContent: '', innerHTML: '', dataset: {}, addEventListener() {}, querySelectorAll() { return []; }, classList: { add() {}, remove() {} } });
  return elements.get(id);
 };
 const context = vm.createContext({ document: { getElementById: element, querySelectorAll: () => [] }, window: new EventTarget(), Event, location: { search: '', hash: '', pathname: '/' }, history: { replaceState() {} }, sessionStorage: { getItem() {} }, URLSearchParams, setTimeout, clearTimeout, setInterval() {}, AbortSignal, fetch: () => new Promise(() => {}) });
 vm.runInContext(fs.readFileSync(new URL('./node-manager-ui.js', import.meta.url), 'utf8'), context);
 vm.runInContext(`rows=[{id:'saved',hostId:'remote',role:'sentry'}];selected=keyFor(rows[0]);activeDrawerTab='monitor';globalThis.calls=[];api=async(...args)=>{calls.push(args);return {hostname:'remote',sampledAt:new Date().toISOString(),cpu:{cores:4,usedPercent:25,freePercent:75},memory:{used:512,free:512,total:1024,usedPercent:50},storage:{error:'Storage unavailable'}};};`, context);
 await vm.runInContext('loadMonitor()', context);
 assert.equal(vm.runInContext('calls[0][3]', context), 'remote');
 assert.match(element('monitor-results').innerHTML, /25.0% used/);assert.match(element('monitor-results').innerHTML, /Remaining/);assert.match(element('monitor-results').innerHTML, /Storage unavailable/);
 vm.runInContext('rows[0].chainOnly=true;renderMonitor()', context);
 await vm.runInContext('loadMonitor()', context);
 assert.equal(vm.runInContext('calls.length', context), 1);assert.match(element('monitor-results').innerHTML, /original host/);
});

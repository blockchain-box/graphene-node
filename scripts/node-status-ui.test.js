import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./node-manager-ui.js', import.meta.url), 'utf8');
function dashboard(state, disconnected = false, funding = null) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', innerHTML: '', dataset: {}, addEventListener() {}, querySelectorAll() { return []; }, classList: { add() {}, remove() {} } });
    return elements.get(id);
  };
  const context = vm.createContext({ document: { getElementById: element, querySelectorAll: () => [] }, window: new EventTarget(), Event, location: { search: '', hash: '', pathname: '/' }, history: { replaceState() {} }, sessionStorage: { getItem() {} }, URLSearchParams, setTimeout, clearTimeout, setInterval() {}, AbortSignal, fetch: () => new Promise(() => {}) });
  vm.runInContext(source, context);
  vm.runInContext(`rows = [{ id: 'saved', hostId: '${disconnected ? 'remote' : 'local'}', name: 'Saved validator', role: 'validator', unlocked: true, setup: {}, status: { state: '${state}' } }]; selected = keyFor(rows[0]); wallet = 'owner'; chainState = { registration: { registered: true }, ownerMatches: true, agentFunding: ${JSON.stringify(funding ? {status:funding} : null)} }; hostErrors = ${disconnected ? "[{id:'remote'}]" : '[]'}; updateStatus();`, context);
  return { element, run:code=>vm.runInContext(code,context), guidance: vm.runInContext('nodeGuidance(current())[0]', context) };
}

test('a registered stopped node has an enabled Start button and start guidance', () => {
  const ui = dashboard('stopped');
  assert.equal(ui.element('start-node').disabled, false);
  assert.match(ui.element('node-setup-guide').innerHTML, /Start your registered node/);
});

test('unavailable runtime on a connected host asks to check Docker rather than reconnect a server', () => {
  const ui = dashboard('unavailable');
  assert.equal(ui.element('start-node').disabled, true);
  assert.match(ui.guidance, /Docker/);
  assert.match(ui.element('node-setup-guide').innerHTML, /Check Docker/);
  assert.doesNotMatch(ui.element('node-setup-guide').innerHTML, /Connect a server/);
});

test('an unreachable remote host still offers server reconnection', () => {
  const ui = dashboard('unavailable', true);
  assert.equal(ui.element('start-node').disabled, true);
  assert.equal(ui.guidance, 'Reconnect this server');
  assert.match(ui.element('node-setup-guide').innerHTML, /Connect a server/);
});

test('a registered validator on a paid network sees agent funding before start guidance',()=>{
 const ui=dashboard('stopped',false,'empty');assert.match(ui.element('node-setup-guide').innerHTML,/Fund your validator agent/);assert.match(ui.element('node-setup-guide').innerHTML,/Owner stake does not fund/);
});


test('checkpoint recovery is available only for an unlocked registered stopped node',()=>{
 assert.equal(dashboard('stopped').element('reset-node').disabled,false);
 for(const state of ['running','syncing','starting','stopping','unavailable','locked','error'])assert.equal(dashboard(state).element('reset-node').disabled,true,state);
});


test('downtime panel distinguishes participation penalties from a GRPH stake deduction',()=>{
 const ui=dashboard('stopped');
 ui.run(`chainState.downtime={status:'ready',stakeSlashWei:'0',score:'900000000000000000',missedBlocks:'10',observedBlocks:'100',effectiveWeightWei:'1350000000000000000000',projections:[{missedBlocks:'1',score:'891089108910891089',weightReductionWei:'13366336633663366500'},{missedBlocks:'10',score:'818181818181818181',weightReductionWei:'122727272727272728500'}]};updateStatus();`);
 const html=ui.element('downtime-impact').innerHTML;
 assert.match(html,/stake deduction under current rules: 0 GRPH/);assert.match(html,/90.00%/);assert.match(html,/89.10%/);assert.match(html,/not a deduction from staked GRPH/);
});
test('Stop refreshes chain data and shows downtime impact before confirmation without stopping on cancel',async()=>{
 const ui=dashboard('running');
 ui.run(`globalThis.calls=[];globalThis.confirmText='';globalThis.confirm=message=>{confirmText=message;return false;};api=async(...args)=>{calls.push(args);return {registration:{registered:true},ownerMatches:true,exit:{safeToStop:false},downtime:{status:'ready',score:'900000000000000000',projections:[{score:'891089108910891089',missedBlocks:'1',weightReductionWei:'1'}],missedBlocks:'10',observedBlocks:'100',effectiveWeightWei:'100'}};};operate=async action=>calls.push(action);`);
 await ui.run('stopSelectedNode()');
 assert.equal(ui.run('calls.length'),1);assert.equal(ui.run('calls[0][1]'),'GET');
 assert.match(ui.run('confirmText'),/90.00%/);assert.match(ui.run('confirmText'),/Stopping is blocked/);assert.match(ui.run('confirmText'),/0 GRPH/);
});

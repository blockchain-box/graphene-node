import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('./node-manager-ui.js', import.meta.url), 'utf8');
function setup() {
 const elements = new Map();
 const element = id => {
  if (!elements.has(id)) elements.set(id, {value:'',textContent:'',innerHTML:'',hidden:false,dataset:{},setAttribute(){},closest(){return null;},focus(){},showModal(){this.open=true;},addEventListener(){},classList:{add(){},remove(){}},setCustomValidity(message){this.invalid=message;},reportValidity(){return !this.invalid;}});
  return elements.get(id);
 };
 const context=vm.createContext({document:{getElementById:element,querySelectorAll:()=>[],querySelector:selector=>({querySelectorAll:()=> selector.includes('2') ? [element('node-name'),element('node-address'),element('node-port')] : []})},window:new EventTarget(),Event,location:{search:'',hash:'',pathname:'/'},history:{replaceState(){}},sessionStorage:{getItem(){}},URLSearchParams,setTimeout,clearTimeout,setInterval(){},AbortSignal,fetch:()=>new Promise(()=>{})});
 vm.runInContext(source,context);
 const run=code=>vm.runInContext(code,context);
 run("hosts=[{id:'local',label:'This computer',connected:true}];openAdd();");
 return {element,run};
}
test('role selection is carried into setup and Back preserves it',async()=>{
 const ui=setup();ui.element('role-choice-sentry').onclick();
 assert.equal(ui.element('node-role').value,'sentry');assert.equal(ui.element('role-choice-sentry').checked,true);assert.equal(ui.element('role-choice-validator').checked,false);
 await ui.run('submitAddNode({preventDefault(){}})');assert.equal(ui.run('addStep'),1);
 ui.element('add-back').onclick();assert.equal(ui.run('addStep'),0);assert.equal(ui.element('node-role').value,'sentry');
});
test('saved identity shortcut enters reopen flow and allows returning to new setup',()=>{
 const ui=setup();ui.element('mode-import').onclick();assert.equal(ui.run('importMode'),true);assert.equal(ui.run('addStep'),1);assert.equal(ui.element('import-fields').hidden,false);
 ui.element('mode-new').onclick();assert.equal(ui.run('importMode'),false);assert.equal(ui.run('addStep'),0);assert.equal(ui.element('import-fields').hidden,true);
});
test('disconnected location and missing node name cannot advance setup',async()=>{
 const ui=setup();await ui.run('submitAddNode({preventDefault(){}})');ui.element('node-host').value='offline';
 await ui.run('submitAddNode({preventDefault(){}})');assert.equal(ui.run('addStep'),1);assert.match(ui.element('add-error').textContent,/connected node location/);
 ui.element('node-host').value='local';await ui.run('submitAddNode({preventDefault(){}})');assert.equal(ui.run('addStep'),2);
 await ui.run('submitAddNode({preventDefault(){}})');assert.equal(ui.run('addStep'),2);assert.match(ui.element('node-name').invalid,/Enter a name/);
});
test('identity completion points at registration without claiming node has started',()=>{
 const ui=setup();ui.run('addComplete=true;renderAddStep();');assert.match(ui.element('setup-lifecycle').innerHTML,/<li aria-current="step">Register/);assert.equal(ui.element('add-done').hidden,false);assert.equal(ui.element('save-node').hidden,true);
});

test('reopening from an existing node skips the new role choice',()=>{
 const ui=setup();ui.run("openAdd(true,'local')");assert.equal(ui.run('addStep'),1);assert.equal(ui.run('importMode'),true);assert.equal(ui.element('node-host').value,'local');
});

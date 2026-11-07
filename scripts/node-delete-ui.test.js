import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./node-manager-ui.js',import.meta.url),'utf8');
function ui(){
 const elements=new Map(),element=id=>{if(id==='request-sentry')return null;if(!elements.has(id))elements.set(id,{value:'',textContent:'',innerHTML:'',dataset:{},contains(){return false;},addEventListener(){},querySelectorAll(){return [];},classList:{add(){},remove(){}}});return elements.get(id);};
 const context=vm.createContext({document:{getElementById:element,querySelectorAll:()=>[]},window:new EventTarget(),Event,location:{search:'',hash:'',pathname:'/'},history:{replaceState(){}},sessionStorage:{getItem(){}},URLSearchParams,setTimeout,clearTimeout,setInterval(){},AbortSignal,fetch:()=>new Promise(()=>{})});
 vm.runInContext(source,context);
 vm.runInContext(`rows=[{id:'mistake',hostId:'remote',role:'validator',name:'Mistake',unlocked:true,status:{state:'stopped'},setup:{}}];selected=keyFor(rows[0]);wallet='owner';chainState={registration:{registered:true},identityMatches:false,ownerMatches:false};updateStatus=()=>{};renderResumeGuide=()=>{};`,context);
 return {element,run:code=>vm.runInContext(code,context)};
}
test('wallet mismatch offers deletion only for a saved validator and disables unsafe states',()=>{
 const d=ui();d.run('renderChain()');assert.match(d.element('chain-panel').innerHTML,/different validator/);assert.match(d.element('chain-panel').innerHTML,/id="delete-node" class="danger" >/);
 for(const state of ['running','unavailable','locked']){d.run(`rows[0].status.state='${state}';renderChain()`);assert.match(d.element('chain-panel').innerHTML,/id="delete-node" class="danger" disabled/);}
 d.run('chainState.identityMatches=true;renderChain()');assert.doesNotMatch(d.element('chain-panel').innerHTML,/id="delete-node"/);
 d.run('rows[0].chainOnly=true;rows[0].ownerWallet="owner";chainState.identityMatches=false;renderChain()');assert.doesNotMatch(d.element('chain-panel').innerHTML,/id="delete-node"/);
});
test('delete confirmation targets the saved node host and removes the entry after success',async()=>{
 const d=ui();d.run(`globalThis.calls=[];globalThis.confirm=()=>false;api=async(...args)=>{calls.push(args);return {removed:true};};load=async()=>{};closeNodeDetail=()=>{selected=null;};`);
 await d.run('deleteSelectedNode()');assert.equal(d.run('calls.length'),0);
 d.run('confirm=()=>true');await d.run('deleteSelectedNode()');assert.equal(d.run('calls[0][0]'),'/nodes/mistake/remove');assert.equal(d.run('calls[0][3]'),'remote');assert.equal(d.run('rows.length'),0);assert.match(d.element('activity').textContent,/retained/);
});


test('checkpoint reset confirmation targets selected host with an explicit recovery request',async()=>{
 const d=ui();d.run(`globalThis.calls=[];globalThis.confirm=()=>false;api=async(...args)=>{calls.push(args);return {accepted:true};};load=async()=>{};renderDetail();`);
 d.element('reset-node').onclick();await new Promise(r=>setImmediate(r));assert.equal(d.run('calls.length'),0);
 d.run('confirm=()=>true');d.element('reset-node').onclick();await new Promise(r=>setImmediate(r));
 assert.equal(d.run('calls[0][0]'),'/nodes/mistake/reset');assert.equal(d.run('calls[0][2].confirmReset'),true);assert.equal(d.run('calls[0][3]'),'remote');
});

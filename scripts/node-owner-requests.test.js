import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./node-manager-ui.js',import.meta.url),'utf8');
const owner='0x'+'1'.repeat(40),other='0x'+'9'.repeat(40),sentry='0x'+'3'.repeat(40),validator='0x'+'2'.repeat(40);
const node={id:'sentry-'+sentry,role:'sentry',name:'Berlin sentry',ownerWallet:owner,chainOnly:true,setup:{agentAddress:sentry}};
const pending={id:'7',validator,sentryId:sentry,status:'Pending'};
function ui(){
 const elements=new Map();const element=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',innerHTML:'',dataset:{},hidden:false,open:false,querySelectorAll(){return [];},addEventListener(){},setAttribute(){},classList:{add(){},remove(){}},close(){this.open=false;},showModal(){this.open=true;}});return elements.get(id);};
 const context=vm.createContext({document:{getElementById:element,querySelectorAll:()=>[]},window:new EventTarget(),Event,location:{hash:'',search:'',pathname:'/'},history:{replaceState(){}},sessionStorage:{getItem(){}},URLSearchParams,setTimeout,clearTimeout,setInterval(){},AbortSignal,fetch:()=>new Promise(()=>{})});
 vm.runInContext(source,context);vm.runInContext('const launcherApi=api;',context);const run=code=>vm.runInContext(code,context);
 context.fixtureNode=node;context.fixturePending=pending;context.fixtureOwner=owner;
 run("wallet=fixtureOwner;lookupWallet='0x'+'9'.repeat(40);hosts=[{id:'local',label:'This computer',connected:true}];api=async route=>route.endsWith('/nodes')?{nodes:[fixtureNode]}:{ownerMatches:true,registration:{operator:fixtureOwner,active:true},applications:[fixturePending,{...fixturePending,id:'8',sentryId:'0x'+'8'.repeat(40)},{...fixturePending,id:'9',status:'Approved'}]};");
 return {context,run,element};
}
test('inbox uses the connected owner, filters foreign sentries and nonpending requests',async()=>{
 const app=ui();const calls=[];app.context.record=route=>calls.push(route);app.run('const originalApi=api;api=async route=>{record(route);return originalApi(route)};');await app.run('loadOwnerRequests()');
 assert.equal(app.run('ownerRequests.length'),1);assert.equal(app.run('ownerRequests[0].request.id'),'7');assert.match(calls[0],new RegExp('/wallets/'+owner+'/nodes'));assert.ok(!calls[0].includes(other));assert.match(app.element('owner-request-list').innerHTML,/Review approval/);assert.match(app.element('owner-request-list').innerHTML,new RegExp(validator));
});
test('inbox clears immediately on account changes and discards late results',async()=>{
 const app=ui();let resolve;app.context.delayed=new Promise(r=>resolve=r);app.run('api=()=>delayed;');const waiting=app.run('loadOwnerRequests()');app.run("wallet=null;resetOwnerRequests();");resolve({nodes:[node]});await waiting;
 assert.equal(app.run('ownerRequests.length'),0);assert.equal(app.element('owner-request-list').innerHTML,'');assert.match(app.element('owner-requests-status').textContent,/Connect your owner wallet/);
});
test('unverified ownership and failed reads never expose approval controls',async()=>{
 for(const response of ["{ownerMatches:false,registration:{operator:fixtureOwner},applications:[fixturePending]}","Promise.reject(new Error('Network unavailable'))"]){const app=ui();app.run(`api=async route=>route.endsWith('/nodes')?{nodes:[fixtureNode]}:${response};`);await app.run('loadOwnerRequests()');assert.equal(app.run('ownerRequests.length'),0);assert.doesNotMatch(app.element('owner-request-list').innerHTML,/data-owner-request=/);assert.ok(app.run('ownerRequestErrors.length')>0);}
});
test('inactive sentries can be declined but approval stays disabled',async()=>{
 const app=ui();app.run('const oldApi=api;api=async route=>{const result=await oldApi(route);if(result.registration)result.registration.active=false;return result;};');await app.run('loadOwnerRequests()');assert.match(app.element('owner-request-list').innerHTML,/data-decision="approveApplication" disabled/);
 const decisions=[];app.context.decision=action=>decisions.push(action);app.run('selectNode=()=>{};prepareTx=async action=>decision(action);');await app.run("reviewOwnerRequest(ownerRequests[0].key,'approveApplication')");await app.run("reviewOwnerRequest(ownerRequests[0].key,'rejectApplication')");assert.deepEqual(decisions,['rejectApplication']);
});
test('request actions reuse transaction review without requiring private node keys',async()=>{
 const app=ui();await app.run('loadOwnerRequests()');const decisions=[];app.context.decision=(...args)=>decisions.push(args);app.run('selectNode=key=>{selected=key;};prepareTx=async (action,input)=>decision(action,input.id);');await app.run("reviewOwnerRequest(ownerRequests[0].key,'approveApplication')");assert.deepEqual(decisions,[['approveApplication','7']]);app.run(`wallet='${other}'`);await app.run("reviewOwnerRequest(ownerRequests[0].key,'rejectApplication')");assert.equal(decisions.length,1);
});

test('a request that changed after review cannot reach wallet submission',async()=>{
 const app=ui();let sent=false;app.context.walletRequest=async ({method})=>{if(method==='eth_sendTransaction'){sent=true;throw new Error('Must not send');}return method==='eth_accounts'?[owner]:method==='eth_chainId'?'0x2694':{hash:'0x123'};};
 app.run("walletProvider={request:walletRequest};review={connection:{id:'7'},wallet:fixtureOwner,chainId:'0x2694',hostId:'local',route:'/transaction',action:'approveApplication',input:{id:'7'},transaction:{from:fixtureOwner,to:'0x4',data:'0x123'}};api=async (route,method,body)=>{if(route==='/rpc')return {result:{hash:'0x123'}};throw new Error('This request has already changed.');};");
 await app.run('approveTx()');assert.equal(sent,false);assert.match(app.element('tx-error').textContent,/already changed/);
});
test('account changes close an unsigned review and clear its action context',()=>{
 const app=ui();app.run('useConnectedWallet=()=>{};updateWalletNetwork=async()=>{};review={wallet:fixtureOwner};');app.element('tx-dialog').open=true;app.run('onWalletAccountsChanged([])');assert.equal(app.run('review'),null);assert.equal(app.element('tx-dialog').open,false);
});

test('background refresh preserves request controls when chain state is unchanged',async()=>{
 const app=ui();await app.run('loadOwnerRequests()');const list=app.element('owner-request-list');let writes=0,value=list.innerHTML;Object.defineProperty(list,'innerHTML',{get(){return value;},set(next){writes++;value=next;}});await app.run('loadOwnerRequests(true)');assert.equal(writes,0);
});
test('node tables escape names and provide a keyboard-accessible details button',()=>{
 const app=ui();app.run("rows=[{id:'one',hostId:'local',role:'sentry',name:'<script>unsafe</script>',unlocked:true,setup:{},status:{state:'running',agentRunning:true}}];");const html=app.run('renderNodeTable(rows)');assert.match(html,/<table/);assert.match(html,/<th scope="col">Node/);assert.match(html,/aria-label="Open &lt;script&gt;unsafe/);assert.doesNotMatch(html,/<script>/);
});
test('the right drawer opens once and closing clears selection',()=>{
 const app=ui();let opens=0;const drawer=app.element('detail');drawer.showModal=()=>{opens++;drawer.open=true;};app.run('openNodeDrawer();openNodeDrawer();');assert.equal(opens,1);assert.equal(drawer.hidden,false);app.run("renderList=()=>{};renderWalletInventory=()=>{};selected='local:one';closeNodeDetail();");assert.equal(app.run('selected'),null);assert.equal(drawer.open,false);assert.equal(drawer.hidden,true);
});

test('agent funding explains live zero fees and publication frequency without a fixed top-up amount',()=>{
 const app=ui();const html=app.run("renderAgentFunding({...fixtureNode,role:'validator'},{agentFunding:{status:'free',balanceWei:'0',gasPriceWei:'0'}})");assert.match(html,/No top-up is required/);assert.match(html,/once per approved assignment/);assert.match(html,/no universal GRPH top-up amount/);assert.match(html,/Review agent funding/);
 const sentryHtml=app.run("renderAgentFunding(fixtureNode,{agentFunding:{status:'not-required'}})");assert.match(sentryHtml,/currently submits no automatic blockchain transactions/);
});

test('Review connections activates the Connections tab instead of scrolling the registration section',()=>{
 const app=ui();app.run("rows=[{...fixtureNode,id:'saved',hostId:'local',chainOnly:false,unlocked:true,status:{state:'running',agentRunning:true}}];selected=keyFor(rows[0]);chainState={registration:{active:true},ownerMatches:true};renderResumeGuide();");app.element('resume-action').onclick();assert.equal(app.element('detail').dataset.tab,'connections');
});
test('drawer tabs preserve selection and reject staking on a sentry',()=>{
 const app=ui();app.run("ownerSentries=[{...fixtureNode,hostId:'local'}];selected=keyFor(ownerSentries[0]);activateDrawerTab('agent');");assert.equal(app.element('detail').dataset.tab,'agent');app.run("activateDrawerTab('staking')");assert.equal(app.element('detail').dataset.tab,'agent');
});
test('old backend funding failures explain how to enable the action',async()=>{
 const app=ui();app.run("fetch=async()=>({ok:false,json:async()=>({error:'This wallet action is not supported.'})});");await assert.rejects(app.run("launcherApi('/nodes/saved/transaction','POST',{action:'fundAgent'})"),/older launcher backend/);
});

test('Connections and Doctor identify a malformed assigned sentry instead of an unlock failure',()=>{
 const app=ui();app.run("ownerSentries=[{...fixtureNode,role:'validator',hostId:'local'}];selected=keyFor(ownerSentries[0]);chainState={sentries:[{sentryId:fixturePending.sentryId,name:'genesis-sentry',encryptionKeyValid:false,encryptionPublicKey:'x'.repeat(39)}],assignments:[{...fixturePending,status:'Active'}]};doctorReports.set('local',{ok:true,checks:[{label:'Host prerequisite',ok:true}],note:'Read only'});renderDoctorReport();");
 const html=app.run('connectionIssueMarkup(current(),chainState)');assert.match(html,/genesis-sentry cannot receive encrypted connections/);assert.match(html,/39 characters/);assert.match(app.element('doctor-results').innerHTML,/ACTION NEEDED/);assert.match(app.element('doctor-results').innerHTML,/Encryption key for genesis-sentry/);
});

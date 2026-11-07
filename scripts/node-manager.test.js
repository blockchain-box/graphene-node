import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import dgram from 'node:dgram';
import HyperDHT from 'hyperdht';
import { LauncherP2P } from '../agents/lib/grph-tunnel.js';
import http from 'node:http';
import { Interface, getAddress } from 'ethers';
import { createSetupServer } from './join-network.js';
import { NodeManager } from './node-manager.js';
import { prepareWalletAction, CONTRACT } from './node-wallet.js';
const password = 'a secure test passphrase';
const wallet = '0x' + '1'.repeat(40);
const expected = setup => Object.fromEntries(['agentAddress','nodeId','encryptionPublicKey','consensusPublicKey','transportPublicKey'].filter(k=>setup[k]).map(k=>[k,setup[k]]));
function runtimeFactory() { return { state:'stopped', unlock(identity) {this.identity=identity;}, async status(){return {state:this.state,agentAddress:this.identity?.setup.agentAddress,role:this.identity?.setup.role};}, async start(owner){this.owner=owner;this.state='running';}, async stop(){this.state='stopped';} }; }
function fixture(t) {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'node-manager-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const config={directory,keystorePath:path.join(directory,'keystore.enc'),sentrySecretsPath:path.join(directory,'sentry-secrets.json'),runtimeFactory};
 return {directory,config,manager:new NodeManager(config)};
}
const add=(manager,name='Node',role='validator')=>manager.add({mode:'new',role,name,passphrase:password,...(role==='sentry'?{host:'sentry.example.com',port:26656}:{})});
test('multiple nodes of the same role have separate encrypted keys, controls and persisted public metadata',async t=>{
 const {directory,config,manager}=fixture(t);
 const first=add(manager,'First'),second=add(manager,'Second');
 assert.notEqual(first.setup.agentAddress,second.setup.agentAddress);
 assert.ok(fs.existsSync(path.join(directory,'node-profiles',first.node.id,'keystore.enc')));
 assert.ok(fs.existsSync(path.join(directory,'node-profiles',second.node.id,'keystore.enc')));
 await manager.act(manager.find(first.node.id),'start',wallet);await new Promise(r=>setImmediate(r));
 const snapshot=(await manager.list()).nodes;
 assert.equal(snapshot[0].status.state,'running');assert.equal(snapshot[1].status.state,'stopped');
 const restarted=new NodeManager(config);assert.equal((await restarted.list()).nodes.length,2);assert.equal((await restarted.list()).nodes[0].status.state,'locked');
 assert.ok(!fs.readFileSync(manager.catalog,'utf8').includes(password));
 await assert.rejects(restarted.act(restarted.find(first.node.id),'start',wallet),/Unlock/);
 restarted.unlock(restarted.find(first.node.id),password);assert.equal((await restarted.list()).nodes[0].unlocked,true);
 await restarted.dispatch('/nodes/'+first.node.id+'/lock','POST',{});assert.equal((await restarted.list()).nodes[0].unlocked,false);
});
test('import reopens the matching saved profile and refuses missing or substituted keys',t=>{
 const {manager}=fixture(t),created=add(manager,'Saved');
 const body={mode:'import',role:'validator',name:'Saved',passphrase:password,expectedIdentity:expected(created.setup)};
 const reopened=manager.add(body);assert.equal(reopened.node.id,created.node.id);assert.equal(manager.nodes.length,1);
 assert.throws(()=>manager.add({...body,passphrase:'wrong password 123'}),/unlock/);
 assert.throws(()=>manager.add({...body,expectedIdentity:{...expected(created.setup),nodeId:'2'.repeat(40)}}),/different node/);
 assert.throws(()=>manager.add({...body,expectedIdentity:{...expected(created.setup),agentAddress:'0x'+'4'.repeat(40)}}),/no saved identity/);
 assert.equal(manager.nodes.length,1);
});
test('manager serializes operations per node without blocking a different node',async t=>{
 const {manager}=fixture(t),one=add(manager,'One'),two=add(manager,'Two');
 let finish;manager.unlocked.get(one.node.id).start=()=>new Promise(r=>finish=r);
 await manager.act(manager.find(one.node.id),'start',wallet);await new Promise(r=>setImmediate(r));
 await assert.rejects(manager.act(manager.find(one.node.id),'stop'),/already/);
 await manager.act(manager.find(two.node.id),'start',wallet);await new Promise(r=>setImmediate(r));
 assert.equal((await manager.list()).nodes[1].status.state,'running');finish();
});
async function serverFixture(t, bootstrap){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'node-manager-http-'));
 const p2p=new LauncherP2P({directory,bootstrap});
 const {server,token}=createSetupServer({directory,runtimeFactory,p2p});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await p2p.close();await new Promise(r=>server.close(r));fs.rmSync(directory,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port;
 const request=(route,method='GET',body,headers={})=>fetch(base+route,{method,headers:{Authorization:'Bearer '+token,...(method==='POST'?{Origin:base,'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
 return{base,token,request,directory};
}
test('private manager rejects missing tokens, foreign origins and attempts to execute arbitrary commands',async t=>{
 const {request}=await serverFixture(t);
 assert.equal((await request('/manager/nodes','GET',null,{Authorization:''})).status,403);
 assert.equal((await request('/manager/nodes','POST',{mode:'new'},{Origin:'https://foreign.example'})).status,403);
 assert.equal((await request('/manager/rpc','POST',{method:'personal_unlockAccount'})).status,400);
 assert.equal((await request('/manager/execute','POST',{cmd:'anything'})).status,400);
 const response=await request('/manager/nodes','POST',{mode:'new',role:'validator',name:'Private',passphrase:password});assert.equal(response.status,200);
 const snapshot=await(await request('/manager/nodes')).text();assert.ok(!snapshot.includes(password));assert.ok(!snapshot.includes('privateKey'));
 assert.equal((await request('/wallet-rpc/local','POST',{jsonrpc:'2.0',id:7,method:'personal_sign',params:[]})).status,200);
 const denied=await(await request('/wallet-rpc/local','POST',{jsonrpc:'2.0',id:7,method:'personal_sign',params:[]})).json();assert.equal(denied.id,7);assert.ok(denied.error);
});
test('a hub operates a remote launcher through a real Grph P2P tunnel without persisting its access token',async t=>{
 const bootstrap=await testDht(t),remote=await serverFixture(t,bootstrap),hub=await serverFixture(t,bootstrap);
 const added=await(await remote.request('/manager/nodes','POST',{mode:'new',role:'validator',name:'Remote node',passphrase:password})).json();
 const connected=await(await hub.request('/manager/remotes','POST',{label:'Remote host',link:(await(await remote.request('/manager/share','POST',{})).json()).link})).json();
 const id=connected.host.id;
 const proxy=(route,method='GET',body)=>hub.request('/manager/remotes/'+id+'/proxy','POST',{route,method,body});
 const listed=await(await proxy('/nodes')).json();assert.equal(listed.nodes[0].name,'Remote node');
 assert.equal((await proxy('/nodes/'+added.node.id+'/start','POST',{wallet})).status,202);await new Promise(r=>setImmediate(r));
 assert.equal((await(await proxy('/nodes')).json()).nodes[0].status.state,'running');
 assert.equal((await proxy('/remotes','POST',{})).status,400);
 assert.equal((await proxy('/../../anything')).status,400);
 assert.ok(!fs.readFileSync(path.join(hub.directory,'remote-hosts.json'),'utf8').includes(remote.token));
 const bad=await hub.request('/manager/remotes','POST',{label:'Bad',link:'https://example.com/#'+remote.token});assert.equal(bad.status,400);
 const self=await hub.request('/manager/remotes','POST',{label:'Self',link:hub.base+'/#'+hub.token});assert.equal(self.status,400);
});
test('wallet actions encode the existing native contract ABI and reject invalid amounts and roles',()=>{
 const setup={role:'validator',name:'Node',agentAddress:'0x'+'2'.repeat(40),nodeId:'a'.repeat(40),consensusPublicKey:Buffer.alloc(32).toString('base64'),encryptionPublicKey:'b'.repeat(64)};
 const action=prepareWalletAction(setup,wallet,'registerValidator',{amount:'1.5'});
 const abi=new Interface(['function registerValidator(address,string,string,string,string,uint256)']);
 const decoded=abi.decodeFunctionData('registerValidator',action.transaction.data);
 assert.equal(decoded[0].toLowerCase(),setup.agentAddress);assert.equal(decoded[5],1500000000000000000n);assert.equal(action.transaction.to,CONTRACT);assert.equal(action.transaction.value,'0x0');
 assert.throws(()=>prepareWalletAction(setup,wallet,'delegateStake',{amount:'-1'}),/positive/);
 assert.throws(()=>prepareWalletAction(setup,wallet,'registerSentry',{country:'DE',capacity:2}),/sentry/);
 assert.throws(()=>prepareWalletAction(setup,wallet,'arbitraryMethod'),/not supported/);
});
test('wallet request preparation verifies the selected node and filters unrelated assignments',async t=>{
 const {manager}=fixture(t),created=add(manager),setup=created.setup;
 manager.readChain=async route=>route.includes('/validators/')?{...setup,registered:true,wallet,networkPublicKey:setup.consensusPublicKey,stake:'1'}:route.includes('/applications')?[{id:'1',validator:'0x'+'9'.repeat(40),sentryId:'0x'+'8'.repeat(40)}]:[];
 await assert.rejects(manager.dispatch('/nodes/'+created.node.id+'/transaction','POST',{wallet,action:'cancelApplication',input:{id:'1'}}),/different node/);
 manager.readChain=async route=>route.includes('/validators/')?{...setup,registered:true,wallet:'0x'+'9'.repeat(40),networkPublicKey:setup.consensusPublicKey}:[];
 await assert.rejects(manager.dispatch('/nodes/'+created.node.id+'/transaction','POST',{wallet,action:'claimStakeRewards'}),/owns this/);
});

async function testDht(t) {
 const reservation=dgram.createSocket('udp4');await new Promise(r=>reservation.bind(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const node=HyperDHT.bootstrapper(port,'127.0.0.1');await node.ready();t.after(()=>node.destroy());return ['127.0.0.1:'+port];
}

test('remote manager refuses direct HTTP and SSH forwarding links without opening a client', async t => {
 const {manager}=fixture(t);let attempts=0;manager.p2p={connect:async()=>{attempts++;throw new Error('not used');}};
 for(const link of ['http://127.0.0.1:8789/#'+'a'.repeat(64),'https://example.com/#'+'a'.repeat(64),'ssh://example.com'])await assert.rejects(manager.connect({label:'Server',link}),/P2P|grph/);
 assert.equal(attempts,0);
});

test('sentry requests and revocations are bound to its identity, current state and owner',async t=>{
 const {manager}=fixture(t),created=add(manager,'My sentry','sentry'),setup=created.setup;
 const record={...setup,sentryId:setup.agentAddress,operator:wallet,tendermintNodeId:setup.nodeId,p2pHost:setup.p2pHost,p2pPort:setup.p2pPort,country:'DE',capacity:'20',active:true};
 const requests=[{id:'1',sentryId:setup.agentAddress,validator:'0x'+'3'.repeat(40),status:'Pending'},{id:'2',sentryId:'0x'+'4'.repeat(40),validator:wallet,status:'Pending'},{id:'3',sentryId:setup.agentAddress,status:'Rejected'}];
 manager.readChain=async route=>route.endsWith('/sentries')?[record]:route.includes('/applications')?requests:route.includes('/assignments')?[{id:'9',sentryId:setup.agentAddress,status:'Active'}]:[];
 const state=await manager.dispatch('/nodes/'+created.node.id+'/chain/'+wallet,'GET');assert.equal(state.ownerMatches,true);assert.equal(state.endpointMatches,true);
 for(const action of ['approveApplication','rejectApplication'])assert.match((await manager.dispatch('/nodes/'+created.node.id+'/transaction','POST',{wallet,action,input:{id:'1'}})).label,/request #1/);
 // Real platform responses serialize uint256 IDs as hex quantities.
 requests.push({id:'0x02',sentryId:setup.agentAddress,validator:'0x'+'3'.repeat(40),status:'Pending'});
 for(const action of ['approveApplication','rejectApplication']) {
  const prepared=await manager.dispatch('/nodes/'+created.node.id+'/transaction','POST',{wallet,action,input:{id:'0x02'}});
  const contract=new Interface(['function approveApplication(uint256)','function rejectApplication(uint256)']);
  assert.equal(contract.decodeFunctionData(action,prepared.transaction.data)[0],2n);
 }

 await assert.rejects(manager.dispatch('/nodes/'+created.node.id+'/transaction','POST',{wallet,action:'approveApplication',input:{id:'2'}}),/different node/);
 await assert.rejects(manager.dispatch('/nodes/'+created.node.id+'/transaction','POST',{wallet,action:'approveApplication',input:{id:'3'}}),/already changed/);
 assert.match((await manager.dispatch('/nodes/'+created.node.id+'/transaction','POST',{wallet,action:'revokeAssignment',input:{id:'9'}})).label,/Revoke/);
 await assert.rejects(manager.dispatch('/nodes/'+created.node.id+'/transaction','POST',{wallet:'0x'+'5'.repeat(40),action:'rejectApplication',input:{id:'1'}}),/owns/);
 record.p2pHost='changed.example.com';const changed=await manager.dispatch('/nodes/'+created.node.id+'/chain/'+wallet,'GET');assert.equal(changed.endpointMatches,false);assert.equal(changed.ownerMatches,true);
});
test('validator cannot duplicate a pending or active sentry connection',async t=>{
 const {manager}=fixture(t),created=add(manager),setup=created.setup,sentryId='0x'+'4'.repeat(40);const record={...setup,wallet,registered:true,networkPublicKey:setup.consensusPublicKey};
 manager.readChain=async route=>route.includes('/validators/')?record:route.endsWith('/sentries')?[{sentryId,active:true}]:route.includes('/applications')?[{id:'1',validator:wallet,sentryId,status:'Pending'}]:[];
 await assert.rejects(manager.dispatch('/nodes/'+created.node.id+'/transaction','POST',{wallet,action:'applyToSentry',input:{sentryId}}),/already has/);
 await assert.rejects(manager.dispatch('/nodes/'+created.node.id+'/transaction','POST',{wallet,action:'applyToSentry',input:{sentryId:'0x'+'5'.repeat(40)}}),/active sentry/);
});
test('sentry address updates preserve peer identity and chain signing-account restrictions',()=>{
 const setup={role:'sentry',agentAddress:wallet,nodeId:'a'.repeat(40),name:'Sentry'};const action=prepareWalletAction(setup,wallet,'updateSentryHost',{host:'new.example.com',port:'26656',nodeId:'b'.repeat(40)});
 const abi=new Interface(['function updateSentryHost(string,string,uint256)']);const decoded=abi.decodeFunctionData('updateSentryHost',action.transaction.data);assert.equal(decoded[0],setup.nodeId);assert.equal(decoded[1],'new.example.com');assert.equal(decoded[2],26656n);
 assert.throws(()=>prepareWalletAction({...setup,agentAddress:'0x'+'9'.repeat(40)},wallet,'updateSentryHost',{host:'new.example.com',port:26656}),/owner wallet/);
 assert.throws(()=>prepareWalletAction(setup,wallet,'updateSentryHost',{host:'bad/host',port:26656}),/hostname/);
 assert.throws(()=>prepareWalletAction(setup,wallet,'updateSentryHost',{host:'good.example.com',port:65536}),/port/);
 assert.throws(()=>prepareWalletAction(setup,wallet,'registerSentry',{country:'DE',capacity:1000}),/999/);
});

test('deleting a stopped saved node removes its entry but preserves its identity and allows recovery', async t => {
 const {manager,config,directory}=fixture(t),created=add(manager,'Mistaken node'),other=add(manager,'Keep node');
 const keyPath=path.join(directory,'node-profiles',created.node.id,'keystore.enc'),original=fs.readFileSync(keyPath);
 const result=await manager.dispatch('/nodes/'+created.node.id+'/remove','POST',{});
 assert.equal(result.retainedIdentity,true);assert.ok(fs.readFileSync(keyPath).equals(original));
 assert.deepEqual((await manager.list()).nodes.map(n=>n.id),[other.node.id]);assert.throws(()=>manager.find(created.node.id),/Choose a node/);
 const restarted=new NodeManager(config);assert.deepEqual((await restarted.list()).nodes.map(n=>n.id),[other.node.id]);
 const restored=restarted.add({mode:'import',role:'validator',name:'Mistaken node',passphrase:password,expectedIdentity:expected(created.setup)});
 assert.equal(restored.node.id,created.node.id);assert.equal(restored.setup.agentAddress,created.setup.agentAddress);assert.equal((await restarted.list()).nodes.length,2);
});

test('deletion refuses locked, running, unknown and busy nodes', async t => {
 const {manager}=fixture(t),created=add(manager),node=manager.find(created.node.id),runtime=manager.unlocked.get(node.id);
 for(const state of ['running','syncing','unavailable','starting','stopping']){runtime.state=state;await assert.rejects(manager.remove(node),/Only a stopped/);assert.equal((await manager.list()).nodes.length,1);}
 runtime.state='stopped';manager.operations.set(node.id,'starting');await assert.rejects(manager.remove(node),/current operation/);manager.operations.clear();
 await manager.dispatch('/nodes/'+node.id+'/lock','POST',{});await assert.rejects(manager.remove(node),/Unlock/);
});

test('deletion serializes with runtime controls while checking stopped status', async t => {
 const {manager}=fixture(t),created=add(manager),node=manager.find(created.node.id),runtime=manager.unlocked.get(node.id);let finish;
 runtime.status=()=>new Promise(resolve=>{finish=resolve;});
 const pending=manager.remove(node);await assert.rejects(manager.act(node,'start',wallet),/already starting or stopping/);
 finish({state:'stopped'});await pending;assert.equal(manager.operations.size,0);
});


test('checkpoint reset requires explicit confirmation, owner wallet, stopped state and an exclusive operation', async t => {
 const {manager}=fixture(t),created=add(manager),node=manager.find(created.node.id),runtime=manager.unlocked.get(node.id);
 const route='/nodes/'+node.id+'/reset';let options;
 runtime.start=async(owner,settings)=>{options={owner,...settings};};
 await assert.rejects(manager.dispatch(route,'POST',{wallet}),/Confirm checkpoint reset/);
 await assert.rejects(manager.dispatch(route,'POST',{confirmReset:true}),/Connect the wallet/);
 for(const state of ['running','syncing','unavailable','error']){
  runtime.state=state;await assert.rejects(manager.dispatch(route,'POST',{wallet,confirmReset:true}),/Stop this node/);
 }
 assert.equal(options,undefined);
 runtime.state='stopped';manager.operations.set(node.id,'starting');
 await assert.rejects(manager.dispatch(route,'POST',{wallet,confirmReset:true}),/already starting/);manager.operations.clear();
 const result=await manager.dispatch(route,'POST',{wallet,confirmReset:true});assert.equal(result.accepted,true);
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(options,{owner:wallet,resetCheckpoint:true});
});

test('saved sentry approval finds lowercase network records when its profile uses checksum casing', async t => {
 const {manager}=fixture(t),created=add(manager,'Checksum sentry','sentry'),setup=created.setup;
 setup.agentAddress=getAddress('0x'+'ab'.repeat(20));
 assert.notEqual(setup.agentAddress,setup.agentAddress.toLowerCase());
 const sentryId=setup.agentAddress.toLowerCase(),request={id:'0x03',sentryId,validator:'0x'+'2'.repeat(40),status:'Pending'};
 const sentry={sentryId,operator:wallet,active:true,tendermintNodeId:setup.nodeId,encryptionPublicKey:setup.encryptionPublicKey,p2pHost:setup.p2pHost,p2pPort:setup.p2pPort};
 const queries=[];
 manager.readChain=async route=>{
  if(route==='/graphene/state/platform/sentries')return [sentry];
  if(route.startsWith('/graphene/state/platform/applications?')||route.startsWith('/graphene/state/platform/assignments?')){
   const url=new URL(route,'http://fixture');queries.push(url.searchParams.get('sentryId'));
   return url.searchParams.get('sentryId')===sentryId?[route.includes('/applications?')?request:{...request,id:'0x04',status:'Active'}]:[];
  }
  return [];
 };
 const route='/nodes/'+created.node.id+'/transaction';
 for(const [action,id] of [['approveApplication','0x03'],['rejectApplication','0x03'],['revokeAssignment','0x04']]){
  const prepared=await manager.dispatch(route,'POST',{wallet,action,input:{id}});
  assert.equal(prepared.connection.id,id);assert.equal(prepared.connection.sentryId,sentryId);
 }
 assert.ok(queries.every(value=>value===sentryId));
 // Normalization must not authorize a request that targets another sentry.
 manager.readChain=async route=>route==='/graphene/state/platform/sentries'?[sentry]:route.includes('/applications?')?[{...request,sentryId:'0x'+'9'.repeat(40)}]:[];
 await assert.rejects(manager.dispatch(route,'POST',{wallet,action:'approveApplication',input:{id:'0x03'}}),/different node/);
});

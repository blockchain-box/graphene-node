import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { walletNodes } from './node-wallet.js';
import { NodeManager } from './node-manager.js';
const wallet='0x'+'1'.repeat(40),foreign='0x'+'9'.repeat(40);
const validator={wallet,registered:true,agentAddress:'0x'+'2'.repeat(40),nodeId:'a'.repeat(40),encryptionPublicKey:'b'.repeat(64),networkPublicKey:Buffer.alloc(32).toString('base64'),moniker:'Wallet validator',stake:'1000000000000000000'};
const sentry={sentryId:'0x'+'3'.repeat(40),operator:wallet,tendermintNodeId:'c'.repeat(40),encryptionPublicKey:'d'.repeat(64),name:'Wallet sentry',country:'DE',capacity:'20',active:true,p2pHost:'sentry.example.com',p2pPort:26656};
function network(){const state={validator:{...validator},sentries:[{...sentry}],applications:[{id:'1',validator:wallet,sentryId:sentry.sentryId,status:'Pending'}],assignments:[{id:'4',validator:wallet,sentryId:sentry.sentryId,status:'Active'}]};return {state,read:async route=>route.includes('/validators/')?state.validator:route.includes('/sentries')?state.sentries:route.includes('/applications')?state.applications:route.includes('/assignments')?state.assignments:[]};}
function manager(t,readChain){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'wallet-inventory-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return new NodeManager({directory,runtimeFactory:()=>{throw new Error('Discovery must not create a runtime');},p2p:{},readChain});}
const route=(node,action)=>`/wallets/${wallet}/nodes/${node.role}/${node.setup.agentAddress}/${action}`;
test('wallet discovery returns its validator and all sentries, including inactive ones, and filters foreign records',async()=>{
 const {state,read}=network();state.sentries.push({...sentry,sentryId:'0x'+'4'.repeat(40),active:false},{...sentry,sentryId:'0x'+'5'.repeat(40),operator:foreign},sentry);
 const result=await walletNodes(wallet,read);assert.equal(result.nodes.length,3);assert.equal(result.nodes.filter(n=>n.role==='validator').length,1);assert.equal(result.nodes.filter(n=>n.role==='sentry').length,2);assert.equal(result.nodes.filter(n=>!n.active).length,1);assert.ok(result.nodes.every(n=>n.chainOnly&&!n.unlocked&&n.ownerWallet===wallet));assert.equal(result.nodes[0].setup.consensusPublicKey,validator.networkPublicKey);
});
test('wallet discovery normalizes addresses, verifies ownership and rejects invalid or failed reads',async()=>{
 const {state,read}=network();state.validator.wallet=foreign;state.sentries=[];assert.equal((await walletNodes(wallet,read)).nodes.length,0);
 await assert.rejects(walletNodes('invalid',read),/valid wallet/);await assert.rejects(walletNodes(wallet,async()=>{throw new Error('network down');}),/network down/);
 await assert.rejects(walletNodes(wallet,async r=>r.includes('/sentries')?{}:null),/invalid sentry/);
 const mixed='0x'+'AB'.repeat(20),calls=[];await walletNodes(mixed,async r=>{calls.push(r);return r.includes('/sentries')?[]:null;});assert.ok(calls.every(r=>r.includes(mixed.toLowerCase())));
});
test('discovering nodes never writes profiles, identities or unlocks and does not grant runtime control',async t=>{
 const {read}=network(),m=manager(t,read);const inventory=await m.dispatch(`/wallets/${wallet}/nodes`,'GET');assert.equal(inventory.nodes.length,2);assert.deepEqual(m.nodes,[]);assert.equal(m.unlocked.size,0);assert.deepEqual(fs.readdirSync(m.directory),[]);
 await assert.rejects(m.dispatch(`/wallets/${wallet}/nodes/sentry/${sentry.sentryId}/start`,'POST',{wallet}),/not supported/);
 await assert.rejects(m.dispatch(`/wallets/${wallet}/nodes`,'POST',{}),/read-only/);
});
test('registered nodes support owner wallet actions without requiring encrypted node keys',async t=>{
 const {read}=network(),m=manager(t,read),{nodes}=await m.dispatch(`/wallets/${wallet}/nodes`,'GET'),v=nodes.find(n=>n.role==='validator'),s=nodes.find(n=>n.role==='sentry');
 assert.equal((await m.dispatch(route(v,'chain'),'GET')).ownerMatches,true);
 for(const [node,action,input] of [[v,'delegateStake',{amount:'2'}],[v,'cancelApplication',{id:'1'}],[s,'approveApplication',{id:'1'}],[s,'rejectApplication',{id:'1'}],[s,'revokeAssignment',{id:'4'}]]){
  const prepared=await m.dispatch(route(node,'transaction'),'POST',{wallet,action,input});assert.equal(prepared.wallet,wallet);assert.equal(prepared.transaction.from,wallet);
 }
 assert.deepEqual(m.nodes,[]);assert.equal(m.unlocked.size,0);
});
test('wallet actions recheck owner, role, registration and request ownership on every review',async t=>{
 const {state,read}=network(),m=manager(t,read),{nodes}=await m.dispatch(`/wallets/${wallet}/nodes`,'GET'),s=nodes.find(n=>n.role==='sentry');
 await assert.rejects(m.dispatch(route(s,'transaction'),'POST',{wallet:foreign,action:'approveApplication',input:{id:'1'}}),/owns/);
 await assert.rejects(m.dispatch(route(s,'transaction'),'POST',{wallet,action:'delegateStake',input:{amount:'1'}}),/validator/);
 state.applications[0].sentryId='0x'+'8'.repeat(40);await assert.rejects(m.dispatch(route(s,'transaction'),'POST',{wallet,action:'approveApplication',input:{id:'1'}}),/different node/);
 state.sentries[0].operator=foreign;await assert.rejects(m.dispatch(route(s,'chain'),'GET'),/not registered/);
});
test('remote forwarding allows scoped wallet routes and rejects runtime and arbitrary queries',async t=>{
 const m=manager(t,network().read),id='a'.repeat(16);m.remotes=[{id}];m.remoteTokens.set(id,'test');m.remoteConnections.set(id,{origin:'http://127.0.0.1:12345'});const calls=[];m.remoteFetch=async(url,options)=>{calls.push([url,options]);return {ok:true,json:async()=>({nodes:[]})};};
 await m.proxy(id,{route:`/wallets/${wallet}/nodes`,method:'GET'});assert.equal(calls.length,1);
 await assert.rejects(m.proxy(id,{route:`/wallets/${wallet}/nodes/sentry/${sentry.sentryId}/start`,method:'POST'}),/not supported/);
 await assert.rejects(m.proxy(id,{route:`/wallets/${wallet}/nodes?rpc=http://foreign`,method:'GET'}),/not supported/);
});

test('sentry review includes verified request context and rejects a request that changed status',async t=>{
 const {state,read}=network(),m=manager(t,read),{nodes}=await m.dispatch(`/wallets/${wallet}/nodes`,'GET'),s=nodes.find(n=>n.role==='sentry');
 const prepared=await m.dispatch(route(s,'transaction'),'POST',{wallet,action:'approveApplication',input:{id:'1'}});
 assert.deepEqual(prepared.connection,{id:'1',validator:wallet,sentryId:sentry.sentryId});
 state.applications[0].status='Approved';
 await assert.rejects(m.dispatch(route(s,'transaction'),'POST',{wallet,action:'approveApplication',input:{id:'1'}}),/already changed/);
});

test('agent top-up requires the connected registered owner and targets the public agent account',async t=>{
 const {read}=network(),m=manager(t,read),{nodes}=await m.dispatch(`/wallets/${wallet}/nodes`,'GET'),node=nodes.find(n=>n.role==='validator');
 const action=await m.dispatch(route(node,'transaction'),'POST',{wallet,action:'fundAgent',input:{amount:'0.25'}});assert.equal(action.transaction.to,validator.agentAddress);assert.equal(BigInt(action.transaction.value),250000000000000000n);
 await assert.rejects(m.dispatch(route(node,'transaction'),'POST',{wallet:foreign,action:'fundAgent',input:{amount:'1'}}),/owns/);
});
test('connection requests reject active sentries with unusable encryption keys',async t=>{
 const {state,read}=network(),m=manager(t,read),{nodes}=await m.dispatch(`/wallets/${wallet}/nodes`,'GET'),node=nodes.find(n=>n.role==='validator');state.applications=[];state.assignments=[];state.sentries[0].encryptionPublicKey='malformed registered key';
 await assert.rejects(m.dispatch(route(node,'transaction'),'POST',{wallet,action:'applyToSentry',input:{sentryId:sentry.sentryId}}),/invalid registered encryption key/);
});

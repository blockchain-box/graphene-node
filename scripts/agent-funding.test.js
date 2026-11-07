import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareWalletAction,readAgentFunding} from './node-wallet.js';
const owner='0x'+'1'.repeat(40),agent='0x'+'2'.repeat(40),setup={role:'validator',name:'Home validator',agentAddress:agent};
const rpc=(balance,gasPrice)=>async(route,options)=>({result:JSON.parse(options.body).method==='eth_getBalance'?balance:gasPrice});
test('agent funding is a native transfer to the agent, never a staking contract call',()=>{
 const action=prepareWalletAction(setup,owner,'fundAgent',{amount:'0.125'});assert.equal(action.funding,true);assert.equal(action.transaction.from,owner);assert.equal(action.transaction.to,agent);assert.equal(action.transaction.data,'0x');assert.equal(BigInt(action.transaction.value),125000000000000000n);
 for(const amount of ['0','-1','oops','1e4'])assert.throws(()=>prepareWalletAction(setup,owner,'fundAgent',{amount}));assert.throws(()=>prepareWalletAction(setup,agent,'fundAgent',{amount:'1'}),/already the agent/);
});
test('zero gas price requires no validator top-up even with an empty agent account',async()=>{
 const status=await readAgentFunding(setup,rpc('0x0','0x0'));assert.equal(status.status,'free');assert.equal(status.balanceWei,'0');
});
test('paid publication networks distinguish empty and funded accounts without claiming adequacy',async()=>{
 assert.equal((await readAgentFunding(setup,rpc('0','1'))).status,'empty');const status=await readAgentFunding(setup,rpc('1000000000000000','0x2'));assert.equal(status.status,'funded');assert.equal(status.gasPriceWei,'2');
});
test('the current sentry workflow does not require automatic transaction funding',async()=>{
 assert.equal((await readAgentFunding({...setup,role:'sentry'},rpc('0','1'))).status,'not-required');
});
test('failed or malformed RPC reads never pretend the agent has funds or fees are free',async()=>{
 for(const read of [rpc('nonsense','0'),async()=>{throw new Error('offline');},async()=>({error:{message:'no balance'}})])assert.equal((await readAgentFunding(setup,read)).status,'unavailable');
});

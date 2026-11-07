import {test} from 'node:test';import assert from 'node:assert/strict';
import {readValidatorRewards,chainJson} from './node-wallet.js';
const owner='0x'+'1'.repeat(40);
test('validator rewards use the same owner-address endpoint as explorer and preserve base units',async()=>{
 let requested;const exact='123456789012345678901234567';const reward=await readValidatorRewards(owner,async route=>{requested=route;return exact;});assert.equal(reward.pendingWei,exact);assert.equal(reward.status,'ready');assert.equal(requested,'/graphene/state/stake/validator/reward?chainId=9876&validatorAddress='+owner);
});
test('unknown or unsafe reward data is unavailable, never a fabricated zero',async()=>{
 for(const result of [null,{},Number.MAX_SAFE_INTEGER+1,'not-a-number'])assert.equal((await readValidatorRewards(owner,async()=>result)).status,'unavailable');assert.equal((await readValidatorRewards(owner,async()=>0)).pendingWei,'0');
});
test('native JSON BigInteger reward responses are read without floating-point conversion',async()=>{
 const previous=globalThis.fetch;try{globalThis.fetch=async()=>({ok:true,status:200,text:async()=> '123456789012345678901234567',json:async()=>{throw new Error('Must not parse rewards into a number');}});assert.equal(await chainJson('/graphene/state/stake/validator/reward?chainId=9876&validatorAddress='+owner),'123456789012345678901234567');}finally{globalThis.fetch=previous;}
});

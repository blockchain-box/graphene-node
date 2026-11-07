import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validatorDowntimeImpact,nodeChainState,chainJson} from './node-wallet.js';
const scale=10n**18n;
const validator={signedBlocks:'90',windowBlocks:'100',participationScore:String(scale*9n/10n),selfStake:String(1000n*scale),totalDelegatorStake:String(500n*scale),effectiveWeight:String(1350n*scale)};
test('downtime projects the consensus cumulative participation formula without inventing a stake slash',()=>{
 const impact=validatorDowntimeImpact(validator);
 assert.equal(impact.status,'ready');assert.equal(impact.stakeSlashWei,'0');assert.equal(impact.missedBlocks,'10');
 for(const row of impact.projections){
  const score=90n*scale/(100n+BigInt(row.missedBlocks));
  assert.equal(row.score,String(score));assert.equal(row.effectiveWeightWei,String(1500n*scale*score/scale));
  assert.equal(row.weightReductionWei,String(1350n*scale-BigInt(row.effectiveWeightWei)));
 }
});
test('exiting validators and unsigned probes are exempt exactly as in BeginBlock',()=>{
 assert.equal(validatorDowntimeImpact({...validator,exitRequestedHeight:'10'}).status,'exiting');
 assert.equal(validatorDowntimeImpact({...validator,signedBlocks:'0',windowBlocks:'0',participationScore:'0',effectiveWeight:'0'}).status,'awaiting-signature');
 // A genesis validator with full initial score has no probe exemption.
 assert.equal(validatorDowntimeImpact({...validator,signedBlocks:'0',windowBlocks:'0',participationScore:String(scale)}).projections[0].score,'0');
});
test('incomplete, inconsistent or unsafe inputs cannot display a fabricated penalty estimate',()=>{
 for(const value of [null,{}, {...validator,signedBlocks:'101'}, {...validator,participationScore:String(scale+1n)}, {...validator,effectiveWeight:1e24}, {...validator,windowBlocks:'bad'}])assert.equal(validatorDowntimeImpact(value).status,'unavailable');
});
test('real native stake response addresses resolve the owner validator for exit and penalty state',async()=>{
 const wallet='0x'+'1'.repeat(40),setup={role:'validator',agentAddress:'0x'+'2'.repeat(40),nodeId:'peer',encryptionPublicKey:'key',consensusPublicKey:'consensus'};
 const state=await nodeChainState(setup,wallet,async route=>route.includes('/platform/validators/')?{...setup,registered:true,wallet,networkPublicKey:'consensus'}:route.includes('/stake/validators?')?[{...validator,address:{address:wallet,bytes:[],zero:false}}]:[]);
 assert.equal(state.downtime.status,'ready');assert.equal(state.staking.address.address,wallet);
});
test('native stake JSON preserves integer precision without changing address byte arrays',async()=>{
 const previous=globalThis.fetch;
 try{
  globalThis.fetch=async()=>({ok:true,status:200,text:async()=> '[{"selfStake":123456789012345678901234567,"participationScore":999999999999999999,"signedBlocks":90,"windowBlocks":100,"address":{"bytes":[1,-2]}}]'});
  const [value]=await chainJson('/graphene/state/stake/validators?chainId=9876');
  assert.equal(value.selfStake,'123456789012345678901234567');assert.equal(value.participationScore,'999999999999999999');assert.equal(value.signedBlocks,90);assert.deepEqual(value.address.bytes,[1,-2]);
 }finally{globalThis.fetch=previous;}
});

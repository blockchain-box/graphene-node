import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Interface } from 'ethers';
import { prepareWalletAction } from './node-wallet.js';
const abi=new Interface(JSON.parse(fs.readFileSync(new URL('../../graphene-quarkus/base/src/main/resources/META-INF/abi/v0/abi.json',import.meta.url),'utf8')));
const wallet='0x'+'1'.repeat(40);
const validator={role:'validator',agentAddress:wallet,name:'Node',nodeId:'a'.repeat(40),consensusPublicKey:Buffer.alloc(32).toString('base64'),encryptionPublicKey:'b'.repeat(64)};
const sentry={...validator,role:'sentry',p2pHost:'sentry.example.com',p2pPort:26656};
for(const [action,setup,input] of [
 ['removeValidator',validator,{}],['unlockStake',validator,{}],
 ['registerValidator',validator,{amount:'1'}],['registerSentry',sentry,{country:'DE',capacity:20}],
 ['updateSentryHost',sentry,{host:'new.example.com',port:26656}],['applyToSentry',validator,{sentryId:wallet}],
 ['approveApplication',sentry,{id:'1'}],['rejectApplication',sentry,{id:'1'}],
 ['cancelApplication',validator,{id:'1'}],['revokeAssignment',sentry,{id:'1'}],
])test(`launcher ${action} selector matches the native contract`,()=>{
 const prepared=prepareWalletAction(setup,wallet,action,input);assert.equal(prepared.transaction.data.slice(0,10),abi.getFunction(action).selector);
});

for (const [action, setup] of [
 ['approveApplication', sentry], ['rejectApplication', sentry],
 ['cancelApplication', validator], ['revokeAssignment', sentry],
]) test(`${action} accepts hex IDs returned by the platform API without losing precision`, () => {
 for (const id of ['0x02', '0x20000000000001', '0x' + 'f'.repeat(64)]) {
  const prepared = prepareWalletAction(setup, wallet, action, { id });
  assert.equal(abi.decodeFunctionData(action, prepared.transaction.data)[0], BigInt(id));
 }
});

test('request IDs reject malformed, unsafe numeric and overflowing uint256 values', () => {
 for (const id of [undefined, null, '', '-1', '1.2', '0x', '0xgg', '0x' + '1'.repeat(65), (1n << 256n).toString(), Number.MAX_SAFE_INTEGER + 1, {}, []]) {
  assert.throws(() => prepareWalletAction(sentry, wallet, 'approveApplication', { id }), /Choose a valid request or assignment/);
 }
 for (const id of ['2', 2, ((1n << 256n) - 1n).toString()]) {
  const prepared = prepareWalletAction(sentry, wallet, 'approveApplication', { id });
  assert.equal(abi.decodeFunctionData('approveApplication', prepared.transaction.data)[0], BigInt(id));
 }
});

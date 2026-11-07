import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validatorExitStatus, prepareWalletAction } from './node-wallet.js';
import { NodeManager } from './node-manager.js';
import { Interface } from 'ethers';
const wallet = '0x' + '1'.repeat(40);
const setup = { role:'validator', name:'Validator', agentAddress:'0x'+'2'.repeat(40), nodeId:'a'.repeat(40), encryptionPublicKey:'b'.repeat(64), consensusPublicKey:Buffer.alloc(32).toString('base64') };
const staking = { address:{value:wallet}, exitRequestedHeight:'100', exitEffectiveHeight:'102', withdrawableHeight:'112' };
test('safe stop requires committed progress under the new set; withdrawal waits for unbonding', () => {
 assert.deepEqual(validatorExitStatus(null, 200), {requested:false,safeToStop:false,canWithdraw:false});
 assert.equal(validatorExitStatus(staking, 101).safeToStop, false);
 assert.equal(validatorExitStatus(staking, 102).safeToStop, true);
 assert.equal(validatorExitStatus(staking, 111).canWithdraw, false);
 assert.equal(validatorExitStatus(staking, 112).canWithdraw, true);
 for (const value of [undefined, null, -1, 'oops', Number.MAX_SAFE_INTEGER + 1]) assert.equal(validatorExitStatus(staking, value).safeToStop, false);
 for (const value of [undefined, null, '101', 'oops']) assert.equal(validatorExitStatus({...staking,exitEffectiveHeight:value}, 200).safeToStop, false);
});
test('withdraw self-stake has a separate ABI action from exit request', () => {
 const abi = new Interface(['function unlockStake()', 'function removeValidator(address)']);
 const exit = prepareWalletAction(setup, wallet, 'removeValidator');
 assert.match(exit.label, /keep the node running/);
 assert.equal(exit.transaction.data.slice(0,10), abi.getFunction('removeValidator').selector);
 assert.equal(prepareWalletAction(setup, wallet, 'unlockStake').transaction.data, abi.encodeFunctionData('unlockStake'));
});
test('launcher refuses early or unverifiable stops and allows a confirmed exit', async t => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'validator-exit-'));
 t.after(() => fs.rmSync(directory, {recursive:true,force:true}));
 let height = 101, stops = 0;
 const readChain = async route => route.includes('/platform/validators/') ? {...setup,wallet,registered:true,networkPublicKey:setup.consensusPublicKey}
  : route.includes('/stake/validators?') ? [staking] : route.endsWith('/sync-status') ? {lastStateSyncedBlock:height} : [];
 const manager = new NodeManager({directory,readChain,p2p:{}});
 const node = {id:'validator-test',role:'validator',setup};
 manager.nodes.push(node);
 manager.unlocked.set(node.id, {status:async()=>({state:'running'}),stop:async()=>{stops++;}});
 await assert.rejects(manager.act(node,'stop',wallet), /Keep this validator running/);
 assert.equal(stops, 0);
 await assert.rejects(manager.act(node,'stop'), /owner wallet/);
 height = 102;
 await manager.act(node,'stop',wallet);
 await new Promise(r=>setImmediate(r));
 assert.equal(stops, 1);
});

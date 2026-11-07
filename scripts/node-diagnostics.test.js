import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {NodeManager} from './node-manager.js';import {tendermintValidatorAddress} from '../agents/lib/node-setup.js';
test('Tendermint address derives from its Ed25519 key, not the owner wallet',()=>{
 assert.equal(tendermintValidatorAddress(Buffer.alloc(32).toString('base64')),'66687AADF862BD776C8FC18B8E9F8E2008971485');assert.equal(tendermintValidatorAddress('bad-key'),null);
});
test('Doctor exposes a fixed read-only runner, deduplicates requests and rejects browser commands',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'doctor-manager-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));let finish,calls=0;
 const manager=new NodeManager({directory,p2p:{},runtimeFactory(){},doctorRunner:()=>{calls++;return new Promise(r=>finish=r);}});
 const first=manager.dispatch('/doctor','POST',{}),second=manager.dispatch('/doctor','POST',{});await new Promise(r=>setImmediate(r));assert.equal(calls,1);finish({ok:true,checks:[{label:'Fixture check',ok:true}],note:'Read only'});assert.equal((await first).ok,true);assert.equal((await second).checks.length,1);
 await assert.rejects(manager.dispatch('/doctor','POST',{command:'arbitrary command'}),/no command arguments/);
 assert.ok((await manager.dispatch('/capabilities','GET')).features.includes('agent-funding-v1'));
});

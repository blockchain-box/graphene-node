import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./node-manager-ui.js',import.meta.url),'utf8');
const parser=source.match(/function publicSetup\(raw\)\{[\s\S]*?\n\}/)[0];
const parse=vm.runInNewContext('('+parser+')');
const setup={version:1,role:'validator',name:'My node',agentAddress:'0x'+'12'.repeat(20),encryptionPublicKey:'23'.repeat(32),nodeId:'34'.repeat(20),consensusPublicKey:Buffer.alloc(32,7).toString('base64')};
test('launcher public setup parsing keeps consensus and transport keys separate',()=>{
 const parsed=parse(JSON.stringify({...setup,transportPublicKey:'45'.repeat(32)}));assert.equal(parsed.consensusPublicKey,setup.consensusPublicKey);assert.equal(parsed.transportPublicKey,'45'.repeat(32));assert.throws(()=>parse(JSON.stringify({...setup,consensusPublicKey:'45'.repeat(32)})),/identity fields/);
});
test('launcher rejects secret exports, oversized files and malformed explanatory metadata',()=>{
 for(const field of ['seed','privateKey','grphInviteKey','keystore'])assert.throws(()=>parse(JSON.stringify({...setup,[field]:'secret'})),/Private key/);
 assert.throws(()=>parse(' '.repeat(16385)),/small public/);assert.throws(()=>parse(JSON.stringify({...setup,agentRole:12})),/documentation/);assert.throws(()=>parse(JSON.stringify({...setup,fieldDescriptions:{privateKey:'secret'}})),/field descriptions/);
 const parsed=parse(JSON.stringify({...setup,agentRole:'Validator background service',fieldDescriptions:{agentAddress:'Public agent address'}}));assert.equal(parsed.agentRole,undefined);
});
test('sentry import requires its peer identity and reachable host and port',()=>{
 const sentry={...setup,role:'sentry',p2pHost:'sentry.example.com',p2pPort:26656};assert.equal(parse(JSON.stringify(sentry)).port,26656);
 for(const values of [{p2pPort:0},{p2pPort:65536},{p2pPort:1.5},{p2pHost:'bad/host'},{nodeId:undefined}])assert.throws(()=>parse(JSON.stringify({...sentry,...values})));
});

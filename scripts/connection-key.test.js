import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sealInviteKey} from '../agents/validator-agent/src/monitor.js';
import {generateAll} from '../agents/validator-agent/src/keygen.js';

test('malformed registered sentry keys produce an actionable error before NaCl encryption',()=>{
 assert.throws(()=>sealInviteKey('public-invite','invalid registered sentry encryption key'),/registered sentry encryption key.*32 bytes/i);
});
test('valid 32-byte X25519 keys accept plain and 0x-prefixed hex',()=>{
 const key=generateAll().x25519.publicKey;
 for(const value of [key,'0x'+key])assert.match(sealInviteKey('public-invite',value),/^0x[0-9a-f]+$/);
});

test('cached key errors retry only after the registered key becomes valid',async t=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
 const {ApprovalMonitor}=await import('../agents/validator-agent/src/monitor.js');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'agent-key-recovery-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const previous=process.env.STATE_DIR;process.env.STATE_DIR=directory;
 let monitor;try{monitor=new ApprovalMonitor({rpcUrl:'http://fixture/rpc',managePeers:false},{agent:{address:'0x'+'1'.repeat(40)}});}finally{if(previous===undefined)delete process.env.STATE_DIR;else process.env.STATE_DIR=previous;}
 const sentryId='0x'+'2'.repeat(40),assignment={id:'7',sentryId,status:'Active'};let key='invalid registered key',processed=0;
 monitor.processedAssignments.add('7');monitor.errors.set('7',{lastError:'bad public key size',errorType:'PERMANENT'});
 monitor.fetchJson=async route=>route.includes('/assignments?')?[assignment]:[{sentryId,encryptionPublicKey:key}];
 monitor._processAssignment=async value=>{processed++;monitor.processedAssignments.add(value.id);};monitor._saveProcessedAssignments=()=>{};
 await monitor.checkAssignments();assert.equal(processed,0);key='ab'.repeat(32);await monitor.checkAssignments();assert.equal(processed,1);assert.equal(monitor.errors.has('7'),false);await monitor.checkAssignments();assert.equal(processed,1);assignment.encryptedConnectionString='published';monitor.errors.set('7',{lastError:'bad public key size'});monitor.pendingTransactions.set('7','pending-hash');await monitor.checkAssignments();assert.equal(monitor.errors.has('7'),false);assert.equal(monitor.pendingTransactions.has('7'),false);assert.equal(processed,1);
});

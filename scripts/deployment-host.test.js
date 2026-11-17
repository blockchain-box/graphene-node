import test from 'node:test';
import assert from 'node:assert/strict';
import {homePlatform,macDocker,checkMacImages} from './deployment-host.js';
test('home host supports native Apple Silicon and Intel Docker Desktop while retaining Ubuntu',()=>{
  assert.equal(homePlatform('darwin','arm64'),'macos');assert.equal(homePlatform('darwin','x64'),'macos');assert.equal(homePlatform('linux','x64','ID=ubuntu\n'),'ubuntu');
  assert.throws(()=>homePlatform('linux','arm64','ID=ubuntu\n'),/supports/);
});
test('sudo on Mac delegates Docker Desktop to the invoking user',()=>{
  const calls=[];const docker=macDocker({uid:0,env:{SUDO_USER:'operator',SUDO_UID:'501',SUDO_GID:'20'},exists:()=>true,spawn:(binary,args,options)=>{calls.push({binary,args,options});return {status:0,stdout:'ok'};}});
  assert.equal(docker(['info'],'/tmp',true),'ok');assert.equal(calls[0].binary,'/usr/bin/sudo');assert.deepEqual(calls[0].args.slice(0,5),['-H','-u','operator','--','/Applications/Docker.app/Contents/Resources/bin/docker']);
  assert.throws(()=>macDocker({uid:0,env:{}}),/normal Docker Desktop user/);
});
test('Mac preflight refuses emulated amd64 images before installing or starting a signer',()=>{
  const calls=[];const compose={services:{abci:{image:'ghcr.io/test/abci@sha256:'+'a'.repeat(64)}}};
  const docker=args=>{calls.push(args);if(args[0]==='info')return JSON.stringify({OSType:'linux',Architecture:'aarch64',OperatingSystem:'Docker Desktop'});if(args[0]==='context')return 'unix:///Users/operator/.docker/run/docker.sock';if(args[0]==='image')return 'linux/amd64';};
  assert.throws(()=>checkMacImages(compose,docker,'/tmp'),/needs linux\/arm64/);
  assert.ok(!calls.some(args=>args.includes('up')));
});
test('Mac preflight accepts native images and rejects remote Linux engines',()=>{
  const compose={services:{abci:{image:'ghcr.io/test/abci@sha256:'+'a'.repeat(64)}}};
  const docker=args=>args[0]==='info'?JSON.stringify({OSType:'linux',Architecture:'aarch64',OperatingSystem:'Docker Desktop'}):args[0]==='context'?'unix:///Users/operator/.docker/run/docker.sock':args[0]==='image'?'linux/arm64':'';
  assert.equal(checkMacImages(compose,docker,'/tmp'),'arm64');
  assert.throws(()=>checkMacImages(compose,()=>JSON.stringify({OSType:'linux',Architecture:'aarch64',OperatingSystem:'Ubuntu'}),'/tmp'),/local Docker Desktop/);
});
test('missing native images are pulled explicitly for the local Desktop architecture',()=>{
  const image='ghcr.io/test/abci@sha256:'+'a'.repeat(64),calls=[];let present=false;
  const docker=args=>{calls.push(args);if(args[0]==='info')return JSON.stringify({OSType:'linux',Architecture:'arm64',OperatingSystem:'Docker Desktop'});if(args[0]==='context')return 'unix:///Users/operator/.docker/run/docker.sock';if(args[0]==='image'){if(!present)throw new Error('not cached');return 'linux/arm64';}if(args[0]==='pull')present=true;};
  assert.equal(checkMacImages({services:{abci:{image}}},docker,'/tmp'),'arm64');
  assert.deepEqual(calls.find(args=>args[0]==='pull'),['pull','--platform','linux/arm64',image]);
});
test('remote Docker contexts are rejected before images or keys are used',()=>{
  const docker=args=>args[0]==='info'?JSON.stringify({OSType:'linux',Architecture:'arm64',OperatingSystem:'Docker Desktop'}):'ssh://remote.example';
  assert.throws(()=>checkMacImages({services:{}},docker,'/tmp'),/not a remote Docker endpoint/);
});

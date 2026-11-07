import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';import dgram from 'node:dgram';
import HyperDHT from 'hyperdht';
import { openGrphServer, openGrphClient, parseGrphLink, loadTunnelSeed, tunnelPublicKey } from '../agents/lib/grph-tunnel.js';
import { TunnelManager } from '../agents/sentry-agent/src/tunnel-manager.js';
import { composeDefinition } from './local-node-runtime.js';
import { checkpointURL, downloadFile } from './checkpoint-core.js';
import { createSetupServer } from './join-network.js';
import crypto from 'node:crypto';

test('real Grph P2P HTTP and range downloads preserve authentication and signed file bytes',async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'grph-transport-'));let publisher,client;
 const reservation=dgram.createSocket('udp4');await new Promise(r=>reservation.bind(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const dht=HyperDHT.bootstrapper(port,'127.0.0.1');await dht.ready();const bootstrap=['127.0.0.1:'+port];
 const publication=path.join(folder,'public');fs.mkdirSync(path.join(publication,'height-1'),{recursive:true});const bytes=Buffer.from('signed bytes through encrypted Grph P2P');fs.writeFileSync(path.join(publication,'height-1','mpt.tar.gz'),bytes);
 const {server,token}=createSetupServer({directory:path.join(folder,'secrets'),checkpointDirectory:publication});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await client?.close();await publisher?.close();await new Promise(r=>server.close(r));await dht.destroy();fs.rmSync(folder,{recursive:true,force:true});});
 const seed=loadTunnelSeed(path.join(folder,'seed.json'));assert.equal(loadTunnelSeed(path.join(folder,'seed.json')),seed);
 publisher=await openGrphServer({seed,port:server.address().port,bootstrap,timeoutMs:10000});
 const link='grph://'+publisher.key+'#'+token;assert.deepEqual(parseGrphLink(link),{key:publisher.key,token});
 client=await openGrphClient(publisher.key,{bootstrap,timeoutMs:10000});
 assert.equal((await fetch(client.origin+'/manager/nodes')).status,403);
 assert.equal((await fetch(client.origin+'/manager/nodes',{headers:{Authorization:'Bearer '+token}})).status,200);
 const destination=path.join(folder,'download');fs.writeFileSync(destination+'.part',bytes.subarray(0,7));
 await downloadFile(client.origin+'/checkpoints/height-1/mpt.tar.gz',destination,{bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
 assert.deepEqual(fs.readFileSync(destination),bytes);
 assert.equal((await fetch(client.origin+'/checkpoints/height-1/keystore.enc')).status,404);
 assert.equal(checkpointURL('grph://'+publisher.key+'/checkpoints/latest.json').protocol,'grph:');
 for(const url of ['https://downloads.example.com/latest.json','http://example.com/latest.json'])assert.throws(()=>checkpointURL(url),/P2P/);
 assert.equal(fs.statSync(path.join(folder,'seed.json')).mode&0o777,0o600);
});
test('P2P failures destroy the transport and never fall back to a direct connection',async()=>{
 const key=tunnelPublicKey('a'.repeat(64));let destroyed=0;
 await assert.rejects(openGrphClient(key,{timeoutMs:20,clientFactory:()=>({connect:async()=>{},destroy:async()=>{destroyed++;}})}),/P2P tunnel/);
 assert.equal(destroyed,1);
});
test('sentry uses Grph even when an old local-Docker bypass flag is present',async()=>{
 const opened=[];const manager=new TunnelManager({localDockerPeers:true,statePath:path.join(os.tmpdir(),'unused-p2p-test')},{},{allocate:()=>40001,release(){}},{openTunnel:async(key,options)=>{opened.push({key,options});return{client:{state:'listening',destroy:async()=>{}}};}});
 manager.openInviteKey=()=>tunnelPublicKey('b'.repeat(64));manager._saveState=()=>{};
 await manager.connect('validator','encrypted',null);
 assert.equal(opened.length,1);assert.equal(manager.get('validator').transport,'grph');await manager.disconnectAll();
});
test('node bootstrap and legacy-migration target the P2P service with no shared direct peer network',()=>{
 const definition=composeDefinition('/tmp/node/tendermint','id@tendermint-dev:26656','provider-net',{role:'validator',project:'node'});
 const command=definition.services.node.command;
 assert.equal(command[command.indexOf('--p2p.persistent_peers')+1],'id@bootstrap-tunnel:26656');
 assert.deepEqual(definition.services.node.networks,['default']);
 assert.deepEqual(definition.services['bootstrap-source'].networks,['bootstrap','default']);
 assert.deepEqual(definition.services['bootstrap-tunnel'].networks,['default']);
 assert.deepEqual(definition.services.agent.networks,['default']);
 assert.equal(definition.services.agent.environment.LOCAL_DOCKER_PEERS,undefined);
 for(const service of ['bootstrap-source','bootstrap-tunnel']){assert.equal(definition.services[service].restart,'unless-stopped');assert.equal(definition.services[service].ports,undefined);}
 assert.ok(command.includes('--p2p.seeds='));
});

test('identity-sized project names use a Docker-resolvable tunnel service alias', () => {
 const project = 'grph-node-' + 'a'.repeat(40);
 const definition = composeDefinition('/tmp/' + project + '/tendermint', 'id@tendermint-dev:26656', 'provider-net', { project });
 const command = definition.services.node.command;
 assert.equal(command[command.indexOf('--p2p.persistent_peers') + 1], 'id@bootstrap-tunnel:26656');
});

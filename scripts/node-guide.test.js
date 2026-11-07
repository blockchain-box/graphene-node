import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createSetupServer } from './join-network.js';
import { renderNodeGuide, renderReference } from './node-guide.js';
for (const role of ['validator','sentry']) for (const hosted of [false,true]) test(`guide covers ${role} on ${hosted?'server':'computer'}`,()=>{
 const html=renderNodeGuide({role,hosted});assert.ok(html.includes('Set up your '+role));assert.ok(html.includes(hosted?'your hosted server':'your computer'));
 for(const id of ['identity','registration','fund-agent','connections','pair-start','operate','checkpoint-setup','node-agents','checkpoint-export','help']) assert.ok(html.includes(`id="${id}"`),id);
 assert.ok(html.includes(`/?role=${role}&location=${hosted?'server':'local'}&add=1`));assert.ok(html.includes('Registration and node controls are in this launcher. You can complete this workflow without the explorer.'));
 if(role==='sentry'){assert.ok(html.includes('5. Review validator requests'));assert.ok(html.includes('voting power zero'));assert.ok(html.includes('npm run join:sentry'));}
 if(hosted) assert.ok(html.includes('GRAPHENE_P2P_SHARE=1'));
});
test('guide escapes the reference and ignores unrecognized role values',()=>{
 assert.equal(renderReference('<script>bad()</script>'),'<p>&lt;script&gt;bad()&lt;/script&gt;</p>');const html=renderNodeGuide({role:'<script>bad()</script>'});assert.ok(!html.includes('<script>bad()'));assert.ok(html.includes('Set up your validator'));
});
test('launcher serves guide aliases and public reference while keeping APIs private',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'launcher-guide-'));const {server}=createSetupServer({directory,p2p:{close:async()=>{}}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(directory,{recursive:true,force:true});});const base='http://127.0.0.1:'+server.address().port;
 for(const route of ['/operator/guide?role=sentry&location=server','/guide?role=sentry']){const response=await fetch(base+route);assert.equal(response.status,200);assert.match(await response.text(),/Set up your sentry/);}
 for(const name of ['home','layers','help-circle','share-2','box','credit-card','chevron-right','x']){const icon=await fetch(base+'/launcher-icons/'+name+'.svg');assert.equal(icon.status,200);assert.match(icon.headers.get('content-type'),/image\/svg\+xml/);assert.match(await icon.text(),/<svg/);}
 assert.equal((await fetch(base+'/launcher-icons/unknown.svg')).status,404);
 const response=await fetch(base+'/operator?role=sentry');assert.equal(response.status,200);assert.match(await response.text(),/id="setup-guide"/);
 assert.match(await(await fetch(base+'/guide-ui.js')).text(),/loadPublication/);assert.match(await(await fetch(base+'/operator-guide.md')).text(),/# Graphene operator guide/);
 assert.equal((await fetch(base+'/manager/nodes')).status,403);assert.equal((await fetch(base+'/manager/nodes?role=sentry')).status,403);
});
test('checkpoint preview rejects malformed manifests and displays validated metadata as text',async()=>{
 const source=fs.readFileSync(new URL('./node-guide-ui.js',import.meta.url),'utf8');
 async function run(value){const elements={'checkpoint-status':{},'checkpoint-publication':{replaceChildren(...nodes){this.nodes=nodes;}}};vm.runInNewContext(source,{document:{getElementById:id=>elements[id],createElement:()=>({})},location:{hash:''},AbortSignal,fetch:async()=>({ok:true,json:async()=>value})});await new Promise(r=>setImmediate(r));return elements;}
 assert.match((await run({manifest:{height:'<img>'}}))['checkpoint-status'].textContent,/No publisher-tested/);
 const manifest={kind:'graphene-local-checkpoint',chainId:9876,id:'height-1',height:'120',createdAt:new Date().toISOString(),verification:{caughtUp:true},files:Object.fromEntries(['app-state.json','genesis.json','mpt.tar.gz','tendermint.tar.gz'].map(k=>[k,{bytes:100}]))};const output=await run({manifest,signature:'test'});assert.match(output['checkpoint-status'].textContent,/block 120/);assert.equal(output['checkpoint-publication'].nodes[0].href,'/checkpoints/latest.json');
});

test('updated launcher refuses to reuse a running manager without the migrated guide',async t=>{
 const {startSetupLauncher}=await import('./join-network.js');const http=await import('node:http');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'launcher-old-guide-'));
 const old=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({service:'graphene-launcher',pid:process.pid,features:['checkpoint-bootstrap-v1','public-setup-import-v1','node-manager-v1','p2p-manager-v1']}));});await new Promise(r=>old.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>old.close(r));fs.rmSync(directory,{recursive:true,force:true});});const port=old.address().port;
 fs.writeFileSync(path.join(directory,'launcher.json'),JSON.stringify({port,pid:process.pid,token:'a'.repeat(64),config:JSON.stringify([path.join(directory,'keystore.enc'),path.join(directory,'sentry-secrets.json')])}));
 await assert.rejects(startSetupLauncher({directory,port}),/older launcher without the integrated operator guide/);assert.equal(old.listening,true);
});

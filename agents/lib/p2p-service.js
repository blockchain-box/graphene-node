import fs from 'node:fs';
import http from 'node:http';
import { openGrphClient, openGrphServer } from './grph-tunnel.js';
const [mode, file] = process.argv.slice(2);
let connection, ready=false;
const health=http.createServer((req,res)=>{res.writeHead(ready?200:503,{'Content-Type':'application/json'});res.end(JSON.stringify({ready,transport:'grph'}));});
health.listen(3001,'0.0.0.0');
async function stop(){ready=false;await connection?.close().catch(()=>{});health.close();}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{void stop().finally(()=>process.exit(0));});
try {
 const config=JSON.parse(fs.readFileSync(file));
 if(mode==='server')connection=await openGrphServer({seed:config.seed,host:config.host,port:config.port,bootstrap:config.bootstrap});
 else if(mode==='client')connection=await openGrphClient(config.key,{host:'0.0.0.0',port:26656,bootstrap:config.bootstrap});
 else throw new Error('Invalid P2P service mode.');
 ready=true;
 console.log('Grph P2P '+mode+' ready.');
}catch{console.error('Grph P2P tunnel could not start. Check DHT/UDP connectivity and the private tunnel configuration. No direct fallback is enabled.');await stop();process.exitCode=1;}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import HyperDHT from 'hyperdht';
import z32 from 'z32';
import { GrphClient } from '@grph-net/client';
import { GrphServer } from '@grph-net/server';

export function dhtBootstrap(value = process.env.GRAPHENE_DHT_BOOTSTRAP) {
 if (!value) return undefined;
 return value.split(',').map(entry => {
  const address = entry.trim();
  if (!/^[a-zA-Z0-9.-]+:[0-9]{1,5}$/.test(address)) throw new Error('P2P bootstrap addresses must be host:port entries.');
  const port = Number(address.slice(address.lastIndexOf(':') + 1));
  if (port < 1 || port > 65535) throw new Error('Invalid P2P bootstrap port.');
  return address;
 });
}
export function validGrphKey(key) {
 try { return typeof key === 'string' && z32.decode(key).length === 32 && z32.encode(z32.decode(key)) === key; } catch { return false; }
}
export function parseGrphLink(value, { requireToken = true } = {}) {
 let url; try { url = new URL(value); } catch { throw new Error('Paste the complete grph:// P2P connection link.'); }
 if (url.protocol !== 'grph:' || !validGrphKey(url.hostname) || url.port || url.username || url.password || url.search || !['','/'].includes(url.pathname) || (requireToken ? !/^#[a-f0-9]{64}$/i.test(url.hash) : !!url.hash)) throw new Error('Use a grph:// P2P connection link, not an HTTP address or SSH tunnel.');
 return { key: url.hostname, token: url.hash.slice(1) };
}
export function loadTunnelSeed(file) {
 if (fs.existsSync(file)) {
  const { seed } = JSON.parse(fs.readFileSync(file));
  if (!/^[a-f0-9]{64}$/.test(seed || '')) throw new Error('The saved P2P identity is invalid. Preserve it and ask your provider to inspect it.');
  return seed;
 }
 fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
 const seed = crypto.randomBytes(32).toString('hex');
 fs.writeFileSync(file, JSON.stringify({ seed }), { flag:'wx', mode:0o600 });
 return seed;
}
export function tunnelPublicKey(seed) { return z32.encode(HyperDHT.keyPair(Buffer.from(seed, 'hex')).publicKey); }
export async function openGrphServer({ seed, host = '127.0.0.1', port, bootstrap = dhtBootstrap(), serverFactory = options => new GrphServer(options), timeoutMs = 60000 }) {
 const server = serverFactory({ silent:true, bootstrap });
 let timer;
 try {
  await Promise.race([server.start({seed,host,port}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('P2P publication timed out. Check UDP connectivity and the DHT bootstrap configuration.')),timeoutMs);})]);
  return { key:server.key, close:()=>server.destroy() };
 } catch(error) { await server.destroy().catch(()=>{}); throw error; }
 finally { clearTimeout(timer); }
}
export async function openGrphClient(key, { host = '127.0.0.1', port = 0, bootstrap = dhtBootstrap(), clientFactory = options => new GrphClient(options), timeoutMs = 60000 } = {}) {
 if (!validGrphKey(key)) throw new Error('Invalid Grph P2P public key.');
 const client = clientFactory({ key, silent:true, bootstrap });
 let timer, expired = false;
 try {
  await Promise.race([new Promise((resolve,reject)=>{
   Promise.resolve(client.connect({host,port},()=>{ if(expired)void client.destroy();else resolve(); })).catch(reject);
  }),new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(new Error('P2P tunnel could not connect. Check the peer launcher and UDP/DHT reachability.'));},timeoutMs);})]);
  const address = client.proxy?.address?.();
  if (!address || typeof address !== 'object' || !address.port) throw new Error('The P2P tunnel did not open its local endpoint.');
  return { origin:'http://127.0.0.1:'+address.port, port:address.port, client, close:()=>client.destroy() };
 } catch(error) { expired=true;await client.destroy().catch(()=>{});throw error; }
 finally {clearTimeout(timer);}
}
export class LauncherP2P {
 constructor({ directory, bootstrap = dhtBootstrap() }) { this.directory=directory;this.bootstrap=bootstrap;this.clients=new Set();this.publication=null; }
 async publish(port) {
  if (!this.publication) this.publication=openGrphServer({seed:loadTunnelSeed(path.join(this.directory,'launcher-p2p.json')),port,bootstrap:this.bootstrap}).catch(error=>{this.publication=null;throw error;});
  return this.publication;
 }
 async connect(key) { const connection=await openGrphClient(key,{bootstrap:this.bootstrap});this.clients.add(connection);return connection; }
 async close() { const clients=[...this.clients];this.clients.clear();await Promise.allSettled(clients.map(c=>c.close()));if(this.publication){const published=await this.publication.catch(()=>null);await published?.close();this.publication=null;} }
}

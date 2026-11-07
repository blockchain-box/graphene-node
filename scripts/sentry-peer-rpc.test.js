import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import { dialPeer, peerConnections } from '../agents/sentry-agent/src/peer-rpc.js';

test('sentry verifies a listening proxy, authenticated peer ID, outbound direction and proxy address', async (t) => {
  const nodeId = 'ab'.repeat(20), calls = [];
  let peers = [{ node_info: { id: nodeId }, remote_ip: '127.0.0.1', is_outbound: true }];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const call = JSON.parse(raw); calls.push(call);
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: call.method === 'net_info' ? { peers } : { log: 'dialing' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = { tendermintRpcUrl: `http://127.0.0.1:${server.address().port}`, peerHost: '127.0.0.1' };
  const entry = { client: { state: 'listening' }, peer: { nodeId }, port: 40001 };
  const clients = new Map([['validator', entry]]);
  assert.equal((await peerConnections(config, clients))[0].peerConnected, true);
  entry.client.state = 'waiting'; assert.equal((await peerConnections(config, clients))[0].peerConnected, false);
  entry.client.state = 'listening'; peers[0].remote_ip = '10.0.0.1'; assert.equal((await peerConnections(config, clients))[0].peerConnected, false);
  peers[0].remote_ip = '127.0.0.1'; peers[0].is_outbound = false; assert.equal((await peerConnections(config, clients))[0].peerConnected, false);
  peers[0].is_outbound = true; peers[0].node_info.id = 'cd'.repeat(20); assert.equal((await peerConnections(config, clients))[0].peerConnected, false);
  peers[0].node_info.id = nodeId; peers[0].remote_ip = '172.20.0.4';
  t.mock.method(os, 'networkInterfaces', () => ({ eth0: [{ address: '172.20.0.4', internal: false }] }));
  assert.equal((await peerConnections(config, clients))[0].peerConnected, false);
  assert.equal((await peerConnections({ ...config, proxyHost: '0.0.0.0' }, clients))[0].peerConnected, true);
  await dialPeer(config, nodeId, 40001);
  assert.deepEqual(calls.at(-1).params.peers, [`${nodeId}@127.0.0.1:40001`]);
  await assert.rejects(dialPeer(config, 'invalid-id', 40001), /Invalid validator peer/);
});


import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRpcProvider } from '../agents/lib/rpc-provider.js';

test('agent interoperates with the native single-call RPC and string response IDs', { timeout: 5000 }, async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw); requests.push(payload);
    const call = Array.isArray(payload) ? payload[0] : payload;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: String(call.id), result: call.method === 'eth_chainId' ? '0x2694' : '0x01' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const provider = createRpcProvider(`http://127.0.0.1:${server.address().port}`);
  t.after(async () => { provider.destroy(); await new Promise((resolve) => server.close(resolve)); });
  assert.equal(await provider.getBalance('0x' + '1'.repeat(40)), 1n);
  assert.equal((await provider.getNetwork()).chainId, 9876n);
  assert.ok(requests.every((request) => !Array.isArray(request)), 'Native RPC accepts single calls');
});

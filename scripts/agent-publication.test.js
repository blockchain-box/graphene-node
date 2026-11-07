import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ethers } from 'ethers';
import { generateAll } from '../agents/validator-agent/src/keygen.js';
import { submitConnectionString } from '../agents/validator-agent/src/monitor.js';

test('publication signs an explicit legacy transaction and confirms a native receipt without Ethereum block fields', async (t) => {
  const secrets = generateAll(), sentry = generateAll();
  const methods = []; let signed; let reads = 0; let receiptStatus = '0x1'; let balance = '1000000000000000000'; let gasPrice = '0x1';
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw); methods.push(request.method);
    const values = { eth_chainId: '0x2694', eth_getBalance: balance, eth_estimateGas: '0x5208', eth_gasPrice: gasPrice, eth_getTransactionCount: '0x0' };
    let result = values[request.method];
    if (request.method === 'eth_sendRawTransaction') { signed = ethers.Transaction.from(request.params[0]); result = signed.hash; }
    if (request.method === 'eth_getTransactionReceipt') { result = reads++ ? { status: receiptStatus, blockNumber: '0x01', transactionHash: signed.hash } : null; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: String(request.id), ...(result === undefined ? { error: { code: -32000, message: 'Unsupported Ethereum block request' } } : { result }) }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const submitted = [];
  const config = { rpcUrl: `http://127.0.0.1:${server.address().port}`, contractAddress: '0x0000000000000000000000000000000000000004', receiptPollMs: 1, onSubmitted: (hash) => submitted.push(hash) };
  const result = await submitConnectionString(config, secrets, '0x02', sentry.x25519.publicKey);
  assert.equal(result.success, true, result.error);
  assert.equal(signed.type, 0); assert.equal(signed.chainId, 9876n);
  assert.equal(signed.from.toLowerCase(), secrets.agent.address.toLowerCase());
  assert.equal(signed.to.toLowerCase(), config.contractAddress); assert.equal(signed.value, 0n);
  assert.equal(signed.gasPrice, 1n); assert.equal(signed.gasLimit, 25200n);
  assert.deepEqual(submitted, [signed.hash]);
  assert.ok(!methods.includes('eth_getBlockByNumber'));
  methods.length = 0;
  const resumed = await submitConnectionString({ ...config, pendingTransactionHash: signed.hash }, secrets, '0x02', sentry.x25519.publicKey);
  assert.equal(resumed.success, true); assert.deepEqual(methods.filter((method) => method !== 'eth_chainId'), ['eth_getTransactionReceipt']);
  receiptStatus = '0x0';
  const rejected = await submitConnectionString({ ...config, pendingTransactionHash: signed.hash }, secrets, '0x02', sentry.x25519.publicKey);
  assert.equal(rejected.success, false); assert.equal(rejected.errorType, 'permanent');
  assert.equal(methods.includes('eth_sendRawTransaction'), false);
  balance = '0x0'; methods.length = 0;
  const unfunded = await submitConnectionString(config, secrets, '0x02', sentry.x25519.publicKey);
  assert.equal(unfunded.success, false); assert.equal(unfunded.errorType, 'transient');
  assert.equal(methods.includes('eth_sendRawTransaction'), false);
  gasPrice = '0x0'; receiptStatus = '0x1';
  const free = await submitConnectionString(config, secrets, '0x02', sentry.x25519.publicKey);
  assert.equal(free.success, true, 'A zero-fee chain must not require funding');
  assert.equal(signed.gasPrice, 0n);
});

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { governanceArguments } from './governance.js';
import { GrphRestClient } from './GrphRestClient.js';

it('keeps token amounts exact in governance ABI payloads', () => {
  const amount = '100000000000000000001';
  const [operation, payload] = governanceArguments('vote', { id: '0xabc', amount, support: true });
  assert.equal(operation, 'vote');
  assert.deepEqual(JSON.parse(payload), { id: '0xabc', amount, support: true });
});

it('reads authoritative governance records through app-evm with escaped identifiers', async (t) => {
  const seen: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    seen.push(url);
    return new Response(JSON.stringify({ id: 'proposal', deposit: '100000000000000000001' }));
  });
  const client = new GrphRestClient('http://localhost:3003/graphene-evm');
  const result = await client.getGovernanceProposal('9876', 'a/b');
  assert.equal(result.deposit, '100000000000000000001');
  assert.equal(seen[0], 'http://localhost:3003/graphene-evm/graphene/state/governance/9876/proposals/a%2Fb');
});

it('preserves source-qualified fee assets and exact execution amounts', () => {
  const change = { parameter: 'feeAccountTransfer' as const, asset: '55:0x' + '77'.repeat(20),
    value: '100000000000000000001', recipient: '0x' + '11'.repeat(20), title: 'Use invoice fees', description: '' };
  assert.deepEqual(JSON.parse(governanceArguments('propose', change)[1]), change);
  const burn = { parameter: 'feeAccountBurn' as const, asset: change.asset, value: 'ALL', title: 'Burn invoice fees', description: '' };
  assert.deepEqual(JSON.parse(governanceArguments('draft', burn)[1]), burn);
});

it('encodes governance mint proposals with exact amount and destination', () => {
  const change = { parameter: 'tokenMint' as const, token: '0x' + '11'.repeat(20), recipient: '0x' + '22'.repeat(20),
    amount: '100000000000000000001', title: 'Mint by community vote', description: '' };
  assert.deepEqual(JSON.parse(governanceArguments('propose', change)[1]), change);
});

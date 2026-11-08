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

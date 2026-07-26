import type {NewBlockMessage} from '@grph/evm-client';
import {GrphClientBuilder} from '@grph/evm-client';

async function main() {
  const client = GrphClientBuilder.configure()
    .baseUrl('http://localhost:3003/graphene-evm')
    .rpc(true)
    .ws({ txWatch: true, blocks: true })
    .reconnect({ enabled: true, maxRetries: 5, baseDelayMs: 1000, maxDelayMs: 15000 })
    .build();


  const account = await client.rest.getAccount('0x0000000000000000000000000000000000000000');
  console.log('Account:', account ?? 'not found');

  const blockNumber = await client.rpc.eth_blockNumber();
  console.log('Current block:', blockNumber);

  const block = await client.rpc.eth_getBlockByNumber(blockNumber, false);
  console.log('Latest block:', block?.hash);

  const syncStatus = await client.rest.getSyncStatus();
  console.log('Sync status:', syncStatus);

  console.log('\nSubscribing to new blocks via WebSocket...');
  const sub = client.ws.blocks().subscribe({
    next: (msg: NewBlockMessage) => {
      const header = msg.block.result.data.value.block.header;
      console.log('New block:', header.height, header.time);
    },
    error: (err: Error) => {
      console.error('Block subscription error:', err.message);
    },
  });

  setTimeout(() => {
    console.log('Unsubscribing...');
    sub.unsubscribe();
    client.ws.close();
    process.exit(0);
  }, 60000);
}

main().catch(console.error);

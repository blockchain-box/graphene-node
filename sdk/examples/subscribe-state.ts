/**
 * Example: Subscribe to domain state changes via State Watch.
 *
 * Run with: npx tsx examples/subscribe-state.ts
 */

import {GrphClientBuilder} from '../src/index.js';

async function main() {
    const client = GrphClientBuilder.configure()
        .baseUrl('http://localhost:3003/graphene-evm')
        .ws({stateWatch: true})
        .build();

    const sw = client.ws.stateWatch();

    sw.account(['0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc', '0xd7ea3bbb415f1487a7ba646f705323f32e24dcb5']).subscribe({
        next: (msg) => {
            console.log(JSON.stringify(msg, null, 2));
        }
    })

    const stakeSub = sw.stake().subscribe({
        next: (msg) => {
            if ('entities' in msg) {
                console.log(`[STAKE] Snapshot at block ${msg.blockNumber}: ${msg.entities.length} entities`);
            } else if ('changes' in msg) {
                console.log(`[STAKE] Change at block ${msg.blockNumber}: ${msg.changes.length} changes`);
                for (const c of msg.changes) {
                    console.log(`  ${c.action} ${c.kind} (${c.uid})`);
                }
            }
        },
        error: (err) => console.error('[STAKE] Error:', err.message),
    });

    const attestSub = sw.attest().subscribe({
        next: (msg) => {
            if ('entities' in msg) {
                console.log(`[ATTEST] Snapshot at block ${msg.blockNumber}: ${msg.entities.length} entities`);
            } else if ('changes' in msg) {
                console.log(`[ATTEST] Change at block ${msg.blockNumber}: ${msg.changes.length} changes`);
            }
        },
        error: (err) => console.error('[ATTEST] Error:', err.message),
    });

    process.on('SIGINT', () => {
        console.log('\nShutting down...');
        stakeSub.unsubscribe();
        attestSub.unsubscribe();
        client.ws.close();
        process.exit(0);
    });
}

main().catch(console.error);

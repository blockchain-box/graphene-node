#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadProfile } from '../agents/lib/update-contracts.js';
import { UpdateStore } from '../agents/lib/update-store.js';
import { UpdateWorker } from '../agents/lib/update-worker.js';
import { publishUpdate } from '../agents/lib/update-publisher.js';
import { serveUpdates } from '../agents/lib/update-service.js';

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: Object.fromEntries([
    'profile', 'directory', 'descriptor', 'release-key', 'release-key-id', 'channel-key', 'channel-key-id', 'sequence', 'expires',
  ].map(key => [key, { type: 'string' }])) });
  const command = positionals[0];
  if (positionals.length !== 1 || !['status', 'stage', 'serve', 'publish'].includes(command) || !values.profile || !values.directory) {
    throw new Error('Usage: npm run update -- <status|stage|serve|publish> --profile FILE --directory DIR. Updates stage only; activation is not implemented.');
  }
  const profile = loadProfile(values.profile);
  if (command === 'status') return console.log(JSON.stringify(new UpdateStore(values.directory, profile).state(), null, 2));
  if (command === 'stage') {
    const worker = new UpdateWorker({ directory: values.directory, profile });
    const close = () => { void worker.close(); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
    try { console.log(JSON.stringify(await worker.checkAndStage(), null, 2)); }
    finally { await worker.close(); process.removeListener('SIGINT', close); process.removeListener('SIGTERM', close); }
    return;
  }
  if (command === 'publish') {
    for (const key of ['descriptor', 'release-key', 'release-key-id', 'channel-key', 'channel-key-id', 'sequence', 'expires']) {
      if (!values[key]) throw new Error(`Publish requires --${key}.`);
    }
    if (!/^[1-9][0-9]*$/.test(values.sequence)) throw new Error('Use a positive channel sequence.');
    const result = await publishUpdate({ directory: values.directory, profile,
      descriptor: JSON.parse(fs.readFileSync(values.descriptor, 'utf8')), sourceDirectory: path.dirname(path.resolve(values.descriptor)),
      releaseKey: fs.readFileSync(values['release-key']), releaseKeyId: values['release-key-id'],
      channelKey: fs.readFileSync(values['channel-key']), channelKeyId: values['channel-key-id'],
      sequence: Number(values.sequence), expiresAt: values.expires });
    console.log(JSON.stringify(result, null, 2)); return;
  }
  const store = new UpdateStore(values.directory, profile);
  if (!store.release()) throw new Error('Publish or stage a verified release before serving updates.');
  const service = await serveUpdates(store);
  console.log(JSON.stringify({ transport: 'grph', publicKey: service.key, activationSupported: false }));
  let closing = false;
  const close = async () => {
    if (closing) return; closing = true;
    await service.close();
    process.removeListener('SIGINT', close); process.removeListener('SIGTERM', close);
  };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

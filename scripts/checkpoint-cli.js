#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { exportBootstrap, publishCheckpoint } from './checkpoint-docker.js';
import { verifyRestore } from './checkpoint-verify.js';
import { checkpointURL } from './checkpoint-core.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const command = process.argv[2];
const option = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; };
const keyFile = path.resolve(option('--key', path.join(root, '.checkpoints/publisher.pem')));
const trustFile = path.resolve(option('--trust', path.join(root, '.checkpoints/trust.json')));
try {
  if (command === 'keygen') {
    const key = crypto.generateKeyPairSync('ed25519');
    fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(keyFile, key.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    console.log('Created private checkpoint publisher key. Keep it outside public downloads and distribute its public-key fingerprint through a trusted channel.');
    console.log(crypto.createHash('sha256').update(key.publicKey.export({ type: 'spki', format: 'der' })).digest('hex'));
  } else if (command === 'export' || command === 'publish') {
    const output = path.resolve(option('--output', path.join(root, '.checkpoints/publication')));
    const manifestURL = option('--url', fs.existsSync(trustFile) ? JSON.parse(fs.readFileSync(trustFile)).manifestURL : undefined);
    if (!manifestURL) throw new Error('Provide --url grph://PROVIDER_KEY/checkpoints/latest.json from the provider’s shared launcher for the first publication.');
    checkpointURL(manifestURL);
    const settings = { output, privateKey: fs.readFileSync(keyFile), verifyRestore };
    const result = command === 'export' ? await exportBootstrap(settings) : await publishCheckpoint({ ...settings, inputDirectory: path.resolve(option('--directory', '')) });
    fs.mkdirSync(path.dirname(trustFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(trustFile, JSON.stringify({ ...result.trust, manifestURL }, null, 2), { mode: 0o600 });
    console.log(`Pinned local launcher trust configuration: ${trustFile}`);
  } else if (command === 'verify') {
    const directory = path.resolve(option('--directory', ''));
    const trust = JSON.parse(fs.readFileSync(trustFile));
    console.log(JSON.stringify(await verifyRestore(directory, trust), null, 2));
  } else {
    console.log('Usage: node scripts/checkpoint-cli.js keygen | export [--output DIR] [--url HTTPS_OR_LOOPBACK_URL] | publish --directory SANITIZED_ARTIFACTS | verify --directory DIR [--trust FILE]\nExport briefly stops/resumes local bootstrap writers. Publish revalidates an earlier snapshot without stopping writers. Both publish only after isolated nonvoting restore verification.');
    process.exitCode = 1;
  }
} catch (error) { console.error(`Checkpoint ${command} failed: ${error.message}`); process.exitCode = 1; }

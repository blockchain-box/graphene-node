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
const keyFile = path.resolve(option('--key', process.env.GRAPHENE_CHECKPOINT_KEY || path.join(root, '.checkpoints/publisher.pem')));
const trustFile = path.resolve(option('--trust', process.env.GRAPHENE_CHECKPOINT_TRUST || path.join(root, '.checkpoints/trust.json')));
const publisherTrustFile = path.resolve(option('--publisher-trust', path.join(root, '.checkpoints/publisher-trust.json')));
function storedURL(file) {
  if (!fs.existsSync(file)) return undefined;
  if (fs.statSync(file).size > 65536) throw new Error('Checkpoint trust configuration is too large.');
  return JSON.parse(fs.readFileSync(file, 'utf8')).manifestURL;
}
try {
  if (command === 'keygen') {
    const key = crypto.generateKeyPairSync('ed25519');
    fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(keyFile, key.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    console.log('Created private checkpoint publisher key. Keep it outside public downloads and distribute its public-key fingerprint through a trusted channel.');
    console.log(crypto.createHash('sha256').update(key.publicKey.export({ type: 'spki', format: 'der' })).digest('hex'));
  } else if (command === 'export' || command === 'publish') {
    const output = path.resolve(option('--output', process.env.GRAPHENE_CHECKPOINT_PUBLICATION_DIR || path.join(root, '.checkpoints/publication')));
    const manifestURL = option('--url', undefined) ?? storedURL(publisherTrustFile) ?? storedURL(trustFile);
    if (!manifestURL) throw new Error('Provide --url grph://PROVIDER_KEY/checkpoints/latest.json for the first publication, or use Checkpoints → Create & verify checkpoint in the launcher. Later exports reuse the saved publisher configuration.');
    checkpointURL(manifestURL);
    if (!fs.existsSync(keyFile)) throw new Error(`No publisher key at ${keyFile}. Run npm run checkpoint -- keygen once (with the same --key path if customized), or create the checkpoint in the launcher to generate the key automatically.`);
    const settings = { output, privateKey: fs.readFileSync(keyFile), verifyRestore, full: process.argv.includes('--full') };
    const result = command === 'export' ? await exportBootstrap(settings) : await publishCheckpoint({ ...settings, inputDirectory: path.resolve(option('--directory', '')) });
    fs.mkdirSync(path.dirname(publisherTrustFile), { recursive: true, mode: 0o700 });
    const temporary = `${publisherTrustFile}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ ...result.trust, manifestURL }, null, 2), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, publisherTrustFile);
    } finally { fs.rmSync(temporary, { force: true }); }
    console.log(`Saved public publisher configuration: ${publisherTrustFile}. Receiver enrollment is unchanged.`);
  } else if (command === 'verify') {
    const directory = path.resolve(option('--directory', ''));
    const verificationTrust = process.argv.includes('--trust') || process.env.GRAPHENE_CHECKPOINT_TRUST ? trustFile : fs.existsSync(publisherTrustFile) ? publisherTrustFile : trustFile;
    const trust = JSON.parse(fs.readFileSync(verificationTrust));
    console.log(JSON.stringify(await verifyRestore(directory, trust), null, 2));
  } else {
    console.log('Usage: node scripts/checkpoint-cli.js keygen | export [--output DIR] [--url GRPH_OR_LOOPBACK_URL] [--publisher-trust FILE] [--full] | publish --directory SANITIZED_ARTIFACTS [--full] | verify --directory DIR [--trust FILE]\nExport captures a committed boundary, resumes writers, then reuses unchanged entries from the previous publication. --full starts a new base. Publish revalidates an earlier snapshot without stopping writers. Both publish only after isolated nonvoting restore verification. Publisher configuration is separate from receiver enrollment.');
    process.exitCode = 1;
  }
} catch (error) { console.error(`Checkpoint ${command} failed: ${error.message}`); process.exitCode = 1; }

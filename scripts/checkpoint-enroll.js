#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkpointURL, verifyManifest } from './checkpoint-core.js';
import { publicCheckpointTrust, checkpointFingerprint } from './checkpoint-trust.js';
import { openGrphClient } from '../agents/lib/grph-tunnel.js';

async function readPublicJSON(url) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Checkpoint enrollment endpoint is unavailable.');
  let bytes = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 65536) throw new Error('Checkpoint enrollment response is too large.');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function enrollCheckpointHost({ url, fingerprint, genesisHash, output, maxAgeHours = 24, expectedSource, onVerified = () => {} }) {
  if (!/^[a-f0-9]{64}$/i.test(fingerprint || '') || !/^[a-f0-9]{64}$/.test(genesisHash || '')) throw new Error('Provide the publisher SHA-256 fingerprint and canonical genesis hash obtained through an independent trusted channel.');
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) throw new Error('Invalid local checkpoint freshness policy.');
  const logical = checkpointURL(url);
  if (!/^\/checkpoints\/(?:[a-zA-Z0-9-]{1,100}\/)?enrollment\.json$/.test(logical.pathname)) throw new Error('Use the host’s /checkpoints/enrollment.json endpoint or a published checkpoint’s enrollment.json.');
  if (fs.existsSync(output)) throw new Error('Checkpoint trust already exists. Preserve it and review any trust change explicitly.');
  const tunnel = logical.protocol === 'grph:' ? await openGrphClient(logical.hostname) : null;
  const endpoint = tunnel ? new URL(logical.pathname, tunnel.origin) : logical;
  try {
    const downloaded = await readPublicJSON(endpoint);
    const manifestName = logical.pathname === '/checkpoints/enrollment.json' ? 'latest.json' : 'manifest.json';
    const manifestURL = new URL(manifestName, logical).href;
    if (downloaded.manifestURL !== manifestURL || downloaded.genesisHash !== genesisHash) throw new Error('Checkpoint enrollment endpoint or genesis differs from the independently approved network.');
    // Freshness is a local policy, never delegated to the downloaded document.
    const trust = publicCheckpointTrust({ ...downloaded, maxAgeHours }, manifestURL);
    if (checkpointFingerprint(trust.publicKey) !== fingerprint.toLowerCase()) throw new Error('Checkpoint publisher fingerprint does not match the independently approved key.');
    const manifest = verifyManifest(await readPublicJSON(new URL(manifestName, endpoint)), trust);
    if (expectedSource && manifest.source?.agentAddress?.toLowerCase() !== expectedSource.toLowerCase()) throw new Error('The signed checkpoint does not belong to the selected source node.');
    onVerified(manifest);
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(output, JSON.stringify(trust, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return trust;
  } finally { await tunnel?.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const option = (name, fallback) => {
      const index = process.argv.indexOf(name);
      if (index < 0) return fallback;
      if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(`Provide a value for ${name}.`);
      return process.argv[index + 1];
    };
    const output = path.resolve(option('--output', './.checkpoints/trust.json'));
    await enrollCheckpointHost({ url: option('--url'), fingerprint: option('--fingerprint'), genesisHash: option('--genesis'), output });
    console.log(`Installed verified checkpoint trust: ${output}`);
    console.log('Run npm run doctor, then start your fresh node through the launcher.');
  } catch (error) { console.error(`Checkpoint enrollment failed: ${error.message}`); process.exitCode = 1; }
}

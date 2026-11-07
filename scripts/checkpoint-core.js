import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { once } from 'node:events';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { validGrphKey, openGrphClient } from '../agents/lib/grph-tunnel.js';

export const artifacts = ['genesis.json', 'app-state.json', 'mpt.tar.gz', 'tendermint.tar.gz'];
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function genesisHash(genesis) {
  return crypto.createHash('sha256').update(canonical({ ...genesis, initial_height: String(Math.max(1, Number(genesis.initial_height || 0))) })).digest('hex');
}
export async function fileHash(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export function signManifest(manifest, privateKey) {
  return { manifest, signature: crypto.sign(null, Buffer.from(canonical(manifest)), privateKey).toString('base64') };
}
export function verifyManifest(envelope, trust, { requireVerified = true, now = Date.now() } = {}) {
  const m = envelope?.manifest;
  if (!m || !crypto.verify(null, Buffer.from(canonical(m)), trust.publicKey, Buffer.from(envelope.signature || '', 'base64'))) throw new Error('Checkpoint publisher signature is invalid.');
  if (m.format !== 1 || m.kind !== 'graphene-local-checkpoint' || m.chainId !== 9876 || m.genesisHash !== trust.genesisHash || trust.chainId !== 9876) throw new Error('Checkpoint network or format does not match the pinned trust configuration.');
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(m.id)) throw new Error('Invalid checkpoint identifier.');
  if (!/^\d+$/.test(m.height) || BigInt(m.height) < 1n || !/^[a-f0-9]{64}$/.test(m.appHash) || !/^[A-Fa-f0-9]{64}$/.test(m.blockHash || '')) throw new Error('Invalid checkpoint height or consensus hash.');
  if (!Number.isFinite(Date.parse(m.createdAt)) || Date.parse(m.createdAt) > now + 60000 || now - Date.parse(m.createdAt) > (trust.maxAgeHours || 24) * 3600000) throw new Error('Checkpoint is expired or has an invalid timestamp.');
  if (requireVerified && (!m.verification?.caughtUp || !Number.isSafeInteger(m.verification.height) || m.verification.height <= Number(m.height) || !/^[a-f0-9]{64}$/i.test(m.verification.appHash || ''))) throw new Error('Checkpoint has not passed isolated restore and catch-up verification.');
  if (Object.keys(m.files || {}).sort().join() !== [...artifacts].sort().join()) throw new Error('Unexpected checkpoint artifact list.');
  for (const [name, file] of Object.entries(m.files)) if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > (name.endsWith('.json') ? 1024 ** 2 : 8 * 1024 ** 3)) throw new Error('Invalid checkpoint artifact size or hash.');
  return m;
}
export function sanitizeAppState(row) {
  const fields = ['chain_id', 'session_token', 'current_height', 'current_app_root', 'current_block_hash', 'genesis_app_root', 'genesis_block_hash', 'genesis_versions'];
  if (!row || Number(row.chain_id) !== 9876 || !Number.isSafeInteger(Number(row.current_height)) || Number(row.current_height) < 1) throw new Error('Invalid committed application state.');
  for (const key of ['current_app_root', 'current_block_hash', 'genesis_app_root', 'genesis_block_hash']) if (!/^0x[a-f0-9]{64}$/i.test(row[key] || '')) throw new Error('Invalid application root.');
  const versions = typeof row.genesis_versions === 'string' ? JSON.parse(row.genesis_versions) : row.genesis_versions;
  if (!Array.isArray(versions) || versions.some((version) => typeof version !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(version))) throw new Error('Invalid genesis version metadata.');
  return Object.fromEntries(fields.map((key) => [key, key === 'session_token' ? null : key === 'genesis_versions' ? JSON.stringify(versions) : row[key]]));
}
export function appStateSQL(row) {
  const clean = sanitizeAppState(row);
  const literal = JSON.stringify(clean).replaceAll("'", "''");
  return `BEGIN; DELETE FROM local_abci_schema.app_states WHERE chain_id=9876; INSERT INTO local_abci_schema.app_states SELECT * FROM json_populate_record(NULL::local_abci_schema.app_states, '${literal}'::json); COMMIT;`;
}

// Validate every tar header BEFORE Docker extraction: only regular database
// files/directories are accepted. Links, devices, traversal and GNU/PAX extensions
// are rejected. Limits also bound decompression and inode exhaustion.
export async function verifyArchive(file, kind, { maxBytes = 32 * 1024 ** 3, maxEntries = 100000 } = {}) {
  const input = fs.createReadStream(file);
  const stream = input.pipe(createGunzip());
  input.on('error', (error) => stream.destroy(error));
  let buffer = Buffer.alloc(0), remaining = 0, bytes = 0, entries = 0, ended = false;
  const names = new Set();
  try {
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error('Checkpoint archive exceeds its unpacked size limit.');
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        if (remaining) { const take = Math.min(remaining, buffer.length); buffer = buffer.subarray(take); remaining -= take; if (remaining) break; }
        if (buffer.length < 512) break;
        const header = buffer.subarray(0, 512); buffer = buffer.subarray(512);
        if (header.every((byte) => byte === 0)) { ended = true; continue; }
        if (ended || ++entries > maxEntries) throw new Error('Invalid checkpoint tar stream.');
        const field = (start, end) => header.subarray(start, end).toString('utf8').split('\0')[0];
        const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
        if (parseInt(field(148, 156).trim(), 8) !== checksum) throw new Error('Invalid tar checksum.');
        let name = field(0, 100); if (field(345, 500)) throw new Error('Tar path prefixes are not supported.');
        name = name.replace(/^\.\//, '').replace(/\/$/, '');
        const type = field(156, 157) || '0';
        if (!['0', '5'].includes(type) || field(157, 257)) throw new Error('Checkpoint archives cannot contain links or special entries.');
        const allowed = kind === 'mpt' ? /^(db|db\/(state|blocks|receipts|transactions)(\/[a-zA-Z0-9_.-]+)*)$/ : /^(blockstore\.db|state\.db|evidence\.db|tx_index\.db)(\/[a-zA-Z0-9_.-]+)*$/;
        if (!allowed.test(name) || name.split('/').some((part) => part === '..' || part === '.') || names.has(name)) throw new Error(`Unsafe or duplicate checkpoint archive path: ${name}`);
        if (type === '0' && !/^(?:[0-9]{6,}\.(?:ldb|sst|log)|MANIFEST-[0-9]{6,}|CURRENT(?:\.bak)?|LOCK|LOG(?:\.old)?)$/.test(path.posix.basename(name))) throw new Error('Only native LevelDB files may appear in checkpoint archives; identity/configuration files are forbidden.');
        names.add(name);
        const sizeText = field(124, 136).trim();
        if (!/^[0-7]+$/.test(sizeText)) throw new Error('Invalid tar entry size.');
        const size = parseInt(sizeText, 8);
        if (!Number.isSafeInteger(size) || size > maxBytes || (type === '5' && size !== 0)) throw new Error('Invalid tar entry.');
        remaining = Math.ceil(size / 512) * 512;
      }
    }
    if (remaining || buffer.length || !ended || !entries) throw new Error('Truncated checkpoint archive.');
    if (kind === 'mpt' && !['state', 'blocks', 'receipts', 'transactions'].every((name) => names.has(`db/${name}`))) throw new Error('Incomplete trie checkpoint.');
    if (kind === 'tendermint' && !['blockstore.db', 'state.db', 'evidence.db', 'tx_index.db'].every((name) => names.has(name))) throw new Error('Incomplete Tendermint checkpoint.');
    return { entries, bytes };
  } finally { input.destroy(); stream.destroy(); }
}

export function checkpointURL(value) {
  const url = new URL(value);
  const local = ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  const p2p = url.protocol === 'grph:' && validGrphKey(url.hostname) && !url.port;
  if (url.username || url.password || url.hash || url.search || (!local && !p2p)) throw new Error('Remote checkpoint downloads require a grph:// P2P endpoint. Local loopback HTTP is allowed; there is no direct remote HTTP/HTTPS fallback.');
  return url;
}
export async function downloadFile(url, destination, expected, progress = () => {}) {
  const logical = checkpointURL(url);
  if (logical.protocol === 'grph:') { const tunnel = await openGrphClient(logical.hostname); try { return await downloadFile(new URL(logical.pathname, tunnel.origin), destination, expected, progress); } finally { await tunnel.close(); } }
  const source = logical;
  const partial = destination + '.part';
  let offset = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
  if (offset >= expected.bytes) {
    if (offset === expected.bytes && await fileHash(partial) === expected.sha256) { fs.renameSync(partial, destination); progress(offset, expected.bytes); return; }
    fs.rmSync(partial, { force: true }); offset = 0;
  }
  // Native HTTP streams retain the signed archive representation. fetch transparently
  // decompresses Content-Encoding:gzip, including servers that set it on .tar.gz files.
  const response = await new Promise((resolve, reject) => {
    const get = source.protocol === 'https:' ? httpsGet : httpGet;
    const request = get(source, { headers: { 'Accept-Encoding': 'identity', ...(offset ? { Range: `bytes=${offset}-` } : {}) },
      signal: AbortSignal.timeout(15 * 60000) }, resolve);
    request.on('error', reject);
  });
  if (![200, 206].includes(response.statusCode)) { response.destroy(); throw new Error('Checkpoint download failed.'); }
  const resumed = response.statusCode === 206 && offset > 0;
  if (response.statusCode === 206 && (!resumed || !String(response.headers['content-range'] || '').startsWith(`bytes ${offset}-`))) {
    response.destroy(); throw new Error('Invalid checkpoint download range.');
  }
  let received = resumed ? offset : 0;
  const output = fs.createWriteStream(partial, { flags: resumed ? 'a' : 'w', mode: 0o600 });
  // Install an error listener before writing; awaiting close catches disk errors.
  let writeError; output.on('error', (error) => { writeError = error; });
  try {
    for await (const chunk of response) {
      received += chunk.length;
      if (received > expected.bytes) throw new Error('Checkpoint download exceeded its signed size.');
      if (!output.write(chunk)) await once(output, 'drain');
      if (writeError) throw writeError;
      progress(received, expected.bytes);
    }
    output.end(); await once(output, 'close');
    if (writeError) throw writeError;
    if (received !== expected.bytes || await fileHash(partial) !== expected.sha256) { fs.rmSync(partial, { force: true }); throw new Error('Checkpoint artifact integrity check failed.'); }
    fs.renameSync(partial, destination);
  } finally { output.destroy(); response.destroy(); }
}
export async function fetchCheckpoint(trust, directory, progress = () => {}) {
  const logical = checkpointURL(trust.manifestURL);
  const tunnel = logical.protocol === 'grph:' ? await openGrphClient(logical.hostname) : null;
  const url = tunnel ? new URL(logical.pathname, tunnel.origin) : logical;
  try {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('No checkpoint manifest is available.');
  let raw = '';
  for await (const chunk of response.body) { raw += Buffer.from(chunk).toString(); if (Buffer.byteLength(raw) > 65536) throw new Error('Checkpoint manifest is too large.'); }
  const envelope = JSON.parse(raw), manifest = verifyManifest(envelope, trust);
  const cache = path.join(directory, crypto.createHash('sha256').update(canonical(manifest)).digest('hex'));
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  for (const name of artifacts) {
    const fileURL = new URL(`${manifest.id}/${name}`, url);
    if (fileURL.origin !== url.origin || !/^[a-zA-Z0-9-]{1,100}$/.test(manifest.id)) throw new Error('Invalid checkpoint artifact location.');
    const file = path.join(cache, name), expected = manifest.files[name];
    if (!fs.existsSync(file) || fs.statSync(file).size !== expected.bytes || await fileHash(file) !== expected.sha256) await downloadFile(fileURL, file, expected, (received, total) => progress({ phase: 'downloading', file: name, downloadedBytes: received, totalBytes: total, height: manifest.height }));
  }
  progress({ phase: 'verifying', height: manifest.height });
  await verifyArchive(path.join(cache, 'mpt.tar.gz'), 'mpt');
  await verifyArchive(path.join(cache, 'tendermint.tar.gz'), 'tendermint');
  fs.writeFileSync(path.join(cache, 'manifest.json'), JSON.stringify(envelope));
  return { directory: cache, manifest };
  } finally { await tunnel?.close(); }
}

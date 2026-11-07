import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const HASH = /^[a-f0-9]{64}$/;
export const NAME = /^[a-z0-9][a-z0-9._-]{0,79}$/;
export const MAX_METADATA = 2 * 1024 * 1024;
export const MAX_CHUNK = 4 * 1024 * 1024;
const isName = value => typeof value === 'string' && NAME.test(value);

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  if (value === undefined || typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid signed metadata value.');
  return JSON.stringify(value);
}
export function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
export function metadataHash(value) { return hash(canonical(value)); }
function requireValue(ok, message) { if (!ok) throw new Error(message); }
export function networkIdentity(profile) {
  return { networkId: profile.networkId, environment: profile.environment, tendermintChainId: profile.tendermintChainId, chainId: profile.chainId, genesisHash: profile.genesisHash };
}
export function networkScope(profile) { return metadataHash(networkIdentity(profile)); }

// Profiles are installed through the operator's trusted local configuration,
// never downloaded from the peer that supplies software.
export function validateProfile(input) {
  const p = JSON.parse(JSON.stringify(input));
  requireValue(p.format === 1 && p.kind === 'graphene-update-profile', 'Unsupported update profile.');
  requireValue(isName(p.networkId) && ['local', 'test', 'prod'].includes(p.environment), 'Invalid network identity.');
  requireValue(typeof p.tendermintChainId === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(p.tendermintChainId)
    && Number.isSafeInteger(p.chainId) && p.chainId > 0 && HASH.test(p.genesisHash || ''), 'Pin chain identifiers and genesis hash in the update profile.');
  requireValue(['dev', 'candidate', 'stable'].includes(p.channel), 'Invalid update channel.');
  requireValue(p.environment !== 'prod' || p.channel === 'stable', 'Production profiles require the stable channel.');
  requireValue(p.environment !== 'test' || p.channel !== 'dev', 'Test profiles cannot follow development releases.');
  requireValue(['validator', 'sentry'].includes(p.role) && p.target?.os === 'linux' && ['x64', 'arm64'].includes(p.target?.arch), 'Unsupported node update target.');
  requireValue(typeof p.currentVersion === 'string' && NAME.test(p.currentVersion), 'Pin the installed software version in the update profile.');
  for (const purpose of ['release', 'channel']) {
    const keys = p.keys?.[purpose];
    requireValue(keys && typeof keys === 'object' && !Array.isArray(keys) && Object.keys(keys).length > 0 && Object.keys(keys).length <= 16, 'Install release and channel trust keys.');
    for (const [id, pem] of Object.entries(keys)) {
      requireValue(isName(id) && typeof pem === 'string' && pem.startsWith('-----BEGIN PUBLIC KEY-----') && !pem.includes('PRIVATE KEY') && pem.length <= 4096, 'Invalid update trust key.');
      requireValue(crypto.createPublicKey(pem).asymmetricKeyType === 'ed25519', 'Update keys must be Ed25519.');
    }
  }
  requireValue(Array.isArray(p.seeds) && p.seeds.length > 0 && p.seeds.length <= 16
    && new Set(p.seeds).size === p.seeds.length && p.seeds.every(key => typeof key === 'string' && /^[a-z0-9]{52}$/.test(key)), 'Configure bounded Grph seed public keys.');
  requireValue(Number.isSafeInteger(p.maxArtifactBytes) && p.maxArtifactBytes > 0 && p.maxArtifactBytes <= 32 * 1024 ** 3, 'Set a bounded artifact size.');
  requireValue(Number.isSafeInteger(p.maxCacheBytes) && p.maxCacheBytes >= p.maxArtifactBytes && p.maxCacheBytes <= 128 * 1024 ** 3, 'Set a bounded update cache size.');
  requireValue(Number.isSafeInteger(p.pollIntervalMs) && p.pollIntervalMs >= 10000 && p.pollIntervalMs <= 24 * 3600000, 'Invalid update poll interval.');
  requireValue(Number.isSafeInteger(p.bytesPerSecond) && p.bytesPerSecond >= 1024 && p.bytesPerSecond <= 64 * 1024 ** 2, 'Set an update bandwidth limit.');
  return p;
}
export function loadProfile(file) {
  if (fs.statSync(file).size > MAX_METADATA) throw new Error('Update profile exceeds size limit.');
  return validateProfile(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function signMetadata(payload, keyId, privateKey) {
  requireValue(isName(keyId), 'Invalid signing key ID.');
  const bytes = Buffer.from(`graphene-updates-v1\n${canonical(payload)}`);
  return { payload, keyId, signature: crypto.sign(null, bytes, privateKey).toString('base64') };
}
export function verifySigned(envelope, profile, purpose) {
  requireValue(envelope && isName(envelope.keyId) && typeof envelope.signature === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(envelope.signature), 'Invalid update signature envelope.');
  const key = profile.keys[purpose]?.[envelope.keyId];
  requireValue(key && envelope.payload && Buffer.byteLength(canonical(envelope)) <= MAX_METADATA, 'Untrusted or oversized update metadata.');
  requireValue(crypto.verify(null, Buffer.from(`graphene-updates-v1\n${canonical(envelope.payload)}`), key, Buffer.from(envelope.signature, 'base64')), 'Update publisher signature is invalid.');
  return envelope.payload;
}
export function verifyChannel(envelope, profile, previous = {}, now = Date.now()) {
  const m = verifySigned(envelope, profile, 'channel');
  requireValue(m.format === 1 && m.kind === 'graphene-update-channel' && m.channel === profile.channel
    && canonical(m.network) === canonical(networkIdentity(profile)), 'Update channel belongs to a different network.');
  requireValue(Number.isSafeInteger(m.sequence) && m.sequence > 0 && HASH.test(m.releaseHash || ''), 'Invalid channel sequence or release hash.');
  const created = Date.parse(m.createdAt), expires = Date.parse(m.expiresAt);
  requireValue(typeof m.createdAt === 'string' && typeof m.expiresAt === 'string' && Number.isFinite(now) && Number.isFinite(created) && Number.isFinite(expires) && created <= now + 60000
    && expires > now && expires > created && expires - created <= 7 * 86400000, 'Update channel metadata is expired or has invalid freshness.');
  requireValue(m.sequence >= (previous.sequence || 0), 'Update channel replay rejected.');
  requireValue(m.sequence !== previous.sequence || previous.channelHash === metadataHash(m), 'Conflicting update channel sequence.');
  return m;
}
export function verifyRelease(envelope, profile, expectedHash) {
  const m = verifySigned(envelope, profile, 'release');
  requireValue(metadataHash(m) === expectedHash, 'Release manifest hash mismatch.');
  requireValue(m.format === 1 && m.kind === 'graphene-release' && isName(m.releaseId) && m.updaterProtocol === 1, 'Unsupported release manifest.');
  requireValue(['compatible', 'consensus'].includes(m.classification) && Array.isArray(m.compatibleFrom)
    && m.compatibleFrom.length > 0 && m.compatibleFrom.length <= 100 && m.compatibleFrom.every(v => typeof v === 'string' && NAME.test(v)), 'Declare release compatibility.');
  requireValue(Array.isArray(m.artifacts) && m.artifacts.length > 0 && m.artifacts.length <= 64, 'Invalid release artifact list.');
  const targets = new Set(), hashes = new Set();
  for (const a of m.artifacts) {
    const target = `${a.component}/${a.role}/${a.os}/${a.arch}`;
    requireValue(isName(a.component) && ['validator', 'sentry', 'all'].includes(a.role) && a.os === 'linux'
      && ['x64', 'arm64'].includes(a.arch) && !targets.has(target) && !hashes.has(a.sha256), 'Invalid or duplicate artifact target.');
    targets.add(target); hashes.add(a.sha256);
    requireValue(HASH.test(a.sha256 || '') && Number.isSafeInteger(a.bytes) && a.bytes > 0 && a.bytes <= profile.maxArtifactBytes, 'Invalid artifact hash or byte size.');
    requireValue(Number.isSafeInteger(a.chunkSize) && a.chunkSize >= 1024 && a.chunkSize <= MAX_CHUNK
      && Array.isArray(a.chunks) && a.chunks.length === Math.ceil(a.bytes / a.chunkSize) && a.chunks.length <= 32768
      && a.chunks.every(h => HASH.test(h)), 'Invalid signed chunk list.');
  }
  const selected = m.artifacts.filter(a => a.os === profile.target.os && a.arch === profile.target.arch && [profile.role, 'all'].includes(a.role));
  requireValue(selected.length > 0 && new Set(selected.map(a => a.component)).size === selected.length, 'Release does not have an unambiguous target for this node.');
  requireValue(m.compatibleFrom.includes(profile.currentVersion), 'Installed software is outside the declared upgrade path.');
  return m;
}

export function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const fd = fs.openSync(temp, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    // Persist the directory entry as well as the file before returning a
    // successful replay high-water mark (supported node hosts: Linux/macOS).
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally { fs.rmSync(temp, { force: true }); }
}

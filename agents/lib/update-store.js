import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicJSON, canonical, HASH, metadataHash, networkIdentity, networkScope, validateProfile, verifyChannel, verifyRelease, verifySigned } from './update-contracts.js';

export async function fileHash(file) {
  const digest = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) digest.update(bytes);
  return digest.digest('hex');
}

export class UpdateStore {
  constructor(directory, profile) {
    this.profile = validateProfile(profile);
    this.directory = path.join(path.resolve(directory), networkScope(profile), profile.channel, `${profile.role}-${profile.target.os}-${profile.target.arch}`);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.stateFile = path.join(this.directory, 'state.json');
    this.lockFile = path.join(this.directory, 'worker.lock');
  }
  state() { return fs.existsSync(this.stateFile) ? JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) : { phase: 'idle' }; }
  save(changes) { const state = { ...this.state(), ...changes, updatedAt: new Date().toISOString(), activationSupported: false }; atomicJSON(this.stateFile, state); return state; }
  artifactPath(sha256) {
    if (!HASH.test(sha256)) throw new Error('Invalid artifact hash.');
    return path.join(this.directory, 'artifacts', sha256);
  }
  chunkPath(sha256, index) {
    if (!HASH.test(sha256) || !Number.isSafeInteger(index) || index < 0) throw new Error('Invalid artifact chunk.');
    return path.join(this.directory, 'chunks', sha256, String(index));
  }
  acquire() {
    // No automatic stale-lock takeover: PID reuse, containers and multiple hosts
    // make guessing unsafe. Graceful exit releases it; crash recovery is explicit.
    const fd = fs.openSync(this.lockFile, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); }
    finally { fs.closeSync(fd); }
    return () => fs.unlinkSync(this.lockFile);
  }
  usage(folder = this.directory) {
    let bytes = 0;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Update cache cannot contain symbolic links.');
      bytes += entry.isDirectory() ? this.usage(file) : fs.statSync(file).size;
    }
    return bytes;
  }
  reserve(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.usage() + bytes > this.profile.maxCacheBytes) throw new Error('Update cache quota exceeded. Preserve the journal and remove obsolete artifacts before retrying.');
    const stat = fs.statfsSync(this.directory);
    if (Number(stat.bavail) * Number(stat.bsize) < bytes + 16 * 1024 ** 2) throw new Error('Insufficient free space for update staging.');
  }
  accept(channelEnvelope, releaseEnvelope, now = Date.now()) {
    const channel = verifyChannel(channelEnvelope, this.profile, this.state(), now);
    const release = verifyRelease(releaseEnvelope, this.profile, channel.releaseHash);
    const previous = this.state();
    if (previous.sequence === channel.sequence && previous.channelHash !== metadataHash(channel)) throw new Error('Conflicting update channel sequence.');
    this.reserve(2 * Buffer.byteLength(JSON.stringify(channelEnvelope)) + Buffer.byteLength(JSON.stringify(releaseEnvelope)) + 4096);
    atomicJSON(path.join(this.directory, `${channel.releaseHash}.json`), releaseEnvelope);
    atomicJSON(path.join(this.directory, `${metadataHash(channel)}.channel.json`), channelEnvelope);
    // Persist the high-water mark before publishing its channel pointer. A crash
    // may interrupt availability, but must never permit an older authorization.
    this.save({ sequence: channel.sequence, channelHash: metadataHash(channel), releaseHash: channel.releaseHash,
      releaseId: release.releaseId, phase: 'available', error: null, artifacts: [], completedChunk: 0, totalChunks: 0 });
    atomicJSON(path.join(this.directory, 'channel.json'), channelEnvelope);
    return release;
  }
  channel() {
    const state = this.state();
    if (!HASH.test(state.channelHash || '')) throw new Error('No verified channel metadata.');
    const envelope = JSON.parse(fs.readFileSync(path.join(this.directory, `${state.channelHash}.channel.json`), 'utf8'));
    const channel = verifySigned(envelope, this.profile, 'channel');
    if (metadataHash(channel) !== state.channelHash || channel.releaseHash !== state.releaseHash || channel.sequence !== state.sequence
      || channel.channel !== this.profile.channel || canonical(channel.network) !== canonical(networkIdentity(this.profile))) throw new Error('Stored channel metadata does not match its durable journal.');
    return envelope;
  }
  release() {
    const state = this.state();
    if (!HASH.test(state.releaseHash || '')) return null;
    const envelope = JSON.parse(fs.readFileSync(path.join(this.directory, `${state.releaseHash}.json`), 'utf8'));
    return { envelope, manifest: verifyRelease(envelope, this.profile, state.releaseHash) };
  }
  selected(release) { return release.artifacts.filter(a => a.os === this.profile.target.os && a.arch === this.profile.target.arch && [this.profile.role, 'all'].includes(a.role)); }
  async hasArtifact(artifact) {
    const file = this.artifactPath(artifact.sha256);
    return fs.existsSync(file) && fs.lstatSync(file).isFile() && fs.statSync(file).size === artifact.bytes && await fileHash(file) === artifact.sha256;
  }
}

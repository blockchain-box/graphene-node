import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openGrphClient, dhtBootstrap } from './grph-tunnel.js';
import { hash, metadataHash, MAX_METADATA, loadProfile, networkScope, verifyChannel, verifyRelease } from './update-contracts.js';
import { UpdateStore, fileHash } from './update-store.js';
import { serveUpdates } from './update-service.js';

async function boundedResponse(response, limit) {
  if (!response.ok) { await response.body?.cancel(); throw new Error('Update peer request failed.'); }
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error('Update peer exceeded response limit.');
      chunks.push(chunk);
    }
  } catch (error) { throw error; }
  return Buffer.concat(chunks);
}

export class UpdateWorker {
  constructor({ directory, profile, connect = openGrphClient, request = fetch, bootstrap = dhtBootstrap(), now = Date.now }) {
    this.store = new UpdateStore(directory, profile);
    this.profile = this.store.profile;
    this.connect = connect; this.request = request; this.bootstrap = bootstrap; this.now = now;
    this.controller = new AbortController(); this.running = null;
  }
  async get(connection, route, limit) {
    const url = new URL(connection.origin);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('Update connection must be a local Grph proxy.');
    // A listening Grph proxy does not guarantee that its remote encrypted
    // stream has connected yet. Retry idempotent reads after transport resets;
    // HTTP errors, signatures and artifact-integrity failures are not retried.
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.request(connection.origin + route, { redirect: 'error', signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(120000)]) });
        return await boundedResponse(response, limit);
      } catch (error) {
        const transient = error instanceof TypeError && error.message === 'fetch failed'
          || ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET'].includes(error.cause?.code);
        if (!transient || attempt >= 2 || this.controller.signal.aborted) throw error;
        await delay(250 * 2 ** attempt, undefined, { signal: this.controller.signal });
      }
    }
  }
  async json(connection, route) { return JSON.parse((await this.get(connection, route, MAX_METADATA)).toString('utf8')); }
  async checkAndStage() {
    if (this.running) throw new Error('An update operation is already running.');
    const releaseLock = this.store.acquire();
    this.running = this.round();
    try { return await this.running; }
    catch (error) { this.store.save({ phase: 'failed', error: error.message.slice(0, 300) }); throw error; }
    finally { this.running = null; releaseLock(); }
  }
  async round() {
    const connections = [];
    this.store.save({ phase: 'checking', error: null });
    try {
      const candidates = [];
      for (const key of this.profile.seeds) {
        this.controller.signal.throwIfAborted();
        try {
          const connection = await this.connect(key, { bootstrap: this.bootstrap, timeoutMs: 10000 });
          connections.push(connection);
          const envelope = await this.json(connection, `/updates/v1/networks/${networkScope(this.profile)}/channels/${this.profile.channel}`);
          const channel = verifyChannel(envelope, this.profile, this.store.state(), this.now());
          candidates.push({ connection, envelope, channel });
        } catch { /* Another configured peer may have current valid metadata. */ }
      }
      if (!candidates.length) throw new Error('No configured Grph peer supplied a current authorized release.');
      candidates.sort((a, b) => b.channel.sequence - a.channel.sequence);
      const best = candidates[0];
      for (const candidate of candidates) {
        if (candidate.channel.sequence === best.channel.sequence && metadataHash(candidate.envelope.payload) !== metadataHash(best.envelope.payload)) {
          throw new Error('Peers supplied conflicting signed channel metadata.');
        }
      }
      // Fetch the content-addressed manifest from any connected peer, not just
      // the peer that advertises the newest channel.
      let envelope;
      for (const connection of connections) {
        try {
          const value = await this.json(connection, `/updates/v1/releases/${best.channel.releaseHash}`);
          verifyRelease(value, this.profile, best.channel.releaseHash);
          envelope = value; break;
        } catch { /* Try another peer; unverified metadata is never persisted. */ }
      }
      if (!envelope) throw new Error('No peer supplied the authorized release manifest.');
      const release = this.store.accept(best.envelope, envelope, this.now());
      const artifacts = this.store.selected(release);
      for (const artifact of artifacts) await this.download(artifact, connections);
      // A long transfer cannot stage a release under expired channel authority.
      verifyChannel(best.envelope, this.profile, this.store.state(), this.now());
      return this.store.save({ phase: 'staged', error: null, artifacts: artifacts.map(a => a.sha256), classification: release.classification });
    } finally { await Promise.allSettled(connections.map(c => c.close())); }
  }
  async download(artifact, connections) {
    if (await this.store.hasArtifact(artifact)) return;
    const file = this.store.artifactPath(artifact.sha256);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.store.save({ phase: 'downloading', artifact: artifact.sha256 });
    for (let index = 0; index < artifact.chunks.length; index++) {
      this.controller.signal.throwIfAborted();
      const chunkFile = this.store.chunkPath(artifact.sha256, index);
      const expectedBytes = Math.min(artifact.chunkSize, artifact.bytes - index * artifact.chunkSize);
      if (fs.existsSync(chunkFile)) {
        if (fs.lstatSync(chunkFile).isFile() && fs.statSync(chunkFile).size === expectedBytes && await fileHash(chunkFile) === artifact.chunks[index]) continue;
        fs.rmSync(chunkFile);
      }
      let verified = false;
      for (const connection of connections) {
        if (connection.quarantined) continue;
        const started = Date.now();
        try {
          const bytes = await this.get(connection, `/updates/v1/artifacts/${artifact.sha256}/chunks/${index}`, expectedBytes);
          if (bytes.length !== expectedBytes || hash(bytes) !== artifact.chunks[index]) throw new Error('Update chunk integrity mismatch.');
          this.store.reserve(bytes.length);
          fs.mkdirSync(path.dirname(chunkFile), { recursive: true, mode: 0o700 });
          fs.writeFileSync(chunkFile, bytes, { flag: 'wx', mode: 0o600 });
          this.store.save({ completedChunk: index + 1, totalChunks: artifact.chunks.length });
          await delay(Math.max(0, Math.ceil(bytes.length * 1000 / this.profile.bytesPerSecond) - (Date.now() - started)), undefined, { signal: this.controller.signal });
          verified = true; break;
        } catch { connection.quarantined = true; /* Retry another peer for the remainder of this round. */ }
      }
      if (!verified) throw new Error('Grph peers could not supply a verified artifact chunk. Download can be resumed.');
    }
    this.store.save({ phase: 'verifying' });
    const temporary = file + '.part';
    fs.rmSync(temporary, { force: true });
    this.store.reserve(artifact.bytes);
    const fd = fs.openSync(temporary, 'w', 0o600);
    try {
      for (let index = 0; index < artifact.chunks.length; index++) {
        const bytes = fs.readFileSync(this.store.chunkPath(artifact.sha256, index));
        if (hash(bytes) !== artifact.chunks[index]) throw new Error('Cached update chunk changed during assembly.');
        fs.writeFileSync(fd, bytes);
      }
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    if (fs.statSync(temporary).size !== artifact.bytes || await fileHash(temporary) !== artifact.sha256) {
      fs.rmSync(temporary); throw new Error('Assembled update artifact failed integrity verification.');
    }
    fs.renameSync(temporary, file);
    fs.rmSync(path.dirname(this.store.chunkPath(artifact.sha256, 0)), { recursive: true, force: true });
  }
  async close() { this.controller.abort(); await this.running?.catch(() => {}); }
}

// Optional, trusted host configuration. Failure of this subsystem must never
// shut down an otherwise healthy validator or sentry.
export async function startAgentUpdates({ role, env = process.env, log = () => {}, createWorker = options => new UpdateWorker(options), serve = serveUpdates } = {}) {
  if (!env.GRAPHENE_UPDATE_PROFILE) return { enabled: false, async close() {} };
  let worker, service, timer, closed = false;
  try {
    const profile = loadProfile(env.GRAPHENE_UPDATE_PROFILE);
    if (profile.role !== role) throw new Error('Update profile role differs from the running agent.');
    worker = createWorker({ directory: env.GRAPHENE_UPDATE_DIRECTORY || path.join(env.STATE_DIR || env.STATE_PATH || '/app/state', 'updates'), profile });
    if (env.GRAPHENE_UPDATE_SERVE === '1') service = await serve(worker.store);
    const poll = async () => {
      try { await worker.checkAndStage(); }
      catch (error) { log(`Update staging: ${error.message}`); }
      finally { if (!closed) { timer = setTimeout(poll, profile.pollIntervalMs); timer.unref(); } }
    };
    // Staging starts independently of chain RPC and assignment monitoring.
    void poll();
    return { enabled: true, key: service?.key, status: () => {
      try { return { enabled: true, publicKey: service?.key, ...worker.store.state() }; }
      catch { return { enabled: false, activationSupported: false, error: 'Update journal needs operator inspection.' }; }
    }, async close() {
      if (closed) return;
      closed = true; clearTimeout(timer); await worker.close(); await service?.close();
    } };
  } catch (error) {
    closed = true; clearTimeout(timer); await worker?.close(); await service?.close();
    log(`Update staging disabled: ${error.message}`);
    return { enabled: false, error: error.message, async close() {} };
  }
}

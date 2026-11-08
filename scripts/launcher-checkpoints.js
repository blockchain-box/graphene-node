import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkpointURL, verifyManifest } from './checkpoint-core.js';
import { publicCheckpointTrust, checkpointFingerprint } from './checkpoint-trust.js';
import { enrollCheckpointHost } from './checkpoint-enroll.js';
import { exportBootstrap } from './checkpoint-docker.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicSummary = trust => ({ manifestURL: trust.manifestURL, enrollmentURL: new URL('enrollment.json', trust.manifestURL).href, fingerprint: checkpointFingerprint(trust.publicKey), genesisHash: trust.genesisHash, maxAgeHours: trust.maxAgeHours });
function readJSON(file) {
  if (fs.statSync(file).size > 65536) throw new Error('Checkpoint configuration is too large.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function fields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) throw new Error('Unsupported checkpoint settings. Paths and source services are configured on the host.');
}
function publicURL(value, name) {
  const url = checkpointURL(value);
  if (url.protocol !== 'grph:' || url.pathname !== `/checkpoints/${name}.json`) throw new Error(`Use the public grph:// checkpoint host’s /checkpoints/${name}.json address.`);
  return url.href;
}

export class LauncherCheckpoints {
  constructor({ trustFile = process.env.GRAPHENE_CHECKPOINT_TRUST || path.join(root, '.checkpoints/trust.json'), output = process.env.GRAPHENE_CHECKPOINT_PUBLICATION_DIR || path.join(root, '.checkpoints/publication'), keyFile = process.env.GRAPHENE_CHECKPOINT_KEY || path.join(root, '.checkpoints/publisher.pem'), publisherTrustFile = path.join(root, '.checkpoints/publisher-trust.json'), creationAvailable = fs.existsSync(new URL('./checkpoint-verify.js', import.meta.url)), create = exportBootstrap, enroll = enrollCheckpointHost, verifyRestore } = {}) {
    Object.assign(this, { trustFile, output, keyFile, publisherTrustFile, creationAvailable, create, enroll, verifyRestore });
    this.job = null; this.task = null;
  }
  get busy() { return this.job?.state === 'running'; }
  nodePublisherFile(agentAddress) {
    if (!/^0x[a-f0-9]{40}$/i.test(agentAddress || '')) throw new Error('Invalid checkpoint source node.');
    return path.join(path.dirname(this.publisherTrustFile), 'node-publishers', agentAddress.slice(2).toLowerCase() + '.json');
  }
  nodePublication(agentAddress) {
    const file = this.nodePublisherFile(agentAddress);
    if (!fs.existsSync(file)) return null;
    try {
      const record = readJSON(file), trust = publicCheckpointTrust(record, record.manifestURL);
      if (!/^[a-zA-Z0-9-]{1,100}$/.test(record.checkpoint?.id || '')) throw new Error('Invalid checkpoint ID.');
      const manifest = verifyManifest(readJSON(path.join(this.output, record.checkpoint.id, 'manifest.json')), trust);
      if (manifest.source?.agentAddress?.toLowerCase() !== agentAddress.toLowerCase()) throw new Error('Checkpoint source changed.');
      return { ...publicSummary(trust), ...record.checkpoint, sourceAgentAddress: agentAddress };
    } catch { return null; }
  }
  providerChoices() {
    const choices = [];
    const enrolled = this.configured(this.trustFile);
    if (enrolled.state === 'configured') choices.push({ id: 'default', label: 'Enrolled checkpoint provider', ...enrolled });
    const directory = path.join(path.dirname(this.trustFile), 'providers');
    if (fs.existsSync(directory)) for (const name of fs.readdirSync(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      try {
        const stored = readJSON(path.join(directory, name));
        const trust = publicCheckpointTrust(stored, stored.manifestURL);
        const created = Date.parse(stored.checkpoint?.createdAt);
        if (!Number.isFinite(created) || created > Date.now() + 60000 || Date.now() - created > trust.maxAgeHours * 3600000) continue;
        choices.push({ id: name.slice(0, -5), label: stored.sourceName || 'Selected wallet node', ...publicSummary(trust), checkpoint: stored.checkpoint, sourceAgentAddress: stored.sourceAgentAddress });
      } catch { /* Invalid local entries cannot become a restore source. */ }
    }
    return choices;
  }
  providerFile(id) {
    if (!this.providerChoices().some(choice => choice.id === id)) throw new Error('Choose an enrolled checkpoint source from the launcher.');
    return id === 'default' ? this.trustFile : path.join(path.dirname(this.trustFile), 'providers', id + '.json');
  }
  startProviderEnrollment(body) {
    fields(body, ['url', 'fingerprint', 'genesisHash', 'sourceAgentAddress', 'sourceName']);
    const logical = checkpointURL(body.url);
    if (logical.protocol !== 'grph:' || !/^\/checkpoints\/[a-zA-Z0-9-]{1,100}\/enrollment\.json$/.test(logical.pathname)) throw new Error('Choose a published wallet-node checkpoint.');
    if (!/^[a-f0-9]{64}$/i.test(body.fingerprint || '') || !/^[a-f0-9]{64}$/.test(body.genesisHash || '') || !/^0x[a-f0-9]{40}$/i.test(body.sourceAgentAddress || '') || typeof body.sourceName !== 'string' || body.sourceName.length > 64) throw new Error('Invalid wallet-node checkpoint selection.');
    const id = crypto.createHash('sha256').update(JSON.stringify([logical.href, body.fingerprint.toLowerCase(), body.genesisHash, body.sourceAgentAddress.toLowerCase()])).digest('hex');
    const file = path.join(path.dirname(this.trustFile), 'providers', id + '.json');
    return this.start('enroll-provider', async () => {
      if (!fs.existsSync(file)) {
        let checkpoint;
        const trust = await this.enroll({ url: logical.href, fingerprint: body.fingerprint, genesisHash: body.genesisHash, output: file, expectedSource: body.sourceAgentAddress, onVerified: manifest => { checkpoint = { id: manifest.id, height: manifest.height, createdAt: manifest.createdAt }; } });
        fs.writeFileSync(file, JSON.stringify({ ...trust, sourceAgentAddress: body.sourceAgentAddress, sourceName: body.sourceName, checkpoint }, null, 2), { mode: 0o600 });
      }
      return { providerId: id };
    });
  }
  publicEnrollment() {
    const stored = readJSON(this.publisherTrustFile);
    return publicCheckpointTrust(stored, stored.manifestURL);
  }
  configured(file) {
    if (!fs.existsSync(file)) return { state: 'missing' };
    try {
      const stored = readJSON(file), trust = publicCheckpointTrust(stored, stored.manifestURL);
      return { state: 'configured', ...publicSummary(trust) };
    } catch { return { state: 'invalid', error: 'The host’s checkpoint trust configuration needs administrator inspection.' }; }
  }
  status() {
    const publisher = this.configured(this.publisherTrustFile);
    let publication = null;
    if (publisher.state === 'configured' && fs.existsSync(path.join(this.output, 'latest.json'))) {
      try {
        const trust = readJSON(this.publisherTrustFile);
        const manifest = verifyManifest(readJSON(path.join(this.output, 'latest.json')), trust);
        publication = { state: 'verified', id: manifest.id, height: manifest.height, createdAt: manifest.createdAt };
      } catch { publication = { state: 'unavailable', error: 'The latest local checkpoint is expired or does not match the publisher trust.' }; }
    }
    return { creationAvailable: this.creationAvailable, enrollment: this.configured(this.trustFile), publisher, publication, job: this.job };
  }
  start(kind, work) {
    if (this.busy) throw new Error('Wait for the current checkpoint operation to finish.');
    const job = this.job = { id: crypto.randomUUID(), kind, state: 'running', phase: kind === 'create' ? 'Preparing checkpoint…' : 'Verifying publisher and latest checkpoint…', startedAt: new Date().toISOString() };
    this.task = Promise.resolve().then(() => work(message => { job.phase = String(message).slice(0, 500); })).then(result => {
      Object.assign(job, { state: 'succeeded', phase: kind === 'create' ? 'Checkpoint created and verified on this host.' : 'Checkpoint enrollment verified and installed.', result });
    }).catch(error => { Object.assign(job, { state: 'failed', phase: 'Operation failed.', error: String(error.message || 'Checkpoint operation failed.').slice(0, 1000) }); }).finally(() => { job.finishedAt = new Date().toISOString(); });
    return { accepted: true, job: { ...job } };
  }
  startEnrollment(body) {
    fields(body, ['url', 'fingerprint', 'genesisHash']);
    const url = publicURL(body.url, 'enrollment');
    if (!/^[a-f0-9]{64}$/i.test(body.fingerprint || '') || !/^[a-f0-9]{64}$/.test(body.genesisHash || '')) throw new Error('Enter the independently approved publisher fingerprint and canonical genesis hash.');
    if (fs.existsSync(this.trustFile)) throw new Error('This host already has checkpoint trust. Existing enrollment is preserved; ask its administrator to review any trust change.');
    return this.start('enroll', async () => {
      const trust = await this.enroll({ url, fingerprint: body.fingerprint, genesisHash: body.genesisHash, output: this.trustFile });
      return publicSummary(trust);
    });
  }
  startCreation(body, { source } = {}) {
    fields(body, ['manifestURL', 'confirmExport', 'confirmServing', 'sourceNodeId', 'wallet']);
    if (!this.creationAvailable) throw new Error('Checkpoint creation requires the full provider checkout and its isolated restore verifier on this host. Enrollment is available in the operator kit.');
    if (body.confirmExport !== true) throw new Error('Confirm that checkpoint creation briefly stops and resumes the selected nonvoting source on this host.');
    if (!source?.agentAddress || !source?.project) throw new Error('Choose an unlocked, synchronized nonvoting node from your wallet as the checkpoint source.');
    if (source.activeValidatorCount > 0 && body.confirmServing !== true) throw new Error('Confirm the interruption to this sentry’s validator connections before capture.');
    const manifestURL = publicURL(body.manifestURL, 'latest');
    return this.start('create', async progress => {
      let privateKey;
      if (fs.existsSync(this.keyFile)) {
        const stat = fs.lstatSync(this.keyFile);
        if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Publisher key must be a private regular file (mode 0600). Ask the host administrator to inspect it.');
        privateKey = fs.readFileSync(this.keyFile);
        if (crypto.createPrivateKey(privateKey).asymmetricKeyType !== 'ed25519') throw new Error('The configured publisher key is not Ed25519.');
      } else {
        fs.mkdirSync(path.dirname(this.keyFile), { recursive: true, mode: 0o700 });
        privateKey = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
        fs.writeFileSync(this.keyFile, privateKey, { flag: 'wx', mode: 0o600 });
      }
      const verifyRestore = this.verifyRestore || (await import('./checkpoint-verify.js')).verifyRestore;
      const result = await this.create({ output: this.output, privateKey, verifyRestore: (directory, trust) => verifyRestore(directory, trust, { reference: source }), progress, source, requireNonVoting: true });
      const trust = publicCheckpointTrust(result.trust, manifestURL);
      // Publisher enrollment is deliberately separate from receiver trust.
      fs.mkdirSync(path.dirname(this.publisherTrustFile), { recursive: true, mode: 0o700 });
      const temporary = `${this.publisherTrustFile}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(trust, null, 2), { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, this.publisherTrustFile);
      } finally { fs.rmSync(temporary, { force: true }); }
      const sourceTrust = { ...trust, manifestURL: new URL(`${result.manifest.id}/manifest.json`, manifestURL).href };
      const checkpoint = { id: result.manifest.id, height: result.manifest.height, createdAt: result.manifest.createdAt };
      const sourceFile = this.nodePublisherFile(source.agentAddress);
      fs.mkdirSync(path.dirname(sourceFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(sourceFile, JSON.stringify({ ...sourceTrust, checkpoint }, null, 2), { mode: 0o600 });
      fs.writeFileSync(path.join(this.output, result.manifest.id, 'enrollment.json'), JSON.stringify(sourceTrust, null, 2), { mode: 0o644 });
      return { ...publicSummary(sourceTrust), id: result.manifest.id, height: result.manifest.height, stats: result.stats || null, sourceAgentAddress: source.agentAddress, createdLocally: true };
    });
  }
}

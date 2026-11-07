import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hash, metadataHash, networkIdentity, signMetadata, verifyChannel, verifyRelease } from './update-contracts.js';
import { UpdateStore, fileHash } from './update-store.js';

// Publisher-only filesystem inputs are supplied by the release operator. Peers
// never send file paths or private keys through the update service.
export async function publishUpdate({ directory, profile, descriptor, sourceDirectory, releaseKey, releaseKeyId, channelKey, channelKeyId, sequence, expiresAt, now = Date.now() }) {
  const store = new UpdateStore(directory, profile);
  const releaseLock = store.acquire();
  try {
    if (!Array.isArray(descriptor.artifacts) || descriptor.artifacts.length < 1 || descriptor.artifacts.length > 64) throw new Error('Provide a bounded artifact list.');
    const sources = [];
    const artifacts = [];
    for (const input of descriptor.artifacts) {
      if (typeof input.file !== 'string') throw new Error('Specify a local artifact file.');
      const source = path.resolve(sourceDirectory, input.file);
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.size < 1 || stat.size > profile.maxArtifactBytes) throw new Error('Invalid publisher artifact size or file.');
      const chunkSize = 256 * 1024, chunks = [], digest = crypto.createHash('sha256');
      const fd = fs.openSync(source, 'r');
      try {
        for (let offset = 0; offset < stat.size; offset += chunkSize) {
          const bytes = Buffer.alloc(Math.min(chunkSize, stat.size - offset));
          if (fs.readSync(fd, bytes, 0, bytes.length, offset) !== bytes.length) throw new Error('Publisher artifact changed while reading.');
          digest.update(bytes); chunks.push(hash(bytes));
        }
      } finally { fs.closeSync(fd); }
      sources.push(source);
      artifacts.push({ component: input.component, role: input.role, os: input.os, arch: input.arch,
        bytes: stat.size, sha256: digest.digest('hex'), chunkSize, chunks });
    }
    const release = { format: 1, kind: 'graphene-release', updaterProtocol: 1, releaseId: descriptor.releaseId,
      classification: descriptor.classification, compatibleFrom: descriptor.compatibleFrom, artifacts };
    const releaseEnvelope = signMetadata(release, releaseKeyId, releaseKey);
    const releaseHash = metadataHash(release);
    verifyRelease(releaseEnvelope, profile, releaseHash);
    const channelEnvelope = signMetadata({ format: 1, kind: 'graphene-update-channel', network: networkIdentity(profile),
      channel: profile.channel, sequence, releaseHash, createdAt: new Date(now).toISOString(), expiresAt }, channelKeyId, channelKey);
    verifyChannel(channelEnvelope, profile, store.state(), now);
    // Commit channel metadata only after every artifact has been copied and
    // rehashed, so a publication never points to incomplete source bytes.
    for (let i = 0; i < artifacts.length; i++) {
      const artifact = artifacts[i];
      if (await store.hasArtifact(artifact)) continue;
      store.reserve(artifact.bytes);
      const target = store.artifactPath(artifact.sha256);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const temporary = target + '.part';
      try {
        fs.copyFileSync(sources[i], temporary);
        fs.chmodSync(temporary, 0o600);
        if (fs.statSync(temporary).size !== artifact.bytes || await fileHash(temporary) !== artifact.sha256) throw new Error('Publisher artifact changed during publication.');
        fs.renameSync(temporary, target);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    store.accept(channelEnvelope, releaseEnvelope, now);
    return store.save({ phase: 'staged', artifacts: artifacts.map(a => a.sha256), classification: release.classification });
  } finally { releaseLock(); }
}

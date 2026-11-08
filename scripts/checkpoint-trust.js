import crypto from 'node:crypto';
import { checkpointURL } from './checkpoint-core.js';

export function publicCheckpointTrust(trust, manifestURL) {
  checkpointURL(manifestURL);
  if (trust.chainId !== 9876 || !/^[a-f0-9]{64}$/.test(trust.genesisHash || '') || typeof trust.publicKey !== 'string' || trust.publicKey.includes('PRIVATE KEY')) throw new Error('Provide the independently approved public checkpoint trust configuration.');
  const key = crypto.createPublicKey(trust.publicKey);
  const maxAgeHours = trust.maxAgeHours ?? 24;
  if (key.asymmetricKeyType !== 'ed25519' || !Number.isFinite(maxAgeHours) || maxAgeHours <= 0) throw new Error('Invalid checkpoint public key or freshness policy.');
  return { chainId: trust.chainId, genesisHash: trust.genesisHash, publicKey: key.export({ type: 'spki', format: 'pem' }), maxAgeHours, manifestURL };
}

export function checkpointFingerprint(publicKey) {
  return crypto.createHash('sha256').update(crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' })).digest('hex');
}

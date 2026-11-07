import fs from 'node:fs';
import path from 'node:path';
import { generateAll } from '../agents/validator-agent/src/keygen.js';
import { encryptSecrets, loadKeystore } from '../agents/validator-agent/src/keystore.js';
import { publicNodeSetup } from '../agents/lib/node-setup.js';

// Import verifies the saved keys before returning an identity; it never creates keys.
export function prepareNodeIdentity({ directory, keystorePath = path.join(directory, 'keystore.enc'), sentrySecretsPath = path.join(directory, 'sentry-secrets.json') }, body) {
  const { role, name, passphrase, host, port, expectedIdentity } = body;
  if (!['validator', 'sentry'].includes(role) || typeof name !== 'string' || !name.trim() || name.trim().length > 64) {
    throw new Error('Choose a role and a node name (1–64 characters).');
  }
  if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024) {
    throw new Error('Use a password of at least 12 characters to protect your node keys.');
  }
  if (role === 'sentry' && (typeof host !== 'string' || !host || /[\s/@]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('Ask your node provider for the sentry’s reachable hostname and P2P port.');
  }
  const secretsPath = role === 'validator'
    ? keystorePath
    : sentrySecretsPath;
  if (expectedIdentity !== undefined) {
    const fields = ['agentAddress', 'encryptionPublicKey', 'nodeId', 'consensusPublicKey', 'transportPublicKey'];
    if (!expectedIdentity || typeof expectedIdentity !== 'object' || Array.isArray(expectedIdentity) ||
      Object.keys(expectedIdentity).some((key) => !fields.includes(key) || typeof expectedIdentity[key] !== 'string') ||
      !/^0x[0-9a-f]{40}$/i.test(expectedIdentity.agentAddress || '') ||
      !/^[0-9a-f]{64}$/i.test(expectedIdentity.encryptionPublicKey || '') ||
      !/^[0-9a-f]{40}$/i.test(expectedIdentity.nodeId || '') ||
      (role === 'validator' && !/^[A-Za-z0-9+/]{43}=$/.test(expectedIdentity.consensusPublicKey || ''))) {
      throw new Error('Choose a valid public setup file from your Graphene launcher.');
    }
    if (!fs.existsSync(secretsPath)) {
      throw new Error('The saved identity for this node is missing on this computer or server. A public setup file cannot restore private keys. Open the launcher in the original node folder, or ask your provider to restore its encrypted identity and signing state.');
    }
  }
  let secrets;
  if (fs.existsSync(secretsPath)) {
    // Resume the same identity. Setup must never silently replace signing keys.
    const bytes = fs.readFileSync(secretsPath);
    if (role === 'sentry' && bytes[0] === 123) {
      secrets = JSON.parse(bytes.toString('utf8'));
      const { x25519, agent } = secrets;
      if (!x25519?.secretKey || !agent?.privateKey || !secrets.tendermint?.node) throw new Error('This existing sentry needs its Tendermint node identity added by its operator. Existing keys have not been replaced.');
    } else {
      try { secrets = loadKeystore(secretsPath, passphrase); }
      catch { throw new Error('Could not unlock your saved node. Check its original password. If it is correct, ask your provider to check the encrypted identity backup.'); }
    }
  } else {
    // Both roles use local keys. The sentry runtime uses the same agent/encryption fields.
    secrets = generateAll();
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(secretsPath, encryptSecrets(secrets, passphrase), { flag: 'wx', mode: 0o600 });
  }
  const setup = publicNodeSetup(role, secrets, name.trim(), { host, port });
  if (expectedIdentity) {
    const mismatch = Object.entries(expectedIdentity).some(([field, value]) =>
      field === 'consensusPublicKey' ? setup[field] !== value : setup[field]?.toLowerCase() !== value.toLowerCase());
    if (mismatch) throw new Error('This setup file belongs to a different node. Choose the file for the node saved in this launcher folder. No keys have been changed.');
  }
  return { setup, secrets, passphrase, keystorePath: secretsPath };
}

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { randomBytes, logger } from './utils.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const SALT_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const ITERATIONS = 600_000;
const DIGEST = 'sha512';

function deriveKey(passphrase, salt) {
  return crypto.pbkdf2Sync(passphrase, salt, ITERATIONS, KEY_LENGTH, DIGEST);
}

export function encryptSecrets(secrets, passphrase) {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const plaintext = Buffer.from(JSON.stringify(secrets), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([salt, iv, authTag, encrypted]);
}

export function decryptSecrets(encryptedData, passphrase) {
  const salt = encryptedData.subarray(0, SALT_LENGTH);
  const iv = encryptedData.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = encryptedData.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = encryptedData.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

export function saveKeystore(secrets, passphrase, keystorePath) {
  const encrypted = encryptSecrets(secrets, passphrase);
  const dir = path.dirname(keystorePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(keystorePath, encrypted);
  fs.chmodSync(keystorePath, 0o600);
  logger.info(`Keystore saved to ${keystorePath}`);
}

export function loadKeystore(keystorePath, passphrase) {
  if (!fs.existsSync(keystorePath)) {
    throw new Error(`Keystore not found at ${keystorePath}`);
  }
  const encrypted = fs.readFileSync(keystorePath);
  try {
    return decryptSecrets(encrypted, passphrase);
  } catch {
    throw new Error('Invalid passphrase');
  }
}

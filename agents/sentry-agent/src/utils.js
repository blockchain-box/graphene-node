import crypto from 'crypto';
import fs from 'fs';

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

export function randomBytes(size) {
  return crypto.randomBytes(size);
}

export function toHex(buf) {
  return Buffer.isBuffer(buf) ? '0x' + buf.toString('hex') : String(buf);
}

export function fromHex(hex) {
  const str = hex.startsWith('0x') ? hex.slice(2) : hex;
  return Buffer.from(str, 'hex');
}

export { logger } from '../../lib/logger.js';

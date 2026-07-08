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

export const logger = {
  _logFile: null,

  init(filePath) {
    this._logFile = filePath;
  },

  log(level, msg) {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
    if (level === 'ERROR') {
      console.error(line);
    } else {
      console.log(line);
    }
    if (this._logFile) {
      fs.appendFileSync(this._logFile, line + '\n');
    }
  },

  info(msg) { this.log('INFO', msg); },
  warn(msg) { this.log('WARN', msg); },
  error(msg) { this.log('ERROR', msg); },
  debug(msg) { this.log('DEBUG', msg); },
};

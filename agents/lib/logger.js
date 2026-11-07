import fs from 'fs';

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

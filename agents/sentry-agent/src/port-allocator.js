import fs from 'fs';
import path from 'path';
import { logger } from './utils.js';

export class PortAllocator {
  constructor(rangeStart, rangeEnd, statePath) {
    this.rangeStart = rangeStart;
    this.rangeEnd = rangeEnd;
    this.statePath = statePath || '/app/state/port-map.json';
    this.allocations = new Map();
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.statePath)) {
        const data = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
        for (const [key, value] of Object.entries(data)) {
          this.allocations.set(key, value);
        }
        logger.info(`Loaded ${this.allocations.size} port allocations from ${this.statePath}`);
      }
    } catch (err) {
      logger.warn(`Failed to load port state: ${err.message}`);
    }
  }

  _save() {
    try {
      const dir = path.dirname(this.statePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      const obj = Object.fromEntries(this.allocations);
      fs.writeFileSync(this.statePath, JSON.stringify(obj, null, 2));
    } catch (err) {
      logger.error(`Failed to save port state: ${err.message}`);
    }
  }

  allocate(validatorId) {
    if (this.allocations.has(validatorId)) {
      return this.allocations.get(validatorId);
    }

    for (let port = this.rangeStart; port <= this.rangeEnd; port++) {
      if (![...this.allocations.values()].includes(port)) {
        this.allocations.set(validatorId, port);
        this._save();
        logger.info(`Allocated port ${port} for validator ${validatorId}`);
        return port;
      }
    }

    throw new Error(`No available ports in range ${this.rangeStart}-${this.rangeEnd}`);
  }

  release(validatorId) {
    if (this.allocations.has(validatorId)) {
      const port = this.allocations.get(validatorId);
      this.allocations.delete(validatorId);
      this._save();
      logger.info(`Released port ${port} for validator ${validatorId}`);
      return port;
    }
    return null;
  }

  get(validatorId) {
    return this.allocations.get(validatorId) || null;
  }

  list() {
    return new Map(this.allocations);
  }
}

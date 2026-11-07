import fs from 'fs';
import path from 'path';
import { openGrphClient } from '../../lib/grph-tunnel.js';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { fromHex, toHex, logger } from './utils.js';
import { addPeer, removePeer } from './config-writer.js';
import { restartContainer } from './docker.js';
import { dialPeer, peerConnections } from './peer-rpc.js';

export class TunnelManager {
  constructor(config, secrets, portAllocator, { openTunnel = openGrphClient } = {}) {
    this.openTunnel = openTunnel;
    this.config = config;
    this.secrets = secrets;
    this.portAllocator = portAllocator;
    this.clients = new Map();
    this.statePath = config.statePath || '/app/state/tunnels.json';
    this._restartTimer = null;
  }

  openInviteKey(encryptedConnectionString) {
    try {
      const data = fromHex(encryptedConnectionString);
      const pubKeyLen = 32;
      const nonceLen = nacl.box.nonceLength;

      const ephemeralPub = data.subarray(0, pubKeyLen);
      const nonce = data.subarray(pubKeyLen, pubKeyLen + nonceLen);
      const sealed = data.subarray(pubKeyLen + nonceLen);

      const x25519SecretKey = fromHex(this.secrets.x25519.secretKey);

      const decrypted = nacl.box.open(sealed, nonce, ephemeralPub, x25519SecretKey);

      if (!decrypted) {
        throw new Error('Decryption failed — wrong secret key or corrupted payload');
      }

      const inviteKey = naclUtil.encodeUTF8(decrypted);
      logger.info(`Successfully decrypted invite key`);
      return inviteKey;
    } catch (err) {
      logger.error(`Invite key decryption error: ${err.message}`);
      throw err;
    }
  }

  _scheduleRestart() {
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
    }
    this._restartTimer = setTimeout(async () => {
      this._restartTimer = null;
      await restartContainer(this.config.tendermintContainer);
    }, 1000);
  }

  async connect(validatorId, encryptedConnectionString, validatorPeer) {
    if (this.clients.has(validatorId)) {
      logger.warn(`Already connected to validator ${validatorId}`);
      const entry = this.clients.get(validatorId);
      await this.ensurePeer(entry);
      return entry;
    }

    logger.info(`Establishing tunnel to validator ${validatorId}`);

    const inviteKey = this.openInviteKey(encryptedConnectionString);

    const port = this.portAllocator.allocate(validatorId);

    let client;
    const transport = 'grph';
    try {
      const tunnel = await this.openTunnel(inviteKey, { host: this.config.proxyHost || '127.0.0.1', port });
      client = tunnel.client;
      this.clients.set(validatorId, {
        client,
        transport,
        port,
        peer: validatorPeer,
        inviteKey,
        encryptedConnectionString,
      });

      this._saveState();

      if (validatorPeer && this.config.tendermintRpcUrl) {
        await this.ensurePeer(this.clients.get(validatorId));
      } else if (validatorPeer) {
        const changed = addPeer(
          this.config.tendermintConfigPath,
          validatorPeer.nodeId,
          '127.0.0.1',
          port,
        );

        if (changed) {
          this._scheduleRestart();
        }
      }

      return { client, port };
    } catch (err) {
      try { await client?.destroy(); } catch {}
      this.clients.delete(validatorId);
      this.portAllocator.release(validatorId);
      logger.error(`Failed to connect tunnel for ${validatorId}: ${err.message}`);
      throw err;
    }
  }

  async disconnect(validatorId) {
    const entry = this.clients.get(validatorId);
    if (!entry) {
      logger.warn(`No tunnel found for validator ${validatorId}`);
      return false;
    }

    logger.info(`Disconnecting tunnel for validator ${validatorId}`);

    try {
      await entry.client.destroy();
    } catch (err) {
      logger.error(`Error destroying GrphClient for ${validatorId}: ${err.message}`);
    }

    this.portAllocator.release(validatorId);
    this.clients.delete(validatorId);

    if (entry.peer && !this.config.tendermintRpcUrl) {
      const changed = removePeer(
        this.config.tendermintConfigPath,
        entry.peer.nodeId,
        '127.0.0.1',
        entry.port,
      );

      if (changed) {
        this._scheduleRestart();
      }
    }

    this._saveState();
    return true;
  }

  async ensurePeer(entry) {
    if (!this.config.tendermintRpcUrl || !entry?.peer?.nodeId) return;
    const status = await peerConnections(this.config, new Map([['peer', entry]]));
    if (!status[0]?.peerConnected) await dialPeer(this.config, entry.peer.nodeId, entry.port);
  }

  async connectionStatus() {
    if (!this.config.tendermintRpcUrl) return [];
    return peerConnections(this.config, this.clients);
  }

  async disconnectAll() {
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    for (const [validatorId] of this.clients) {
      await this.disconnect(validatorId);
    }
  }

  get(validatorId) {
    return this.clients.get(validatorId) || null;
  }

  list() {
    return new Map(this.clients);
  }

  getPeers() {
    const peers = [];
    for (const [validatorId, entry] of this.clients) {
      if (entry.peer && !this.config.tendermintRpcUrl) {
        peers.push(entry.peer);
      }
    }
    return peers;
  }

  _saveState() {
    try {
      const dir = path.dirname(this.statePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      const obj = {};
      for (const [validatorId, entry] of this.clients) {
        obj[validatorId] = {
          port: entry.port,
          peer: entry.peer,
          encryptedConnectionString: entry.encryptedConnectionString,
        };
      }
      fs.writeFileSync(this.statePath, JSON.stringify(obj, null, 2));
    } catch (err) {
      logger.error(`Failed to save tunnel state: ${err.message}`);
    }
  }
}

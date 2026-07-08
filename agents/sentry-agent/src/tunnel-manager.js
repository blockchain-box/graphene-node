import fs from 'fs';
import path from 'path';
import { GrphClient } from '@grph-net/client';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { fromHex, toHex, logger } from './utils.js';
import { addPeer, removePeer } from './config-writer.js';
import { restartContainer } from './docker.js';

export class TunnelManager {
  constructor(config, secrets, portAllocator) {
    this.config = config;
    this.secrets = secrets;
    this.portAllocator = portAllocator;
    this.clients = new Map();
    this.statePath = config.statePath || '/app/state/tunnels.json';
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

  async connect(validatorId, encryptedConnectionString, validatorPeer) {
    if (this.clients.has(validatorId)) {
      logger.warn(`Already connected to validator ${validatorId}`);
      return this.clients.get(validatorId);
    }

    logger.info(`Establishing tunnel to validator ${validatorId}`);

    const inviteKey = this.openInviteKey(encryptedConnectionString);

    const port = this.portAllocator.allocate(validatorId);

    const client = new GrphClient({
      key: inviteKey,
      silent: false,
    });

    client.logger = {
      log: (entry) => {
        logger.info(`[GrphClient:${validatorId}] ${entry.msg}`);
      },
    };

    try {
      await client.connect(
        {
          host: '127.0.0.1',
          port,
        },
        () => {
          logger.info(`Tunnel to validator ${validatorId} connected on 127.0.0.1:${port}`);
        },
      );

      this.clients.set(validatorId, {
        client,
        port,
        peer: validatorPeer,
        inviteKey,
        encryptedConnectionString,
      });

      this._saveState();

      if (validatorPeer) {
        const changed = addPeer(
          this.config.tendermintConfigPath,
          validatorPeer.nodeId,
          '127.0.0.1',
          port,
        );

        if (changed) {
          await restartContainer(this.config.tendermintContainer);
        }
      }

      return { client, port };
    } catch (err) {
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

    if (entry.peer) {
      const changed = removePeer(
        this.config.tendermintConfigPath,
        entry.peer.nodeId,
        '127.0.0.1',
        entry.port,
      );

      if (changed) {
        await restartContainer(this.config.tendermintContainer);
      }
    }

    this._saveState();
    return true;
  }

  async disconnectAll() {
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
      if (entry.peer) {
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

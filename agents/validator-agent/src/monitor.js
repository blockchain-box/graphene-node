import { ethers } from 'ethers';
import { createRpcProvider } from '../../lib/rpc-provider.js';
import z32 from 'z32';
import nacl from 'tweetnacl';
import { decodeSentryEncryptionKey, isEncryptionPublicKey } from '../../lib/connection-keys.js';
import { toHex, logger } from './utils.js';
import naclUtil from 'tweetnacl-util';
import { WebSocket } from 'ws';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { createHealthServer } from '../../lib/health-server.js';

const PLATFORM_ABI = [
  'function submitConnectionString(uint256 assignmentId, string encryptedConnectionString)',
];

const TRANSIENT_ERROR_RE = /(timeout|network|disconnect|ECONNREFUSED|ENOTFOUND|503|429|underpriced|nonce|missing response for request|insufficient funds)/i;

const RETRY_MAX_ATTEMPTS = parseInt(process.env.RETRY_MAX_ATTEMPTS || '5', 10);
const RETRY_BASE_DELAY_MS = parseInt(process.env.RETRY_BASE_DELAY_MS || '1000', 10);
const RETRY_MAX_DELAY_MS = parseInt(process.env.RETRY_MAX_DELAY_MS || '30000', 10);

const WS_BASE_DELAY = parseInt(process.env.WS_RECONNECT_BASE_DELAY_MS || '1000', 10);
const WS_MAX_ATTEMPTS = parseInt(process.env.WS_MAX_ATTEMPTS || '10', 10);
const WS_MAX_DELAY = parseInt(process.env.WS_MAX_DELAY_MS || '30000', 10);

function sealInviteKey(inviteKey, sentryX25519PublicKey) {
  const sentryPub = decodeSentryEncryptionKey(sentryX25519PublicKey);
  const message = typeof inviteKey === 'string' ? inviteKey : toHex(inviteKey);

  const ephemeralKeyPair = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const messageBytes = naclUtil.decodeUTF8(message);

  const sealed = nacl.box(messageBytes, nonce, sentryPub, ephemeralKeyPair.secretKey);

  const payload = Buffer.concat([
    Buffer.from(ephemeralKeyPair.publicKey),
    nonce,
    Buffer.from(sealed),
  ]);

  return toHex(payload);
}

function classifyTxError(message) {
  if (TRANSIENT_ERROR_RE.test(message)) {
    return 'transient';
  }
  return 'permanent';
}

async function submitConnectionString(config, secrets, assignmentId, sentryX25519Pub) {
  const provider = createRpcProvider(config.rpcUrl);
  let txHash = config.pendingTransactionHash || null;
  try {
    if (!txHash) {
      const signer = new ethers.Wallet(secrets.agent.privateKey);
      const abi = new ethers.Interface(PLATFORM_ABI);
      const balance = BigInt(await provider.send('eth_getBalance', [secrets.agent.address, 'latest']));
      const encrypted = sealInviteKey(z32.encode(Buffer.from(secrets.grph.keyPair.publicKey, 'hex')), sentryX25519Pub);
      const data = abi.encodeFunctionData('submitConnectionString', [assignmentId, encrypted]);
      const [estimate, gasPrice, nonce, chainId] = await Promise.all([
        provider.send('eth_estimateGas', [{ from: secrets.agent.address, to: config.contractAddress, data }]),
        provider.send('eth_gasPrice', []),
        provider.send('eth_getTransactionCount', [secrets.agent.address, 'pending']),
        provider.send('eth_chainId', []),
      ]);
      const gasLimit = BigInt(estimate) * 120n / 100n;
      if (balance < gasLimit * BigInt(gasPrice)) {
        return { success: false, error: `Agent account ${secrets.agent.address} has insufficient funds for the publication fee on this network.`, errorType: 'transient' };
      }
      // Native consensus has no Ethereum difficulty/base-fee block fields. Supply
      // every transaction field explicitly and sign locally; do not infer fees.
      const signed = await signer.signTransaction({
        type: 0, to: config.contractAddress, data, value: 0n,
        gasLimit, gasPrice: BigInt(gasPrice),
        nonce: Number(BigInt(nonce)), chainId: BigInt(chainId),
      });
      txHash = await provider.send('eth_sendRawTransaction', [signed]);
      config.onSubmitted?.(txHash);
      logger.info(`Connection transaction submitted for assignment ${assignmentId}: ${txHash}`);
    }
    const deadline = Date.now() + (config.receiptTimeoutMs ?? 120000);
    while (Date.now() < deadline) {
      const receipt = await provider.send('eth_getTransactionReceipt', [txHash]);
      if (receipt) {
        if (BigInt(receipt.status ?? '0x0') !== 1n) {
          return { success: false, txHash, error: receipt.errorMessage || 'Connection publication was rejected by the chain.', errorType: 'permanent' };
        }
        logger.info(`Connection transaction confirmed in block ${receipt.blockNumber}`);
        return { success: true, txHash, blockNumber: receipt.blockNumber };
      }
      await new Promise((resolve) => setTimeout(resolve, config.receiptPollMs ?? 1000));
    }
    return { success: false, txHash, error: 'Connection transaction confirmation timeout; will keep checking the same transaction.', errorType: 'transient' };
  } catch (err) {
    const errorType = txHash ? 'transient' : classifyTxError(err.message);
    logger[errorType === 'transient' ? 'warn' : 'error'](`Submit failed (${errorType}): ${err.message}`);
    return { success: false, txHash, error: err.message, errorType };
  } finally {
    provider.destroy();
  }
}

function restartTendermint(containerName) {
  try {
    execSync(`docker restart ${containerName}`, { timeout: 30000 });
    logger.info(`Tendermint container ${containerName} restarted successfully`);
  } catch (err) {
    logger.error(`Failed to restart Tendermint container ${containerName}: ${err.message}`);
  }
}

class ApprovalMonitor {
  constructor(config, secrets) {
    this.config = config;
    this.secrets = secrets;
    this.pollInterval = parseInt(config.pollIntervalMs || '15000', 10);
    this.wsUrl = config.wsUrl || null;
    this.baseUrl = config.rpcUrl.replace(/\/$/, '').replace(/\/rpc$/, '');
    this.processedAssignments = new Set();
    this.errors = new Map();
    this.pendingTransactions = new Map();
    this.polling = false;
    this.ws = null;
    this.timer = null;
    this.running = false;
    this.degraded = false;
    this.lastPollSuccess = false;
    this.lastPollTime = 0;

    this.stateDir = process.env.STATE_DIR || '/app/state';
    this.assignmentsStatePath = path.join(this.stateDir, 'assignments.json');
    this.persistentPeersConfigPath = config.persistentPeersConfigPath
      || path.join(os.homedir(), '.graphene', 'validator', 'config', 'config.toml');
    this.tendermintContainer = config.tendermintContainer || 'validator-node';
    this._peerDebounceTimer = null;
    this._wsAttempt = 0;
    this._healthServer = null;

    this._loadProcessedAssignments();
  }

  _ensureStateDir() {
    if (!fs.existsSync(this.stateDir)) {
      fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    }
  }

  _loadProcessedAssignments() {
    try {
      this._ensureStateDir();
      if (fs.existsSync(this.assignmentsStatePath)) {
        const data = JSON.parse(fs.readFileSync(this.assignmentsStatePath, 'utf8'));
        if (Array.isArray(data)) {
          for (const id of data) {
            this.processedAssignments.add(id);
          }
        } else if (data && typeof data === 'object') {
          if (Array.isArray(data.processedAssignmentIds)) {
            for (const id of data.processedAssignmentIds) {
              this.processedAssignments.add(id);
            }
          }
          for (const [id, hash] of Object.entries(data.pendingTransactions || {})) {
            if (typeof hash === 'string' && /^0x[0-9a-f]{64}$/i.test(hash)) this.pendingTransactions.set(id, hash);
          }
          if (data.errors && typeof data.errors === 'object') {
            for (const [id, err] of Object.entries(data.errors)) {
              this.errors.set(id, err);
            }
          }
        }
        logger.info(`Loaded ${this.processedAssignments.size} processed assignments from state, ${this.errors.size} errors`);
      }
    } catch (err) {
      logger.warn(`Failed to load assignments state: ${err.message}`);
    }
  }

  _saveProcessedAssignments() {
    try {
      this._ensureStateDir();
      const errorsObj = {};
      for (const [id, err] of this.errors) {
        errorsObj[id] = err;
      }
      const data = {
        processedAssignmentIds: [...this.processedAssignments],
        errors: errorsObj,
        pendingTransactions: Object.fromEntries(this.pendingTransactions),
      };
      fs.writeFileSync(this.assignmentsStatePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      logger.error(`Failed to save assignments state: ${err.message}`);
    }
  }

  async _processAssignment(assignment) {
    logger.info(`New active assignment detected: ${assignment.id}, sentry: ${assignment.sentryId}`);

    const sentriesUrl = `${this.baseUrl}/graphene/state/platform/sentries`;
    const sentries = await this.fetchJson(sentriesUrl);
    const sentry = sentries.find((s) => s.sentryId === assignment.sentryId);

    if (!sentry || !sentry.encryptionPublicKey) {
      logger.warn(`Sentry ${assignment.sentryId} has no encryption public key`);
      return null;
    }

    logger.info(`Sealing invite key for sentry ${assignment.sentryId}`);
    const result = await submitConnectionString(
      { ...this.config, pendingTransactionHash: this.pendingTransactions.get(assignment.id), onSubmitted: (hash) => { this.pendingTransactions.set(assignment.id, hash); this._saveProcessedAssignments(); } },
      this.secrets,
      assignment.id,
      sentry.encryptionPublicKey,
    );

    if (result.success) {
      this.pendingTransactions.delete(assignment.id);
      this.processedAssignments.add(assignment.id);
      this.errors.delete(assignment.id);
      this._saveProcessedAssignments();
      logger.info(`Assignment ${assignment.id} completed, tx: ${result.txHash}`);
    } else if (result.errorType === 'permanent') {
      this.pendingTransactions.delete(assignment.id);
      this.processedAssignments.add(assignment.id);
      this.errors.set(assignment.id, { lastError: result.error, errorType: 'PERMANENT' });
      this._saveProcessedAssignments();
      logger.error(`Assignment ${assignment.id} permanently failed: ${result.error}`);
    } else if (result.error?.includes('already')) {
      this.processedAssignments.add(assignment.id);
      this._saveProcessedAssignments();
    } else {
      this.errors.set(assignment.id, { lastError: result.error, errorType: 'TRANSIENT' });
      this._saveProcessedAssignments();
    }

    return result;
  }

  async fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
  }

  async checkAssignments() {
    if (this.polling) return;
    this.polling = true;
    let success = false;
    try {
      const assignmentsUrl = `${this.baseUrl}/graphene/state/platform/assignments?agent=${this.secrets.agent.address}`;
      const assignments = await this.fetchJson(assignmentsUrl);

      const pendingAssignments = [];
      let registeredSentries;
      for (const assignment of assignments) {
        // Recover transport/funding errors incorrectly marked permanent by older agents.
        // Only retry active assignments that still lack on-chain connection details.
        const previous = this.errors.get(assignment.id);
        if (!assignment.encryptedConnectionString && /^(active)$/i.test(assignment.status)
          && /missing response for request|insufficient funds|invalid value for value\.difficulty/i.test(previous?.lastError || '')) {
          this.processedAssignments.delete(assignment.id);
          this.errors.delete(assignment.id);
        }
        if (!assignment.encryptedConnectionString && /^(active)$/i.test(assignment.status)
          && /bad public key size|registered sentry encryption key/i.test(previous?.lastError || '')) {
          registeredSentries ||= await this.fetchJson(`${this.baseUrl}/graphene/state/platform/sentries`);
          const sentry=registeredSentries.find(s=>s.sentryId?.toLowerCase()===assignment.sentryId?.toLowerCase());
          if(isEncryptionPublicKey(sentry?.encryptionPublicKey)){
            this.processedAssignments.delete(assignment.id);this.errors.delete(assignment.id);
          }
        }
        if (assignment.encryptedConnectionString) {
          this.errors.delete(assignment.id);
          this.pendingTransactions.delete(assignment.id);
          this.processedAssignments.add(assignment.id);
          this._saveProcessedAssignments();
          continue;
        }
        if (this.processedAssignments.has(assignment.id)) continue;
        if (assignment.status !== 'ACTIVE' && assignment.status !== 'Active') {
          continue;
        }
        pendingAssignments.push(assignment);
      }

      if (pendingAssignments.length > 0) {
        // One signing account: serialize publications so assignments cannot reuse a nonce.
        for (const assignment of pendingAssignments) {
          try { await this._processAssignment(assignment); }
          catch (error) { logger.error(`Assignment processing rejected: ${error.message}`); }
        }
      }

      if (this.config.managePeers !== false) await this._schedulePersistentPeersUpdate(assignments);
      success = true;
    } catch (err) {
      logger.error(`Monitor poll error: ${err.message}`);
    } finally {
      this.polling = false;
      this.lastPollSuccess = success;
      this.lastPollTime = Date.now();
      this.degraded = !success;
    }
  }

  async _schedulePersistentPeersUpdate(assignments) {
    const activeIds = assignments
      .filter((a) => a.status === 'ACTIVE' || a.status === 'Active')
      .map((a) => a.sentryId);

    if (this._peerDebounceTimer) {
      clearTimeout(this._peerDebounceTimer);
    }

    this._peerDebounceTimer = setTimeout(async () => {
      this._peerDebounceTimer = null;
      try {
        const sentriesUrl = `${this.baseUrl}/graphene/state/platform/sentries`;
        const sentries = await this.fetchJson(sentriesUrl);
        const activeSentries = sentries.filter((s) => activeIds.includes(s.sentryId));

        const peers = activeSentries
          .filter((s) => s.tendermintNodeId && s.p2pHost && s.p2pPort)
          .map((s) => `${s.tendermintNodeId}@${s.p2pHost}:${s.p2pPort}`);

        if (peers.length === 0) return;

        const peersStr = peers.join(',');
        const configPath = this.persistentPeersConfigPath;

        let content;
        try {
          content = fs.readFileSync(configPath, 'utf8');
        } catch {
          logger.warn(`Cannot read Tendermint config at ${configPath}`);
          return;
        }

        const peerRegex = /^persistent_peers\s*=\s*"(.*)"$/m;
        let newContent;
        if (content.match(peerRegex)) {
          newContent = content.replace(peerRegex, `persistent_peers = "${peersStr}"`);
        } else {
          newContent = content.replace(
            /^(proxy_app\s*=.*)$/m,
            `$1\npersistent_peers = "${peersStr}"`,
          );
        }

        fs.writeFileSync(configPath, newContent);
        logger.info(`Updated persistent_peers in ${configPath}: ${peersStr}`);

        restartTendermint(this.tendermintContainer);
      } catch (err) {
        logger.error(`Failed to update persistent_peers: ${err.message}`);
      }
    }, 1000);
  }

  connectWebSocket() {
    if (!this.wsUrl) return;

    try {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.on('open', () => {
        this._wsAttempt = 0;
        logger.info('WebSocket connected to tx-watch');
      });

      this.ws.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());
          if (event.type === 'ConnectionStringSubmitted' || event.type === 'ApplicationApproved') {
            logger.info(`WebSocket event: ${event.type}, triggering assignment check`);
            this.checkAssignments();
          }
        } catch {
          // ignore parse errors
        }
      });

      this.ws.on('close', () => {
        const delay = Math.min(WS_BASE_DELAY * Math.pow(2, this._wsAttempt), WS_MAX_DELAY);
        this._wsAttempt = Math.min(this._wsAttempt + 1, WS_MAX_ATTEMPTS);
        logger.warn(`WebSocket disconnected, will reconnect in ${delay}ms (attempt ${this._wsAttempt})`);
        setTimeout(() => {
          if (this.running) this.connectWebSocket();
        }, delay);
      });

      this.ws.on('error', (err) => {
        logger.error(`WebSocket error: ${err.message}`);
      });
    } catch (err) {
      logger.error(`WebSocket setup error: ${err.message}`);
    }
  }

  _startHealthServer() {
    if (this._healthServer) return;

    const pollIntervalMs = this.pollInterval;

    this._healthServer = createHealthServer(async () => {
      const ready = this.lastPollSuccess
        && (Date.now() - this.lastPollTime) <= (2 * pollIntervalMs)
        && !this.degraded;

      return {
        ready,
        details: {
          updates: this.config.updateStatus?.() || { enabled: false },
          lastPollSuccess: this.lastPollSuccess,
          lastPollTime: this.lastPollTime ? new Date(this.lastPollTime).toISOString() : null,
          degraded: this.degraded,
          processedCount: this.processedAssignments.size,
          errors: Object.fromEntries(this.errors),
        },
      };
    });
  }

  async start() {
    this.running = true;
    logger.info('Approval monitor started');
    logger.info(`Poll interval: ${this.pollInterval}ms`);

    this._startHealthServer();

    await this.checkAssignments();

    this.timer = setInterval(() => {
      if (this.running) this.checkAssignments();
    }, this.pollInterval);

    if (this.wsUrl) {
      this.connectWebSocket();
    }
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this._peerDebounceTimer) {
      clearTimeout(this._peerDebounceTimer);
      this._peerDebounceTimer = null;
    }
    if (this._healthServer) {
      this._healthServer.close();
      this._healthServer = null;
    }
    logger.info('Approval monitor stopped');
  }
}

export { ApprovalMonitor, sealInviteKey, submitConnectionString };

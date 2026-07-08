import { ethers } from 'ethers';
import nacl from 'tweetnacl';
import { fromHex, toHex, logger } from './utils.js';
import naclUtil from 'tweetnacl-util';
import { WebSocket } from 'ws';

const PLATFORM_ABI = [
  'function submitConnectionString(uint256 assignmentId, string encryptedConnectionString)',
];

function sealInviteKey(inviteKey, sentryX25519PublicKey) {
  const sentryPub = fromHex(sentryX25519PublicKey);
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

async function submitConnectionString(config, secrets, assignmentId, sentryX25519Pub) {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const signer = new ethers.Wallet(secrets.agent.privateKey, provider);

  const contract = new ethers.Contract(config.contractAddress, PLATFORM_ABI, signer);

  const encryptedConnectionString = sealInviteKey(secrets.grph.invite, sentryX25519Pub);

  logger.info(`Submitting connection string for assignment ${assignmentId}`);
  logger.info(`Encrypted connection string: ${encryptedConnectionString}`);

  try {
    const estimate = await provider.estimateGas({
      from: secrets.agent.address,
      to: config.contractAddress,
      data: contract.interface.encodeFunctionData('submitConnectionString', [
        assignmentId,
        encryptedConnectionString,
      ]),
    });

    const tx = await contract.submitConnectionString(assignmentId, encryptedConnectionString, {
      gasLimit: estimate * 120n / 100n,
    });

    logger.info(`Transaction submitted: ${tx.hash}`);

    const receipt = await tx.wait();
    logger.info(`Transaction confirmed in block ${receipt.blockNumber}`);
    return { success: true, txHash: tx.hash, blockNumber: receipt.blockNumber };
  } catch (err) {
    logger.error(`Submit failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

class ApprovalMonitor {
  constructor(config, secrets) {
    this.config = config;
    this.secrets = secrets;
    this.pollInterval = parseInt(config.pollIntervalMs || '15000', 10);
    this.wsUrl = config.wsUrl || null;
    this.baseUrl = config.rpcUrl.replace(/\/$/, '');
    this.processedAssignments = new Set();
    this.ws = null;
    this.timer = null;
    this.running = false;
  }

  async fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
  }

  async checkAssignments() {
    try {
      const validatorUrl = `${this.baseUrl}/graphene/state/platform/validators/${this.secrets.agent.address}`;
      let validator;
      try {
        validator = await this.fetchJson(validatorUrl);
      } catch {
        logger.debug('Validator not yet registered on chain');
        return;
      }

      if (!validator) {
        logger.debug('Validator not found on chain');
        return;
      }

      const assignmentsUrl = `${this.baseUrl}/graphene/state/platform/assignments?validator=${this.secrets.agent.address}`;
      const assignments = await this.fetchJson(assignmentsUrl);

      for (const assignment of assignments) {
        if (this.processedAssignments.has(assignment.id)) continue;
        if (assignment.encryptedConnectionString) {
          this.processedAssignments.add(assignment.id);
          continue;
        }
        if (assignment.status !== 'ACTIVE' && assignment.status !== 'Active') {
          continue;
        }

        logger.info(`New active assignment detected: ${assignment.id}, sentry: ${assignment.sentryId}`);

        const sentriesUrl = `${this.baseUrl}/graphene/state/platform/sentries`;
        const sentries = await this.fetchJson(sentriesUrl);
        const sentry = sentries.find((s) => s.sentryId === assignment.sentryId);

        if (!sentry || !sentry.encryptionPublicKey) {
          logger.warn(`Sentry ${assignment.sentryId} has no encryption public key`);
          continue;
        }

        logger.info(`Sealing invite key for sentry ${assignment.sentryId}`);
        const result = await submitConnectionString(
          this.config,
          this.secrets,
          assignment.id,
          sentry.encryptionPublicKey,
        );

        if (result.success) {
          this.processedAssignments.add(assignment.id);
          logger.info(`Assignment ${assignment.id} completed, tx: ${result.txHash}`);
        } else {
          logger.error(`Assignment ${assignment.id} failed: ${result.error}`);
          if (result.error?.includes('already')) {
            this.processedAssignments.add(assignment.id);
          }
        }
      }
    } catch (err) {
      logger.error(`Monitor poll error: ${err.message}`);
    }
  }

  connectWebSocket() {
    if (!this.wsUrl) return;

    try {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.on('open', () => {
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
        logger.warn('WebSocket disconnected, will reconnect in 10s');
        setTimeout(() => {
          if (this.running) this.connectWebSocket();
        }, 10000);
      });

      this.ws.on('error', (err) => {
        logger.error(`WebSocket error: ${err.message}`);
      });
    } catch (err) {
      logger.error(`WebSocket setup error: ${err.message}`);
    }
  }

  async start() {
    this.running = true;
    logger.info('Approval monitor started');
    logger.info(`Poll interval: ${this.pollInterval}ms`);

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
    logger.info('Approval monitor stopped');
  }
}

export { ApprovalMonitor, sealInviteKey, submitConnectionString };

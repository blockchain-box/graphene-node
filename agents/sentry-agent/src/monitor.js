import { ethers } from 'ethers';
import { WebSocket } from 'ws';
import { logger } from './utils.js';

export class AssignmentMonitor {
  constructor(config, secrets, tunnelManager) {
    this.config = config;
    this.secrets = secrets;
    this.tunnelManager = tunnelManager;
    this.pollInterval = parseInt(config.pollIntervalMs || '15000', 10);
    this.wsUrl = config.wsUrl || null;
    this.baseUrl = config.rpcUrl.replace(/\/$/, '');
    this.processedAssignments = new Map();
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
      const sentryAddress = this.secrets.agent.address.toLowerCase();
      const assignmentsUrl = `${this.baseUrl}/graphene/state/platform/assignments?sentry=${sentryAddress}`;
      let assignments;
      try {
        assignments = await this.fetchJson(assignmentsUrl);
      } catch {
        logger.debug('Failed to fetch assignments (platform not deployed?)');
        return;
      }

      if (!Array.isArray(assignments) || assignments.length === 0) {
        return;
      }

      for (const assignment of assignments) {
        const id = assignment.id || assignment.assignmentId;

        if (assignment.status === 'REVOKED' || assignment.status === 'Revoked') {
          await this._handleRevoke(id, assignment);
          continue;
        }

        if (assignment.status !== 'ACTIVE' && assignment.status !== 'Active') {
          continue;
        }

        if (!assignment.encryptedConnectionString) {
          logger.debug(`Assignment ${id} has no connection string yet`);
          continue;
        }

        if (this.processedAssignments.has(id)) {
          const existing = this.processedAssignments.get(id);
          if (existing.encryptedConnectionString === assignment.encryptedConnectionString) {
            continue;
          }
        }

        logger.info(`New/updated assignment detected: ${id}, validator: ${assignment.validatorId}`);

        try {
          const validatorsUrl = `${this.baseUrl}/graphene/state/platform/validators/${assignment.validatorId}`;
          let validator;
          try {
            validator = await this.fetchJson(validatorsUrl);
          } catch {
            logger.warn(`Validator ${assignment.validatorId} not found on chain`);
            continue;
          }

          if (!validator) {
            logger.warn(`Validator ${assignment.validatorId} data is null`);
            continue;
          }

          const validatorPeer = {
            nodeId: validator.nodeId || validator.p2pNodeId || validator.id,
            host: validator.host || validator.publicEndpoint,
            port: validator.p2pPort,
          };

          await this.tunnelManager.connect(
            assignment.validatorId,
            assignment.encryptedConnectionString,
            validatorPeer,
          );

          this.processedAssignments.set(id, {
            encryptedConnectionString: assignment.encryptedConnectionString,
            validatorId: assignment.validatorId,
          });

          logger.info(`Assignment ${id} processed successfully`);
        } catch (err) {
          logger.error(`Failed to process assignment ${id}: ${err.message}`);
        }
      }

      this._handleDisconnectedValidators(assignments);
    } catch (err) {
      logger.error(`Monitor poll error: ${err.message}`);
    }
  }

  async _handleRevoke(assignmentId, assignment) {
    if (!this.processedAssignments.has(assignmentId)) return;

    logger.info(`Revocation detected for assignment ${assignmentId}`);

    try {
      await this.tunnelManager.disconnect(assignment.validatorId);
      this.processedAssignments.delete(assignmentId);
      logger.info(`Cleaned up assignment ${assignmentId}`);
    } catch (err) {
      logger.error(`Failed to clean up revoked assignment ${assignmentId}: ${err.message}`);
    }
  }

  _handleDisconnectedValidators(activeAssignments) {
    const activeValidatorIds = new Set(
      activeAssignments
        .filter(a => a.status === 'ACTIVE' || a.status === 'Active')
        .map(a => a.validatorId),
    );

    for (const [assignmentId, info] of this.processedAssignments) {
      if (!activeValidatorIds.has(info.validatorId)) {
        logger.info(`Validator ${info.validatorId} no longer has active assignment`);
        this.tunnelManager.disconnect(info.validatorId);
        this.processedAssignments.delete(assignmentId);
      }
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
          if (
            event.type === 'ConnectionStringSubmitted' ||
            event.type === 'AssignmentCreated' ||
            event.type === 'AssignmentRevoked'
          ) {
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
    logger.info('Assignment monitor started');
    logger.info(`Poll interval: ${this.pollInterval}ms`);
    logger.info(`Monitoring assignments for sentry: ${this.secrets.agent.address}`);

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
    logger.info('Assignment monitor stopped');
  }
}

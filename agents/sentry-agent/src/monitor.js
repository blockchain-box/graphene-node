import { ethers } from 'ethers';
import { WebSocket } from 'ws';
import { logger } from './utils.js';
import fs from 'fs';
import path from 'path';
import { GrphClient } from '@grph-net/client';
import { createHealthServer } from '../../lib/health-server.js';

const TRANSIENT_ERROR_RE = /(timeout|network|disconnect|ECONNREFUSED|ENOTFOUND|503|429|underpriced|nonce)/i;

const WS_BASE_DELAY = parseInt(process.env.WS_RECONNECT_BASE_DELAY_MS || '1000', 10);
const WS_MAX_ATTEMPTS = parseInt(process.env.WS_MAX_ATTEMPTS || '10', 10);
const WS_MAX_DELAY = parseInt(process.env.WS_MAX_DELAY_MS || '30000', 10);

function classifyError(message) {
  if (TRANSIENT_ERROR_RE.test(message)) {
    return 'transient';
  }
  return 'permanent';
}

export class AssignmentMonitor {
  constructor(config, secrets, tunnelManager) {
    this.config = config;
    this.secrets = secrets;
    this.tunnelManager = tunnelManager;
    this.pollInterval = parseInt(config.pollIntervalMs || '15000', 10);
    this.wsUrl = config.wsUrl || null;
    this.baseUrl = config.rpcUrl.replace(/\/$/, '').replace(/\/rpc$/, '');
    this.processedAssignments = new Map();
    this.ws = null;
    this.timer = null;
    this.running = false;
    this.degraded = false;
    this.lastPollSuccess = false;
    this.lastPollTime = 0;
    this.lastVerifiedTime = Date.now();

    this.stateDir = process.env.STATE_DIR || '/app/state';
    this.processedAssignmentsPath = path.join(this.stateDir, 'processed-assignments.json');
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
      if (fs.existsSync(this.processedAssignmentsPath)) {
        const data = JSON.parse(fs.readFileSync(this.processedAssignmentsPath, 'utf8'));
        if (Array.isArray(data)) {
          for (const entry of data) {
            this.processedAssignments.set(entry.id, {
              encryptedConnectionString: entry.encryptedConnectionString,
              validatorId: entry.validatorId,
              lastError: entry.lastError || null,
              errorType: entry.errorType || null,
            });
          }
        }
        logger.info(`Loaded ${this.processedAssignments.size} processed assignments from state`);
      }
    } catch (err) {
      logger.warn(`Failed to load processed assignments state: ${err.message}`);
    }
  }

  _saveProcessedAssignments() {
    try {
      this._ensureStateDir();
      const arr = [];
      for (const [id, info] of this.processedAssignments) {
        arr.push({
          id,
          encryptedConnectionString: info.encryptedConnectionString,
          validatorId: info.validatorId,
          lastError: info.lastError || null,
          errorType: info.errorType || null,
        });
      }
      fs.writeFileSync(this.processedAssignmentsPath, JSON.stringify(arr, null, 2), 'utf8');
    } catch (err) {
      logger.error(`Failed to save processed assignments state: ${err.message}`);
    }
  }

  async fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
  }

  async _recoverTunnels() {
    // Never trust stale local success markers. checkAssignments rebuilds tunnels
    // from current, active on-chain assignments and the current validator record.
    this.processedAssignments.clear();
  }

  async checkAssignments() {
    if (this.polling) return;
    this.polling = true;
    let success = false;
    try {
      const sentryAddress = this.secrets.agent.address.toLowerCase();
      const assignmentsUrl = `${this.baseUrl}/graphene/state/platform/assignments?sentryId=${sentryAddress}`;
      let assignments;
      try {
        assignments = await this.fetchJson(assignmentsUrl);
      } catch (error) { throw new Error(`Cannot verify sentry assignments: ${error.message}`); }

      if (!Array.isArray(assignments)) throw new Error('Invalid sentry assignment response');
      this.lastVerifiedTime = Date.now();

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
          if (!existing.errorType && existing.encryptedConnectionString === assignment.encryptedConnectionString && this.tunnelManager.get?.(assignment.validator)) {
            try { await this.tunnelManager.ensurePeer?.(this.tunnelManager.get(assignment.validator)); }
            catch (error) { logger.warn(`Peer not connected yet: ${error.message}`); }
            continue;
          }
        }

        logger.info(`New/updated assignment detected: ${id}, validator: ${assignment.validator}`);

        try {
          const validatorsUrl = `${this.baseUrl}/graphene/state/platform/validators/${assignment.validator}`;
          let validator;
          try {
            validator = await this.fetchJson(validatorsUrl);
          } catch (err) {
            const errorType = classifyError(err.message || String(err));
            if (errorType === 'transient') {
              logger.warn(`Transient error fetching validator ${assignment.validator}: ${err.message}`);
              continue;
            }
            logger.warn(`Validator ${assignment.validator} not found on chain`);
            continue;
          }

          if (!validator) {
            logger.warn(`Validator ${assignment.validator} data is null`);
            continue;
          }

          const validatorPeer = {
            agentAddress: validator.agentAddress,
            nodeId: validator.nodeId || validator.p2pNodeId || validator.id,
            host: validator.host || validator.publicEndpoint,
            port: validator.p2pPort,
          };

          await this.tunnelManager.connect(
            assignment.validator,
            assignment.encryptedConnectionString,
            validatorPeer,
          );

          this.processedAssignments.set(id, {
            encryptedConnectionString: assignment.encryptedConnectionString,
            validatorId: assignment.validator,
          });
          this._saveProcessedAssignments();

          logger.info(`Assignment ${id} processed successfully`);
        } catch (err) {
          const errorType = classifyError(err.message || String(err));
          if (errorType === 'transient') {
            logger.warn(`Transient error processing assignment ${id}, will retry: ${err.message}`);
            const existing = this.processedAssignments.get(id) || {};
            this.processedAssignments.set(id, {
              ...existing,
              encryptedConnectionString: assignment.encryptedConnectionString,
              validatorId: assignment.validator,
              lastError: err.message,
              errorType: 'TRANSIENT',
            });
            this._saveProcessedAssignments();
          } else {
            logger.error(`Failed to process assignment ${id}: ${err.message}`);
            this.processedAssignments.set(id, {
              encryptedConnectionString: assignment.encryptedConnectionString,
              validatorId: assignment.validator,
              lastError: err.message,
              errorType: 'PERMANENT',
            });
            this._saveProcessedAssignments();
          }
        }
      }

      await this._handleDisconnectedValidators(assignments);
      success = true;
    } catch (err) {
      logger.error(`Monitor poll error: ${err.message}`);
      if (Date.now() - this.lastVerifiedTime > Math.max(30000, 2 * this.pollInterval)) {
        await this.tunnelManager.disconnectAll();
        this.processedAssignments.clear();
        this._saveProcessedAssignments();
      }
    } finally {
      this.polling = false;
      this.lastPollSuccess = success;
      this.lastPollTime = Date.now();
      this.degraded = !success;
    }
  }

  async _handleRevoke(assignmentId, assignment) {
    if (!this.processedAssignments.has(assignmentId)) return;

    logger.info(`Revocation detected for assignment ${assignmentId}`);

    try {
      await this.tunnelManager.disconnect(assignment.validator);
      this.processedAssignments.delete(assignmentId);
      this._saveProcessedAssignments();
      logger.info(`Cleaned up assignment ${assignmentId}`);
    } catch (err) {
      logger.error(`Failed to clean up revoked assignment ${assignmentId}: ${err.message}`);
    }
  }

  async _handleDisconnectedValidators(activeAssignments) {
    const activeValidatorIds = new Set(
      activeAssignments
        .filter(a => a.status === 'ACTIVE' || a.status === 'Active')
        .map(a => a.validator),
    );

    for (const [assignmentId, info] of this.processedAssignments) {
      if (!activeValidatorIds.has(info.validatorId)) {
        logger.info(`Validator ${info.validatorId} no longer has active assignment`);
        await this.tunnelManager.disconnect(info.validatorId);
        this.processedAssignments.delete(assignmentId);
        this._saveProcessedAssignments();
      }
    }
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
      let connections = [];
      try { connections = await this.tunnelManager.connectionStatus(); }
      catch { /* A listening proxy alone is not proof of a peer connection. */ }
      const allTunnelsConnected = connections.length > 0 && connections.every((entry) => entry.peerConnected);

      const ready = this.lastPollSuccess
        && (Date.now() - this.lastPollTime) <= (2 * pollIntervalMs)
        && allTunnelsConnected
        && !this.degraded;

      return {
        ready,
        details: {
          updates: this.config.updateStatus?.() || { enabled: false },
          lastPollSuccess: this.lastPollSuccess,
          lastPollTime: this.lastPollTime ? new Date(this.lastPollTime).toISOString() : null,
          degraded: this.degraded,
          allTunnelsConnected,
          connections,
          processedCount: this.processedAssignments.size,
          activeTunnels: this.tunnelManager.clients.size,
          errors: Object.fromEntries(
            [...this.processedAssignments].filter(([, v]) => v.errorType).map(([k, v]) => [k, { lastError: v.lastError, errorType: v.errorType }]),
          ),
        },
      };
    });
  }

  async start() {
    this.running = true;
    logger.info('Assignment monitor started');
    logger.info(`Poll interval: ${this.pollInterval}ms`);
    logger.info(`Monitoring assignments for sentry: ${this.secrets.agent.address}`);

    this._startHealthServer();

    await this._recoverTunnels();

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
    if (this._healthServer) {
      this._healthServer.close();
      this._healthServer = null;
    }
    logger.info('Assignment monitor stopped');
  }
}

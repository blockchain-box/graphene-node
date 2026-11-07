#!/usr/bin/env node

import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import readline from 'readline';
import { generateAll } from './keygen.js';
import { saveKeystore, loadKeystore } from './keystore.js';
import {
  startGrphServer,
  startTendermint,
  stopGrphServer,
  stopTendermint,
  getGrphServerInfo,
  getGrphServerState,
  isTendermintRunning,
} from './server.js';
import { ApprovalMonitor } from './monitor.js';
import { logger } from './utils.js';
import { startAgentUpdates } from '../../lib/update-worker.js';

// A launcher-owned agent exits when its parent closes, including an abrupt launcher exit.
if (process.send) process.once('disconnect', () => process.kill(process.pid, 'SIGTERM'));

const program = new Command();

function defaultKeystorePath() {
  if (process.env.KEYSTORE_PATH) return process.env.KEYSTORE_PATH;
  if (fs.existsSync('/app/secrets')) return '/app/secrets/keystore.enc';
  return './secrets/keystore.enc';
}

function resolveConfig() {
  return {
    rpcUrl: process.env.RPC_URL || 'http://app-evm-validator:3003/graphene-evm/rpc',
    wsUrl: process.env.WS_URL || null,
    keystorePath: defaultKeystorePath(),
    keystorePassphraseEnv: process.env.KEYSTORE_PASSPHRASE || null,
    contractAddress: process.env.CONTRACT_ADDRESS || '',
    agentHost: process.env.AGENT_HOST || '127.0.0.1',
    agentPort: process.env.AGENT_PORT || '26656',
    manageTendermint: process.env.MANAGE_TENDERMINT !== 'false',
    managePeers: process.env.MANAGE_PEERS !== 'false',
    agentProtocol: process.env.AGENT_PROTOCOL || 'tcp',
    tendermintHome: process.env.TENDERMINT_HOME || '/tendermint',
    proxyApp: process.env.PROXY_APP || 'tcp://app-abci-validator:26658',
    moniker: process.env.P2P_NODE_NAME || 'graphene-validator',
    p2pSeeds: process.env.P2P_SEEDS || '',
    p2pPersistentPeers: process.env.P2P_PERSISTENT_PEERS || '',
    p2pPrivatePeerIds: process.env.P2P_PRIVATE_PEER_IDS || '',
    p2pPex: process.env.P2P_PEX || 'false',
    pollIntervalMs: process.env.POLL_INTERVAL_MS || '15000',
  };
}

async function promptPassphrase(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function getPassphrase(config) {
  if (config.keystorePassphraseEnv) {
    return config.keystorePassphraseEnv;
  }
  return promptPassphrase('Enter keystore passphrase: ');
}

async function promptStderr(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function getPassphraseStderr(config) {
  if (config.keystorePassphraseEnv) {
    return config.keystorePassphraseEnv;
  }
  return promptStderr('Enter keystore passphrase: ');
}

function buildJsonPayload(secrets, moniker, stakeAmount, full) {
  if (full) {
    return {
      agentAddress: secrets.agent.address,
      nodeId: secrets.tendermint.node.nodeId,
      networkPublicKey: secrets.tendermint.validator.publicKey.value,
      encryptionPublicKey: secrets.x25519.publicKey,
      moniker,
      stakeAmount,
      grphInviteKey: secrets.grph.invite,
      grphPublicKey: secrets.grph.keyPair.publicKey,
      validatorAddress: secrets.tendermint.validator.address,
    };
  }
  return {
    grphInviteKey: secrets.grph.invite,
    grphDhtPublicKey: secrets.grph.keyPair.publicKey,
    tendermintValidatorPublicKey: secrets.tendermint.validator.publicKey.value,
    agentAddress: secrets.agent.address,
    x25519PublicKey: secrets.x25519.publicKey,
    tendermintValidatorAddress: secrets.tendermint.validator.address,
    tendermintNodeId: secrets.tendermint.node.nodeId,
    moniker,
  };
}

function validateMoniker(moniker) {
  if (!moniker) return false;
  return moniker.length >= 1 && moniker.length <= 64;
}

function validateStakeAmount(stakeAmount) {
  const parsed = parseFloat(stakeAmount);
  return !isNaN(parsed) && parsed > 0;
}

program
  .name('validator-agent')
  .description('Graphene Validator Agent — sidecar for validator nodes')
  .version('1.0.0');

program
  .command('init')
  .description('Generate all keys and save to encrypted keystore')
  .option('--json', 'Output machine-readable JSON payload to stdout')
  .option('--full', 'Include all 9 registration fields (use with --json)')
  .action(async (options) => {
    const config = resolveConfig();

    if (!options.json) {
      logger.info('Generating validator keys...');
      logger.info('Tip: use --json for machine-readable output');

      try {
        const secrets = generateAll();

        const passphrase1 = await getPassphrase(config);
        const passphrase2 = config.keystorePassphraseEnv
          ? passphrase1
          : await promptPassphrase('Confirm keystore passphrase: ');

        if (passphrase1 !== passphrase2) {
          logger.error('Passphrases do not match');
          process.exit(1);
        }

        saveKeystore(secrets, passphrase1, config.keystorePath);

        logger.info('=== Keys Generated ===');
        logger.info(`Grph invite key: ${secrets.grph.invite}`);
        logger.info(`Grph DHT public key: ${secrets.grph.keyPair.publicKey}`);
        logger.info(`Agent Ethereum address: ${secrets.agent.address}`);
        logger.info(`X25519 public key: ${secrets.x25519.publicKey}`);
        logger.info(`Tendermint validator address: ${secrets.tendermint.validator.address}`);
        logger.info(`Tendermint node ID: ${secrets.tendermint.node.nodeId}`);
        logger.info('========================');
        logger.info('Keystore saved. Keep your passphrase safe.');
      } catch (err) {
        logger.error(`Init failed: ${err.message}`);
        process.exit(1);
      }
      return;
    }

    try {
      let lineResolve = null;
      const lineQueue = [];
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
      });

      rl.on('line', (line) => {
        if (lineResolve) {
          const cb = lineResolve;
          lineResolve = null;
          cb(line.trim());
        } else {
          lineQueue.push(line.trim());
        }
      });

      const question = (prompt) => {
        process.stderr.write(prompt);
        return new Promise((resolve) => {
          if (lineQueue.length > 0) {
            resolve(lineQueue.shift());
          } else {
            lineResolve = resolve;
          }
        });
      };

      const moniker = await question('Enter moniker (1-64 chars): ');
      if (!validateMoniker(moniker)) {
        process.stderr.write('Error: moniker must be 1-64 characters\n');
        rl.close();
        process.exit(1);
      }

      const stakeAmount = await question('Enter stake amount (positive decimal): ');
      if (!validateStakeAmount(stakeAmount)) {
        process.stderr.write('Error: stakeAmount must be a positive decimal\n');
        rl.close();
        process.exit(1);
      }

      const secrets = generateAll();

      let passphrase1;
      if (config.keystorePassphraseEnv) {
        passphrase1 = config.keystorePassphraseEnv;
      } else {
        passphrase1 = await question('Enter keystore passphrase: ');
      }

      let passphrase2;
      if (config.keystorePassphraseEnv) {
        passphrase2 = passphrase1;
      } else {
        passphrase2 = await question('Confirm keystore passphrase: ');
      }

      rl.close();

      if (passphrase1 !== passphrase2) {
        process.stderr.write('Error: passphrases do not match\n');
        process.exit(1);
      }

      saveKeystore(secrets, passphrase1, config.keystorePath, true);

      const full = options.full === true;
      const payload = buildJsonPayload(secrets, moniker, stakeAmount, full);
      process.stdout.write(JSON.stringify(payload) + '\n');

      process.stderr.write('\nValidator keys generated. JSON payload written to stdout.\n');
      process.stderr.write('Copy the JSON above and paste it into the form\'s "Import" step.\n');
    } catch (err) {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exit(1);
    }
  });

program
  .command('export')
  .description('Load keystore and re-output JSON payload')
  .option('--json', 'Output machine-readable JSON payload to stdout')
  .option('--full', 'Include all 9 registration fields (use with --json)')
  .action(async (options) => {
    if (!options.json) {
      process.stderr.write('Error: --json flag is required\n');
      process.stderr.write('Usage: validator-agent export --json\n');
      process.exit(1);
    }

    const config = resolveConfig();

    try {
      let lineResolve = null;
      const lineQueue = [];
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
      });

      rl.on('line', (line) => {
        if (lineResolve) {
          const cb = lineResolve;
          lineResolve = null;
          cb(line.trim());
        } else {
          lineQueue.push(line.trim());
        }
      });

      const question = (prompt) => {
        process.stderr.write(prompt);
        return new Promise((resolve) => {
          if (lineQueue.length > 0) {
            resolve(lineQueue.shift());
          } else {
            lineResolve = resolve;
          }
        });
      };

      let passphrase;
      if (config.keystorePassphraseEnv) {
        passphrase = config.keystorePassphraseEnv;
      } else {
        passphrase = await question('Enter keystore passphrase: ');
      }

      const secrets = loadKeystore(config.keystorePath, passphrase);

      const moniker = await question('Enter moniker (1-64 chars): ');
      if (!validateMoniker(moniker)) {
        process.stderr.write('Error: moniker must be 1-64 characters\n');
        rl.close();
        process.exit(1);
      }

      const stakeAmount = await question('Enter stake amount (positive decimal): ');
      if (!validateStakeAmount(stakeAmount)) {
        process.stderr.write('Error: stakeAmount must be a positive decimal\n');
        rl.close();
        process.exit(1);
      }

      rl.close();

      const full = options.full === true;
      const payload = buildJsonPayload(secrets, moniker, stakeAmount, full);
      process.stdout.write(JSON.stringify(payload) + '\n');
    } catch (err) {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exit(1);
    }
  });

program
  .command('connect')
  .description('Start GrphServer and Tendermint')
  .action(async () => {
    const config = resolveConfig();
    logger.info('Starting validator agent...');
    const updates = await startAgentUpdates({ role: 'validator', log: message => logger.warn(message) });
    config.updateStatus = () => updates.status?.() || { enabled: false, error: updates.error };

    try {
      const passphrase = await getPassphrase(config);
      const secrets = loadKeystore(config.keystorePath, passphrase);
      logger.info('Keystore loaded successfully');

      logger.info(`Contract address: ${config.contractAddress}`);
      logger.info(`RPC URL: ${config.rpcUrl}`);

      await startGrphServer(config, secrets);
      logger.info('GrphServer started');

      if (config.manageTendermint) {
        startTendermint(config, secrets);
        logger.info('Tendermint started');
      }

      const monitor = new ApprovalMonitor(config, secrets);
      await monitor.start();

      const shutdown = async () => {
        logger.info('Shutting down...');
        monitor.stop();
        await updates.close();
        stopTendermint();
        await stopGrphServer();
        logger.info('Validator agent stopped');
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      logger.info('Validator agent running. Press Ctrl+C to stop.');
    } catch (err) {
      logger.error(`Connect failed: ${err.message}`);
      await updates.close();
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show tunnel status and assignments')
  .action(async () => {
    const serverInfo = getGrphServerInfo();
    const serverState = getGrphServerState();
    const tmRunning = isTendermintRunning();

    console.log('=== Validator Agent Status ===');
    console.log(`GrphServer: ${serverState}`);
    if (serverInfo) {
      console.log(`  Public key: ${serverInfo.publicKey}`);
      console.log(`  Host: ${serverInfo.host}`);
      console.log(`  Port: ${serverInfo.port}`);
      console.log(`  Protocol: ${serverInfo.protocol}`);
      console.log(`  Secure: ${serverInfo.secure}`);
    }
    console.log(`Tendermint: ${tmRunning ? 'running' : 'stopped'}`);
    console.log('==============================');
  });

program
  .command('disconnect')
  .description('Stop GrphServer and Tendermint')
  .action(async () => {
    logger.info('Disconnecting...');
    stopTendermint();
    await stopGrphServer();
    logger.info('Disconnected');
  });

program
  .command('logs')
  .description('View agent logs')
  .option('-f, --follow', 'Follow log output')
  .option('-n, --lines <number>', 'Number of recent lines to show', '50')
  .action(async (options) => {
    const logFile = '/app/logs/agent.log';
    if (!fs.existsSync(logFile)) {
      console.log('No logs found');
      return;
    }

    const lines = parseInt(options.lines, 10);
    const content = fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean);
    const recent = content.slice(-lines);
    console.log(recent.join('\n'));

    if (options.follow) {
      const watcher = fs.watchFile(logFile, { interval: 1000 }, () => {
        const updated = fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean);
        const newLines = updated.slice(content.length);
        newLines.forEach((l) => console.log(l));
      });
      process.on('SIGINT', () => {
        watcher.unref();
        process.exit(0);
      });
    }
  });

program
  .command('upgrade')
  .description('Upgrade the validator agent')
  .action(async () => {
    logger.info('Checking for agent updates...');
    logger.info('Upgrade triggered. Stopping agent...');
    stopTendermint();
    await stopGrphServer();
    logger.info('Agent stopped. Upgrading...');
    logger.info('Pull the latest image and redeploy to complete the upgrade.');
    logger.info('Run: docker compose pull validator-agent && docker compose up -d validator-agent');
  });

if (!process.env.VITEST && !process.env.VITEST_WORKER_ID) {
  program.parse(process.argv);
}

export { buildJsonPayload, validateMoniker, validateStakeAmount };

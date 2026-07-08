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

const program = new Command();

function defaultKeystorePath() {
  if (process.env.KEYSTORE_PATH) return process.env.KEYSTORE_PATH;
  if (fs.existsSync('/app/secrets')) return '/app/secrets/keystore.enc';
  return './secrets/keystore.enc';
}

function resolveConfig() {
  return {
    rpcUrl: process.env.RPC_URL || 'http://app-evm-validator:3003',
    wsUrl: process.env.WS_URL || null,
    keystorePath: defaultKeystorePath(),
    keystorePassphraseEnv: process.env.KEYSTORE_PASSPHRASE || null,
    contractAddress: process.env.CONTRACT_ADDRESS || '',
    agentHost: process.env.AGENT_HOST || '127.0.0.1',
    agentPort: process.env.AGENT_PORT || '26658',
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

program
  .name('validator-agent')
  .description('Graphene Validator Agent — sidecar for validator nodes')
  .version('1.0.0');

program
  .command('init')
  .description('Generate all keys and save to encrypted keystore')
  .action(async () => {
    const config = resolveConfig();
    logger.info('Generating validator keys...');

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
  });

program
  .command('connect')
  .description('Start GrphServer and Tendermint')
  .action(async () => {
    const config = resolveConfig();
    logger.info('Starting validator agent...');

    try {
      const passphrase = await getPassphrase(config);
      const secrets = loadKeystore(config.keystorePath, passphrase);
      logger.info('Keystore loaded successfully');

      logger.info(`Contract address: ${config.contractAddress}`);
      logger.info(`RPC URL: ${config.rpcUrl}`);

      await startGrphServer(config, secrets);
      logger.info('GrphServer started');

      startTendermint(config, secrets);
      logger.info('Tendermint started');

      const monitor = new ApprovalMonitor(config, secrets);
      await monitor.start();

      const shutdown = async () => {
        logger.info('Shutting down...');
        monitor.stop();
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

program.parse(process.argv);

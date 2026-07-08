#!/usr/bin/env node

import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import readline from 'readline';
import nacl from 'tweetnacl';
import { generate } from '@grph-net/utils';
import { randomBytes, toHex, logger } from './utils.js';
import { PortAllocator } from './port-allocator.js';
import { TunnelManager } from './tunnel-manager.js';
import { AssignmentMonitor } from './monitor.js';

const program = new Command();

function defaultSecretsPath() {
  if (process.env.SECRETS_PATH) return process.env.SECRETS_PATH;
  if (fs.existsSync('/app/secrets')) return '/app/secrets/sentry-secrets.json';
  return './secrets/sentry-secrets.json';
}

function resolveConfig() {
  return {
    rpcUrl: process.env.RPC_URL || 'http://app-evm-sentry:3003',
    wsUrl: process.env.WS_URL || null,
    secretsPath: defaultSecretsPath(),
    portRangeStart: parseInt(process.env.PORT_RANGE_START || '40001', 10),
    portRangeEnd: parseInt(process.env.PORT_RANGE_END || '40999', 10),
    tendermintConfigPath: process.env.TENDERMINT_CONFIG_PATH || '/tendermint/config/config.toml',
    tendermintContainer: process.env.TENDERMINT_CONTAINER || 'sentry-node',
    dockerSocket: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
    statePath: process.env.STATE_PATH || '/app/state',
    pollIntervalMs: process.env.POLL_INTERVAL_MS || '15000',
    logPath: process.env.LOG_PATH || '/app/logs/sentry-agent.log',
  };
}

async function loadSecrets(config) {
  if (!fs.existsSync(config.secretsPath)) {
    throw new Error(`Secrets file not found at ${config.secretsPath}. Run 'sentry-agent init' first.`);
  }
  const data = JSON.parse(fs.readFileSync(config.secretsPath, 'utf8'));
  return data;
}

program
  .name('sentry-agent')
  .description('Sentry agent sidecar — monitors assignments, manages GrphClient tunnels')
  .version('1.0.0');

program
  .command('init')
  .description('Generate sentry secrets (X25519 + Ethereum key)')
  .action(async () => {
    const config = resolveConfig();

    const x25519KeyPair = nacl.box.keyPair();
    const x25519 = {
      publicKey: Buffer.from(x25519KeyPair.publicKey).toString('hex'),
      secretKey: Buffer.from(x25519KeyPair.secretKey).toString('hex'),
    };

    const agentWallet = (await import('ethers')).ethers.Wallet.createRandom();
    const agent = {
      address: agentWallet.address,
      privateKey: agentWallet.privateKey,
    };

    const secrets = {
      x25519,
      agent,
    };

    const dir = path.dirname(config.secretsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    fs.writeFileSync(config.secretsPath, JSON.stringify(secrets, null, 2));
    fs.chmodSync(config.secretsPath, 0o600);

    console.log('Sentry secrets generated:');
    console.log(`  X25519 public key: ${x25519.publicKey}`);
    console.log(`  Agent address:     ${agent.address}`);
    console.log(`  Secrets saved to:  ${config.secretsPath}`);
  });

program
  .command('start')
  .description('Start monitoring for assignments')
  .action(async () => {
    const config = resolveConfig();

    const logDir = path.dirname(config.logPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    logger.init(config.logPath);

    logger.info('=== Sentry Agent Starting ===');
    logger.info(`RPC URL: ${config.rpcUrl}`);
    logger.info(`Tendermint container: ${config.tendermintContainer}`);

    let secrets;
    try {
      secrets = await loadSecrets(config);
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }

    const stateDir = config.statePath;
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    }

    const portAllocator = new PortAllocator(
      config.portRangeStart,
      config.portRangeEnd,
      path.join(stateDir, 'port-map.json'),
    );

    const tunnelManager = new TunnelManager(
      { ...config, statePath: path.join(stateDir, 'tunnels.json') },
      secrets,
      portAllocator,
    );

    const monitor = new AssignmentMonitor(config, secrets, tunnelManager);

    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down...');
      monitor.stop();
      await tunnelManager.disconnectAll();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down...');
      monitor.stop();
      await tunnelManager.disconnectAll();
      process.exit(0);
    });

    await monitor.start();
  });

program
  .command('reload')
  .description('Reload configuration without restarting')
  .action(() => {
    logger.info('Reload command received — restart agent to apply new config');
  });

program
  .command('sync')
  .description('Force sync with contract state')
  .action(async () => {
    const config = resolveConfig();

    let secrets;
    try {
      secrets = await loadSecrets(config);
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }

    const stateDir = config.statePath;
    const portAllocator = new PortAllocator(
      config.portRangeStart,
      config.portRangeEnd,
      path.join(stateDir, 'port-map.json'),
    );

    const tunnelManager = new TunnelManager(
      { ...config, statePath: path.join(stateDir, 'tunnels.json') },
      secrets,
      portAllocator,
    );

    const monitor = new AssignmentMonitor(config, secrets, tunnelManager);
    logger.info('Running force sync...');
    await monitor.checkAssignments();
    logger.info('Sync complete');
  });

program
  .command('status')
  .description('Show tunnels, validators, and ports')
  .action(async () => {
    const config = resolveConfig();

    console.log('=== Sentry Agent Status ===');
    console.log(`RPC URL:       ${config.rpcUrl}`);
    console.log(`Config path:   ${config.tendermintConfigPath}`);
    console.log(`Container:     ${config.tendermintContainer}`);
    console.log(`Port range:    ${config.portRangeStart}-${config.portRangeEnd}`);

    const stateDir = config.statePath;
    const portMapPath = path.join(stateDir, 'port-map.json');
    const tunnelsPath = path.join(stateDir, 'tunnels.json');

    console.log('\n--- Port Allocations ---');
    if (fs.existsSync(portMapPath)) {
      const portMap = JSON.parse(fs.readFileSync(portMapPath, 'utf8'));
      if (Object.keys(portMap).length === 0) {
        console.log('  (none)');
      } else {
        for (const [validatorId, port] of Object.entries(portMap)) {
          console.log(`  ${validatorId} → 127.0.0.1:${port}`);
        }
      }
    } else {
      console.log('  (no port-map.json)');
    }

    console.log('\n--- Active Tunnels ---');
    if (fs.existsSync(tunnelsPath)) {
      const tunnels = JSON.parse(fs.readFileSync(tunnelsPath, 'utf8'));
      if (Object.keys(tunnels).length === 0) {
        console.log('  (none)');
      } else {
        for (const [validatorId, entry] of Object.entries(tunnels)) {
          const peerStr = entry.peer
            ? `${entry.peer.nodeId || '?'}@127.0.0.1:${entry.port}`
            : `127.0.0.1:${entry.port}`;
          console.log(`  ${validatorId} → ${peerStr}`);
        }
      }
    } else {
      console.log('  (no tunnels.json)');
    }

    try {
      const secrets = await loadSecrets(config);
      console.log(`\n--- Identity ---`);
      console.log(`  Sentry address: ${secrets.agent.address}`);
      console.log(`  X25519 pubkey:  ${secrets.x25519.publicKey}`);
    } catch {
      console.log('\n--- Identity ---');
      console.log('  (secrets not loaded)');
    }
  });

program
  .command('logs')
  .description('View agent logs')
  .option('-f, --follow', 'Follow log output')
  .option('-n, --lines <n>', 'Number of lines to show', '50')
  .action(async (options) => {
    const config = resolveConfig();
    const logPath = config.logPath;

    if (!fs.existsSync(logPath)) {
      console.log('No log file found');
      return;
    }

    if (options.follow) {
      console.log(`Following ${logPath} (Ctrl+C to stop)...`);
      const { spawn } = await import('child_process');
      const tail = spawn('tail', ['-n', options.lines, '-f', logPath], {
        stdio: 'inherit',
      });
      tail.on('error', (err) => {
        console.error(`Failed to tail log: ${err.message}`);
      });
    } else {
      const content = fs.readFileSync(logPath, 'utf8');
      const lines = content.split('\n').slice(-parseInt(options.lines, 10));
      console.log(lines.join('\n'));
    }
  });

program.parse(process.argv);

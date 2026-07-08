import { GrphServer } from '@grph-net/server';
import { logger } from './utils.js';
import { spawn } from 'child_process';

let serverInstance = null;
let tendermintProcess = null;

export async function startGrphServer(config, secrets) {
  if (serverInstance) {
    logger.warn('GrphServer already running');
    return serverInstance;
  }

  serverInstance = new GrphServer({
    silent: false,
  });

  serverInstance.logger = {
    log: (entry) => {
      logger.info(`[GrphServer] ${entry.msg}`);
    },
  };

  await serverInstance.start({
    seed: secrets.grph.seed,
    host: config.agentHost || '127.0.0.1',
    port: parseInt(config.agentPort || '26658', 10),
    udp: config.agentProtocol === 'udp',
  });

  logger.info(`GrphServer started, public key: ${serverInstance.info.publicKey}`);
  return serverInstance;
}

export function startTendermint(config, secrets) {
  if (tendermintProcess) {
    logger.warn('Tendermint already running');
    return tendermintProcess;
  }

  const tmHome = config.tendermintHome || '/tendermint';
  const proxyApp = config.proxyApp || 'tcp://app-abci-validator:26658';
  const moniker = config.moniker || 'graphene-validator';

  const args = [
    'start',
    '--home', tmHome,
    '--proxy_app', proxyApp,
    '--moniker', moniker,
  ];

  if (config.p2pSeeds) {
    args.push('--p2p.seeds', config.p2pSeeds);
  }
  if (config.p2pPersistentPeers) {
    args.push('--p2p.persistent_peers', config.p2pPersistentPeers);
  }
  if (config.p2pPrivatePeerIds) {
    args.push('--p2p.private_peer_ids', config.p2pPrivatePeerIds);
  }
  if (config.p2pPex === 'false') {
    args.push('--p2p.pex=false');
  }

  logger.info(`Starting Tendermint: tendermint ${args.join(' ')}`);

  tendermintProcess = spawn('tendermint', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TMHOME: tmHome },
  });

  tendermintProcess.stdout.on('data', (data) => {
    logger.info(`[Tendermint] ${data.toString().trim()}`);
  });

  tendermintProcess.stderr.on('data', (data) => {
    logger.warn(`[Tendermint] ${data.toString().trim()}`);
  });

  tendermintProcess.on('close', (code) => {
    logger.info(`Tendermint exited with code ${code}`);
    tendermintProcess = null;
  });

  tendermintProcess.on('error', (err) => {
    logger.error(`Tendermint error: ${err.message}`);
    tendermintProcess = null;
  });

  return tendermintProcess;
}

export async function stopGrphServer() {
  if (serverInstance) {
    try {
      await serverInstance.destroy();
      logger.info('GrphServer destroyed');
    } catch (err) {
      logger.error(`Error destroying GrphServer: ${err.message}`);
    }
    serverInstance = null;
  }
}

export function stopTendermint() {
  if (tendermintProcess) {
    tendermintProcess.kill('SIGTERM');
    logger.info('Sent SIGTERM to Tendermint');
    setTimeout(() => {
      if (tendermintProcess) {
        tendermintProcess.kill('SIGKILL');
        logger.info('Sent SIGKILL to Tendermint');
      }
    }, 10000);
  }
}

export function getGrphServerInfo() {
  if (!serverInstance) return null;
  return serverInstance.info;
}

export function getGrphServerState() {
  return serverInstance ? serverInstance.state : 'stopped';
}

export function isTendermintRunning() {
  return tendermintProcess !== null && !tendermintProcess.killed;
}

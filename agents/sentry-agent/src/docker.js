import Docker from 'dockerode';
import { logger } from './utils.js';

let docker = null;

export function getDocker() {
  if (!docker) {
    const socketPath = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
    docker = new Docker({ socketPath });
  }
  return docker;
}

export async function restartContainer(containerName) {
  logger.info(`Restarting container: ${containerName}`);
  try {
    const client = getDocker();
    const container = client.getContainer(containerName);
    await container.restart({ t: 10 });
    logger.info(`Container ${containerName} restarted successfully`);
    return true;
  } catch (err) {
    logger.error(`Failed to restart container ${containerName}: ${err.message}`);
    return false;
  }
}

import fs from 'fs';
import { logger } from './utils.js';

const PEER_REGEX = /^persistent_peers\s*=\s*"(.*)"$/m;

export function readPersistentPeers(configPath) {
  const content = fs.readFileSync(configPath, 'utf8');
  const match = content.match(PEER_REGEX);
  if (!match) return [];
  const raw = match[1].trim();
  if (!raw) return [];
  return raw.split(',').map(p => p.trim()).filter(Boolean);
}

export function addPeer(configPath, nodeId, host, port) {
  const peer = `${nodeId}@${host}:${port}`;
  const content = fs.readFileSync(configPath, 'utf8');

  const peers = readPersistentPeers(configPath);
  if (peers.includes(peer)) {
    logger.debug(`Peer ${peer} already in persistent_peers`);
    return false;
  }

  const newPeers = [...peers, peer].join(',');
  let newContent;

  if (content.match(PEER_REGEX)) {
    newContent = content.replace(PEER_REGEX, `persistent_peers = "${newPeers}"`);
  } else {
    newContent = content.replace(
      /^(proxy_app\s*=.*)$/m,
      `$1\npersistent_peers = "${newPeers}"`,
    );
  }

  fs.writeFileSync(configPath, newContent);
  logger.info(`Added peer ${peer} to persistent_peers`);
  return true;
}

export function removePeer(configPath, nodeId, host, port) {
  const peer = `${nodeId}@${host}:${port}`;
  const content = fs.readFileSync(configPath, 'utf8');

  const peers = readPersistentPeers(configPath);
  const newPeers = peers.filter(p => p !== peer);

  if (newPeers.length === peers.length) {
    logger.debug(`Peer ${peer} not in persistent_peers`);
    return false;
  }

  const newContent = content.replace(PEER_REGEX, `persistent_peers = "${newPeers.join(',')}"`);
  fs.writeFileSync(configPath, newContent);
  logger.info(`Removed peer ${peer} from persistent_peers`);
  return true;
}

export function formatPeer(peer) {
  if (typeof peer === 'string') return peer;
  return `${peer.nodeId}@${peer.host || '127.0.0.1'}:${peer.port || ''}`;
}

export function renderPeers(assignments) {
  return assignments
    .map(a => a.peer)
    .filter(Boolean)
    .map(p => formatPeer(p))
    .join(',');
}

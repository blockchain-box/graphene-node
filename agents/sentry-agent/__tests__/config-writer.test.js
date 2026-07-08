import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  readPersistentPeers,
  addPeer,
  removePeer,
  renderPeers,
} from '../src/config-writer.js';

describe('Config Writer', () => {
  let tmpDir;
  let configPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-writer-test-'));
    configPath = path.join(tmpDir, 'config.toml');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(persistentPeers) {
    const content = [
      'proxy_app = "tcp://app-abci:26658"',
      'moniker = "sentry-node"',
      persistentPeers ? `persistent_peers = "${persistentPeers}"` : null,
      'p2p.pex = false',
    ].filter(Boolean).join('\n') + '\n';
    fs.writeFileSync(configPath, content);
  }

  it('reads empty persistent_peers', () => {
    writeConfig('');
    expect(readPersistentPeers(configPath)).toEqual([]);
  });

  it('reads existing persistent_peers', () => {
    writeConfig('node1@10.0.0.1:26656,node2@10.0.0.2:26656');
    const peers = readPersistentPeers(configPath);
    expect(peers).toEqual(['node1@10.0.0.1:26656', 'node2@10.0.0.2:26656']);
  });

  it('adds a peer to empty list', () => {
    writeConfig('');
    const changed = addPeer(configPath, 'abc123', '127.0.0.1', 40001);
    expect(changed).toBe(true);

    const peers = readPersistentPeers(configPath);
    expect(peers).toContain('abc123@127.0.0.1:40001');
  });

  it('adds a peer to existing list', () => {
    writeConfig('node1@10.0.0.1:26656');
    addPeer(configPath, 'abc123', '127.0.0.1', 40001);

    const peers = readPersistentPeers(configPath);
    expect(peers).toHaveLength(2);
    expect(peers).toContain('node1@10.0.0.1:26656');
    expect(peers).toContain('abc123@127.0.0.1:40001');
  });

  it('does not add duplicate peer', () => {
    writeConfig('abc123@127.0.0.1:40001');
    const changed = addPeer(configPath, 'abc123', '127.0.0.1', 40001);
    expect(changed).toBe(false);

    const peers = readPersistentPeers(configPath);
    expect(peers).toHaveLength(1);
  });

  it('removes a peer', () => {
    writeConfig('node1@10.0.0.1:26656,abc123@127.0.0.1:40001');
    const changed = removePeer(configPath, 'abc123', '127.0.0.1', 40001);
    expect(changed).toBe(true);

    const peers = readPersistentPeers(configPath);
    expect(peers).toEqual(['node1@10.0.0.1:26656']);
  });

  it('remove returns false for non-existent peer', () => {
    writeConfig('node1@10.0.0.1:26656');
    const changed = removePeer(configPath, 'unknown', '127.0.0.1', 99999);
    expect(changed).toBe(false);
  });

  it('renderPeers joins peers correctly', () => {
    const assignments = [
      { peer: { nodeId: 'n1', host: '10.0.0.1', port: 26656 } },
      { peer: null },
      { peer: { nodeId: 'n2', host: '10.0.0.2', port: 26656 } },
    ];
    expect(renderPeers(assignments)).toBe('n1@10.0.0.1:26656,n2@10.0.0.2:26656');
  });
});

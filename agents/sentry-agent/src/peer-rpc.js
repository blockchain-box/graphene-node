import dns from 'node:dns/promises';
import os from 'node:os';

export async function peerRpc(base, method, params = {}) {
  const response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'sentry-agent', method, params }), signal: AbortSignal.timeout(5000) });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(body.error?.message || 'Sentry node RPC unavailable');
  return body.result;
}
export async function dialPeer(config, nodeId, port) {
  if (!/^[0-9a-f]{40}$/i.test(nodeId) || !Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-zA-Z0-9.-]+$/.test(config.peerHost || '127.0.0.1')) throw new Error('Invalid validator peer identity or tunnel endpoint');
  const host = config.peerHost || '127.0.0.1';
  await peerRpc(config.tendermintRpcUrl, 'dial_peers', { peers: [`${nodeId}@${host}:${port}`], persistent: false, unconditional: false, private: true });
}
export async function peerConnections(config, clients) {
  const { peers = [] } = await peerRpc(config.tendermintRpcUrl, 'net_info');
  const host = config.peerHost || '127.0.0.1';
  const addresses = new Set((await dns.lookup(host, { all: true })).map((entry) => entry.address));
  // Docker can resolve the same multi-network container to a different local
  // interface after restart. All interfaces bound by this proxy are valid.
  if (config.proxyHost === '0.0.0.0') {
    for (const entries of Object.values(os.networkInterfaces())) for (const entry of entries || []) if (!entry.internal) addresses.add(entry.address);
  }
  return [...clients].map(([validator, entry]) => ({ validator, transport: entry.transport || 'dht', nodeId: entry.peer?.nodeId, proxyListening: entry.client.state === 'listening', peerConnected: entry.client.state === 'listening' && peers.some((peer) => peer.node_info.id.toLowerCase() === entry.peer?.nodeId?.toLowerCase() && peer.is_outbound === true && addresses.has(peer.remote_ip)) }));
}

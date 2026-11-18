import { publicJsonFromUrl } from "./invitation-api.js";
import { Hosts } from "./hosts.js";

export function healthState(health, checkedAt, now = Date.now()) {
  if (!health) return "unchecked";
  if (now - Date.parse(checkedAt) > 60000) return "stale";
  const age = (now - Date.parse(health.blockTime)) / 1000;
  if (
    !Number.isFinite(age) ||
    age > 120 ||
    age < -30 ||
    !/^\d+$/.test(String(health.height)) ||
    BigInt(health.height) === 0n ||
    health.catchingUp ||
    health.primaryConnected === false
  )
    return "attention";
  return "healthy";
}

export async function networkHealth(
  nodes,
  id,
  { request = publicJsonFromUrl } = {},
) {
  const invite = nodes.network(id);
  const checkedAt = new Date().toISOString();
  const checks = [];
  for (const [label, route] of [
    ["Consensus", "/status"],
    ["EVM JSON-RPC", "/graphene-evm/rpc"],
    ["Public API", "/api/invitation"],
  ]) {
    const started = Date.now();
    let url;
    try {
      url = new URL(route, invite.rpc).href;
      const raw = JSON.parse(
        await request(
          url,
          route,
          route === "/graphene-evm/rpc"
            ? {
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "eth_chainId",
                  params: [],
                }),
              }
            : {},
        ),
      );
      if (route === "/status") {
        const result = raw.result;
        if (result?.node_info?.network !== JSON.parse(invite.genesis).chain_id)
          throw new Error("Consensus reports a different network.");
        const health = {
          height: result.sync_info.latest_block_height,
          catchingUp: result.sync_info.catching_up,
          blockTime: result.sync_info.latest_block_time,
        };
        checks.push({
          label,
          url,
          status: healthState(health, checkedAt),
          ...health,
          latencyMs: Date.now() - started,
        });
      } else if (route === "/graphene-evm/rpc") {
        if (
          !/^0x[0-9a-f]+$/i.test(raw.result || "") ||
          BigInt(raw.result) !== BigInt(invite.network.chain_id)
        )
          throw new Error(
            "EVM RPC is unavailable or reports a different chain ID.",
          );
        checks.push({
          label,
          url,
          status: "healthy",
          latencyMs: Date.now() - started,
        });
      } else {
        if (
          raw.network?.network_id !== invite.network.network_id ||
          raw.genesis !== invite.genesis
        )
          throw new Error("Public API reports a different frozen network.");
        checks.push({
          label,
          url,
          status: "healthy",
          latencyMs: Date.now() - started,
        });
      }
    } catch (error) {
      checks.push({ label, url, status: "attention", message: error.message });
    }
  }
  const rows = [];
  // The console serializes Docker/SSH operations; retain a result for every node.
  for (const node of nodes.inventory().find((network) => network.id === id)
    ?.nodes || []) {
    const scope = nodes.selectNode(id, node.role, node.nodeId);
    const hosts = new Hosts(scope);
    const host = hosts.get(id, node.role);
    const row = {
      nodeId: node.nodeId,
      role: node.role,
      name: node.name,
      status: "not-installed",
    };
    try {
      const installed = host.kind === "cloud" ? host.installed : node.prepared;
      if (installed) {
        row.health =
          host.kind === "cloud"
            ? await hosts.call(id, node.role, "health")
            : await scope.operate(id, node.role, "health");
        row.checkedAt = new Date().toISOString();
        row.status = healthState(row.health, row.checkedAt);
      }
    } catch (error) {
      row.status = "attention";
      row.message = error.message;
      row.checkedAt = new Date().toISOString();
    }
    rows.push(row);
  }
  return { checkedAt, checks, nodes: rows };
}

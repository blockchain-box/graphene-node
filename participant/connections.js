// Public sentry and private validator connections for participant nodes.
import { isIPv4 } from "node:net";

export function hostname(value) {
  if (typeof value !== "string" || value.length > 253)
    throw new Error("Enter a public IPv4 address or DNS hostname.");
  const host = value.toLowerCase().replace(/\.$/, "");
  if (
    !isIPv4(host) &&
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      host,
    )
  )
    throw new Error("Enter a public IPv4 address or DNS hostname.");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  )
    throw new Error("Use a publicly reachable sentry address.");
  if (isIPv4(host)) {
    const [a, b] = host.split(".").map(Number);
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    )
      throw new Error("Use a publicly routable sentry address.");
  }
  return host;
}
export function peerAddress(value) {
  const match = /^([a-f0-9]{40})@([^:@\s/]+):(\d{1,5})$/.exec(value || "");
  if (!match || +match[3] < 1 || +match[3] > 65535)
    throw new Error("Use the sentry peer address: node-id@public-domain:port.");
  return match[1] + "@" + hostname(match[2]) + ":" + Number(match[3]);
}
export function directConnection(compose, peer, external) {
  delete compose.services["home-tunnel"];
  const node = compose.services.node;
  node.networks = ["backend", "egress"];
  node.command.push("--p2p.persistent_peers", peerAddress(peer));
  // Explicit peer allowlist; a validator never publishes a host port or discovers peers.
  delete node.ports;
  if (external) {
    node.command.push("--p2p.external-address", hostname(external) + ":26656");
    node.ports = ["26656:26656"];
  }
  return compose;
}

export function publicSentryConfig(config) {
  // Distinct authenticated nodes may share one NAT address. Node IDs, rather
  // than public IP uniqueness, identify peers on a participant-facing sentry.
  if (/^allow_duplicate_ip\s*=/m.test(config))
    return config.replace(/^allow_duplicate_ip\s*=.*$/m, "allow_duplicate_ip = true");
  if (/^\[p2p\]\s*$/m.test(config))
    return config.replace(/^\[p2p\]\s*$/m, "[p2p]\nallow_duplicate_ip = true");
  return config + "\n[p2p]\nallow_duplicate_ip = true\n";
}

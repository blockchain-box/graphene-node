import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { networkHealth, healthState } from "../participant/network-health.js";
import { Hosts } from "../participant/hosts.js";
import { CloudAccounts } from "../participant/cloud-accounts.js";

test("network health verifies frozen network and classifies fresh and stale consensus", async () => {
  const invite = {
    rpc: "https://api.example.org/graphene-evm/rpc",
    genesis: JSON.stringify({ chain_id: "graphene-dev-123" }),
    network: { network_id: "network", chain_id: 123 },
  };
  const nodes = { network: () => invite, inventory: () => [] };
  const request = async (url, route) => {
    assert.equal(new URL(url).origin, "https://api.example.org");
    return JSON.stringify(
      route === "/graphene-evm/rpc"
        ? { result: "0x7b" }
        : route === "/status"
          ? {
              result: {
                node_info: { network: "graphene-dev-123" },
                sync_info: {
                  latest_block_height: "1234",
                  catching_up: false,
                  latest_block_time: new Date().toISOString(),
                },
              },
            }
          : invite,
    );
  };
  const report = await networkHealth(nodes, "network", { request });
  assert.deepEqual(
    report.checks.map((c) => c.status),
    ["healthy", "healthy", "healthy"],
  );
  const wrong = await networkHealth(nodes, "network", {
    request: async () =>
      JSON.stringify({
        result: { node_info: { network: "wrong" } },
        network: { network_id: "wrong" },
      }),
  });
  assert.ok(wrong.checks.every((c) => c.status === "attention"));
  const now = Date.now(),
    time = new Date(now).toISOString();
  const health = {
    height: "5",
    blockTime: time,
    catchingUp: false,
    primaryConnected: true,
  };
  assert.equal(healthState(health, time, now), "healthy");
  assert.equal(healthState(health, time, now + 61000), "stale");
  for (const changed of [
    { height: "0" },
    { height: "bad" },
    { blockTime: "bad" },
    { blockTime: new Date(now - 121000).toISOString() },
    { catchingUp: true },
    { primaryConnected: false },
  ]) {
    assert.equal(
      healthState({ ...health, ...changed }, time, now),
      "attention",
    );
  }
  const failed = await networkHealth(nodes, "network", {
    request: async () => {
      throw new Error("offline");
    },
  });
  assert.ok(failed.checks.every((c) => c.message === "offline"));
});

test("host credentials are provider-scoped, persist by ID and never expose secrets", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-credentials-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accounts = new CloudAccounts(root);
  const account = accounts.save({
    provider: "hetzner",
    name: "Production",
    values: { token: "private-token" },
  });
  const nodes = {
    root,
    network: () => ({}),
    dir: () => path.join(root, "future-node"),
    nodeRoot: () => root,
  };
  const hosts = new Hosts(nodes);
  let sshCalls = 0;
  hosts.ssh = async () => {
    sshCalls++;
    return Buffer.from(JSON.stringify({ platform: "linux", node: "24.0.0" }));
  };
  const key = path.join(root, "key"),
    knownHosts = path.join(root, "known-hosts");
  fs.writeFileSync(key, "ssh key");
  fs.writeFileSync(knownHosts, "host key");
  const body = {
    kind: "cloud",
    provider: "aws",
    credentialId: account.id,
    address: "host.example.org",
    user: "root",
    key,
    knownHosts,
  };
  await assert.rejects(
    hosts.save("network", "validator", body),
    /Select a saved credential/,
  );
  assert.equal(sshCalls, 0);
  await hosts.save("network", "validator", { ...body, provider: "hetzner" });
  assert.equal(hosts.get("network", "validator").credentialId, account.id);
  assert.ok(
    !JSON.stringify(hosts.get("network", "validator")).includes(
      "private-token",
    ),
  );
  await hosts.save("network", "validator", {
    kind: "local",
    credentialId: account.id,
  });
  assert.equal(hosts.get("network", "validator").credentialId, undefined);
});

test("network checks retain individual failures and distinguish unprepared nodes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-health-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const records = ["broken", "ready", "new"].map((nodeId) => ({
    nodeId,
    role: "validator",
    name: nodeId,
    prepared: nodeId !== "new",
  }));
  const calls = [];
  const nodes = {
    network: () => ({
      rpc: "https://example.org/graphene-evm/rpc",
      genesis: "{}",
      network: {},
    }),
    inventory: () => [{ id: "network", nodes: records }],
    selectNode: (_id, _role, nodeId) => ({
      root,
      network: () => ({}),
      dir: () => root,
      nodeRoot: () => path.join(root, nodeId),
      operate: async () => {
        calls.push(nodeId);
        if (nodeId === "broken") throw new Error("Docker is unavailable");
        return {
          height: "100",
          catchingUp: false,
          primaryConnected: true,
          blockTime: new Date().toISOString(),
        };
      },
    }),
  };
  const report = await networkHealth(nodes, "network", {
    request: async () => {
      throw new Error("Gateway offline");
    },
  });
  assert.deepEqual(
    report.nodes.map((node) => node.status),
    ["attention", "healthy", "not-installed"],
  );
  assert.equal(report.nodes[0].message, "Docker is unavailable");
  assert.deepEqual(calls, ["broken", "ready"]);
});

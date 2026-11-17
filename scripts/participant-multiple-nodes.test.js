import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Participants } from "../participant/runtime.js";
import { Hosts } from "../participant/hosts.js";
import { createConsole } from "../participant/server.js";
const sha = (value) => createHash("sha256").update(value).digest("hex");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "participant-multiple-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const genesis = JSON.stringify({ chain_id: "graphene-dev-19876", validators: [{ address: "GENESIS", pub_key: { value: "genesis-signer" } }] });
  const file_hashes = { "genesis.json": sha(genesis) };
  const id = sha(JSON.stringify(file_hashes));
  const image = "example.org/graphene@sha256:" + "a".repeat(64);
  const invite = { format: "graphene-join-v1", release: "v1", genesis, config: "# config",
    network: { stage: "dev", chain_id: 19876, network_id: id, file_hashes },
    peer: "a".repeat(40) + "@8.8.8.8:26656", rpc: "https://example.org/graphene-evm/rpc", sentryId: "0x" + "2".repeat(40),
    publicPeer: "a".repeat(40) + "@8.8.8.8:26656",
    images: Object.fromEntries(["abci", "postgres", "mpt", "tendermint", "transport", "nginx"].map((key) => [key, image])),
  };
  const raw = JSON.stringify(invite), calls = [];
  const runner = async (dir, project, args) => { calls.push({ dir, project, args }); return ""; };
  const nodes = new Participants(root, runner);
  nodes.import(raw, sha(raw));
  return { root, nodes, id, raw, calls, runner };
}
test("multiple validators and sentries retain separate identities, hosts and service targets after restart", async (t) => {
  const { root, nodes, id, calls, runner } = fixture(t);
  const records = [];
  for (const role of ["validator", "sentry"])
    for (let index = 0; index < 2; index++) {
      const record = nodes.createNode(id, role, role + " " + (index + 1));
      records.push(record);
      const scope = nodes.selectNode(id, role, record.nodeId);
      await new Hosts(scope).save(id, role, { kind: "local" });
      if (role === "validator") { scope.identity(id, "0x" + String(index + 1).repeat(40), "p".repeat(64)); scope.prepareInvitedValidator(id); }
      else scope.prepareSentry(id, "sentry.example.org", "", { p2pPort: 26656 + index * 2, rpcPort: 26657 + index * 2 });
    }
  const restarted = new Participants(root, runner);
  const inventory = (await new Hosts(restarted).inventory())[0];
  assert.equal(inventory.nodes.length, 4);
  assert.equal(new Set(inventory.nodes.map((node) => node.identity.node_id)).size, 4);
  for (const record of records) {
    const scope = restarted.selectNode(id, record.role, record.nodeId);
    assert.equal(inventory.hosts[record.nodeId].configured, true);
    await scope.operate(id, record.role, "stop");
    assert.equal(calls.at(-1).dir, scope.dir(id, record.role));
    assert.equal(calls.at(-1).project, scope.project(id, record.role));
  }
  assert.equal(new Set(calls.map((call) => call.project)).size, 4);
  const sentries = records.filter((node) => node.role === "sentry");
  const first = restarted.selectNode(id, "sentry", sentries[0].nodeId);
  const second = restarted.selectNode(id, "sentry", sentries[1].nodeId);
  assert.match(first.sentryInvitation(id).publicPeer, /:26656$/);
  assert.match(second.sentryInvitation(id).publicPeer, /:26658$/);
  first.reviewDeployment(id, "sentry");
  await first.operate(id, "sentry", "start");
  assert.equal(calls.at(-1).dir, first.dir(id, "sentry"));
  assert.equal(fs.existsSync(path.join(second.dir(id, "sentry"), "deployment-review.json")), false);
});
test("legacy nodes stay available and invalid or colliding node selections are rejected", (t) => {
  const { nodes, id } = fixture(t);
  nodes.identity(id, "0x" + "1".repeat(40), "p".repeat(64));
  const record = nodes.createNode(id, "validator", "Second validator");
  const scope = nodes.selectNode(id, "validator", record.nodeId);
  assert.notEqual(nodes.dir(id, "validator"), scope.dir(id, "validator"));
  assert.equal(nodes.inventory()[0].nodes.find((node) => node.nodeId === "validator").hasData, true);
  assert.throws(() => nodes.createNode(id, "validator", "SECOND VALIDATOR"), /unique/);
  assert.throws(() => nodes.selectNode(id, "sentry", record.nodeId), /role/);
  assert.throws(() => nodes.selectNode(id, "validator", "node-" + "f".repeat(12)), /not found/);
  assert.throws(() => nodes.selectNode(id, "validator", "../validator"), /valid node/);
  assert.throws(() => scope.dir(id, "sentry"), /another/);
  const first = nodes.createNode(id, "sentry", "Sentry one");
  nodes.selectNode(id, "sentry", first.nodeId).prepareSentry(id, "sentry.example.org");
  const second = nodes.createNode(id, "sentry", "Sentry two");
  assert.throws(() => nodes.selectNode(id, "sentry", second.nodeId).prepareSentry(id, "sentry.example.org"), /ports/);
});
test("HTTP node creation and actions keep the selected node ID", async (t) => {
  const { root, id, calls, runner } = fixture(t);
  const { server, token } = createConsole(root, { runner, fetchInvitation: async () => { throw new Error("Public API offline in this test"); } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const call = (action, body) => fetch(base + "/api/" + action, { method: "POST", headers: { authorization: "Bearer " + token, origin: base, "content-type": "application/json" }, body: JSON.stringify({ id, ...body }) });
  const created = [];
  for (let index = 0; index < 2; index++) {
    const response = await call("create-node", { role: "validator", name: "Validator " + index });
    assert.equal(response.status, 200);
    const record = await response.json(); created.push(record);
    assert.equal((await call("host", { role: "validator", nodeId: record.nodeId, kind: "local" })).status, 200);
    assert.equal((await call("identity", { role: "validator", nodeId: record.nodeId, operator: "0x" + String(index + 1).repeat(40), password: "p".repeat(64) })).status, 200);
  }
  for (const record of created) assert.equal((await call("prepare-validator-public", { role: "validator", nodeId: record.nodeId })).status, 200);
  assert.equal((await call("stop", { role: "validator", nodeId: created[1].nodeId })).status, 200);
  assert.ok(calls.at(-1).dir.includes(created[1].nodeId));
  const state = await (await fetch(base + "/api/state", { headers: { authorization: "Bearer " + token } })).json();
  assert.equal(state.networks[0].nodes.length, 2);
  assert.equal(state.activity[0].nodeId, created[1].nodeId);
  assert.equal((await call("stop", { role: "sentry", nodeId: created[0].nodeId })).status, 400);
  assert.equal((await call("stop", { role: "validator", nodeId: "../../validator" })).status, 400);
  assert.equal(calls.length, 1);
});
test("the SSH worker keeps multiple remote nodes separate", (t) => {
  const { root, id, raw } = fixture(t);
  const worker = fileURLToPath(new URL("../participant/remote-worker.js", import.meta.url));
  const call = (action, body) => {
    const result = spawnSync(process.execPath, [worker], {
      input: JSON.stringify({ action, body: { id, ...body } }),
      env: { ...process.env, HOME: path.join(root, "remote-home") },
      encoding: "utf8", timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  for (let index = 0; index < 2; index++) {
    const nodeId = "node-" + String(index + 1).repeat(12);
    assert.equal(call("import", { role: "validator", nodeId, name: "Remote " + index, raw, fingerprint: sha(raw) }).id, id);
    assert.equal(call("identity", { role: "validator", nodeId, operator: "0x" + String(index + 1).repeat(40), password: "p".repeat(64) }).error, undefined);
    const inventory = call("inventory", { role: "validator", nodeId });
    assert.equal(inventory[0].nodes.length, 1);
    assert.equal(inventory[0].nodes[0].nodeId, nodeId);
  }
  const remote = new Participants(path.join(root, "remote-home/.graphene/participants"));
  assert.equal(remote.inventory()[0].nodes.length, 2);
  assert.notEqual(remote.inventory()[0].nodes[0].identity.node_id, remote.inventory()[0].nodes[1].identity.node_id);
  const next = JSON.stringify({ ...JSON.parse(raw), release: "v2" });
  const nodeId = "node-" + "3".repeat(12);
  assert.equal(call("import", { role: "validator", nodeId, name: "Remote latest", raw: next, fingerprint: sha(next), updateInvitation: true }).id, id);
  assert.equal(remote.selectNode(id, "validator", "node-" + "1".repeat(12)).network(id).release, "v1");
  assert.equal(remote.selectNode(id, "validator", nodeId).network(id).release, "v2");
});

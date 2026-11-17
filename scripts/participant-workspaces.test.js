import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Participants } from "../participant/runtime.js";
import { PublicWorkspaces, publicNetworks } from "../participant/public-workspaces.js";
import { createConsole } from "../participant/server.js";
const sha = (value) => createHash("sha256").update(value).digest("hex");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "participant-workspaces-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nodes = new Participants(root, async () => "");
  const invitations = new Map(publicNetworks.map((workspace, index) => {
    const chain = 19876 + index;
    const genesis = JSON.stringify({ chain_id: `graphene-${workspace.stage}-${chain}`, validators: [{ address: "GENESIS", pub_key: { value: "signer" } }] });
    const file_hashes = { "genesis.json": sha(genesis) };
    const raw = JSON.stringify({ format: "graphene-join-v1", release: "v1", genesis, config: "# config",
      network: { stage: workspace.stage, chain_id: chain, network_id: sha(JSON.stringify(file_hashes)), file_hashes },
      peer: "a".repeat(40) + "@8.8.8.8:26656", publicPeer: "a".repeat(40) + "@sentry.example.org:26656",
      rpc: workspace.api + "/graphene-evm/rpc", sentryId: "0x" + "2".repeat(40),
      images: Object.fromEntries(["abci", "postgres", "mpt", "tendermint", "transport", "nginx"].map((name) => [name, "example.org/graphene@sha256:" + "a".repeat(64)])),
    });
    return [workspace.api + "/api/invitation", raw];
  }));
  return { root, nodes, invitations };
}
test("public workspace discovery fetches all three HTTPS APIs without manual invitation inputs", async (t) => {
  const { nodes, invitations } = fixture(t), calls = [];
  let now = 100000;
  const catalog = new PublicWorkspaces(nodes, async (url) => { calls.push(url); return invitations.get(url); }, () => now);
  assert.deepEqual(catalog.snapshot().map((row) => row.id), ["dev", "test", "prod"]);
  await Promise.all([catalog.refresh(), catalog.refresh()]);
  assert.equal(calls.length, 3, "concurrent state reads share discovery requests");
  assert.deepEqual(new Set(calls), new Set(publicNetworks.map((workspace) => workspace.api + "/api/invitation")));
  assert.ok(catalog.snapshot().every((row) => row.networkId && !row.error));
  assert.deepEqual(nodes.inventory().map((network) => network.stage).sort(), ["dev", "production", "staging"]);
  await catalog.refresh();
  assert.equal(calls.length, 3, "state refreshes use the short discovery cache");
  now += 60001;
  await catalog.refresh("test");
  assert.equal(calls.length, 4);
  assert.equal(calls.at(-1), "https://api.test.zlinkchain.io/api/invitation");
});
test("offline APIs remain visible and verified cached nodes survive retries and restart", async (t) => {
  const { nodes, invitations } = fixture(t);
  const catalog = new PublicWorkspaces(nodes, async (url) => invitations.get(url));
  await catalog.refresh();
  const dev = catalog.snapshot()[0];
  nodes.createNode(dev.networkId, "validator", "Saved validator");
  const offline = new PublicWorkspaces(nodes, () => { throw new Error("API unavailable"); });
  assert.equal(offline.snapshot()[0].networkId, dev.networkId);
  await offline.refresh();
  assert.equal(offline.snapshot().length, 3);
  assert.ok(offline.snapshot().every((row) => row.error === "API unavailable"));
  await offline.refresh("dev", true);
  assert.equal(offline.pending.size, 0, "synchronous failures do not prevent retries");
  assert.equal(nodes.inventory().find((network) => network.id === dev.networkId).nodes[0].name, "Saved validator");
  await assert.rejects(offline.refresh("untrusted"), /Dev, Test or Prod/);
});
test("discovery rejects corrupted, cross-stage and foreign-RPC invitations", async (t) => {
  for (const mutate of [
    (invite) => { invite.genesis = "{}"; },
    (invite) => { invite.rpc = "https://foreign.example/graphene-evm/rpc"; },
  ]) {
    const { nodes, invitations } = fixture(t);
    const catalog = new PublicWorkspaces(nodes, async (url) => { const invite = JSON.parse(invitations.get(url)); mutate(invite); return JSON.stringify(invite); });
    await catalog.refresh();
    assert.ok(catalog.snapshot().every((row) => row.error && !row.networkId));
    assert.equal(nodes.inventory().length, 0);
  }
  const { nodes, invitations } = fixture(t);
  const catalog = new PublicWorkspaces(nodes, async () => invitations.get("https://api.dev.zlinkchain.io/api/invitation"));
  await catalog.refresh("test");
  assert.match(catalog.snapshot()[1].error, /another stage/);
  assert.equal(nodes.inventory().length, 0);
});
test("console state discovers workspaces and users can create nodes without calling import", async (t) => {
  const { root, invitations } = fixture(t);
  const { server, token } = createConsole(root, { fetchInvitation: async (url) => invitations.get(url) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const auth = { authorization: "Bearer " + token };
  const state = await (await fetch(base + "/api/state", { headers: auth })).json();
  assert.equal(state.workspaces.length, 3);
  assert.equal(state.networks.length, 3);
  for (const workspace of state.workspaces) {
    const response = await fetch(base + "/api/create-node", { method: "POST", headers: { ...auth, origin: base, "content-type": "application/json" }, body: JSON.stringify({ id: workspace.networkId, role: "validator", name: workspace.label + " validator" }) });
    assert.equal(response.status, 200);
  }
  const response = await fetch(base + "/api/workspace-refresh", { method: "POST", headers: { ...auth, origin: base, "content-type": "application/json" }, body: JSON.stringify({ workspace: "test" }) });
  assert.equal(response.status, 200);
  const finalState = await (await fetch(base + "/api/state", { headers: auth })).json();
  assert.ok(finalState.networks.every((network) => network.nodes.length === 1));
  assert.equal(finalState.activity.some((entry) => entry.action === "import"), false);
});
test("changed API invitations offer an explicit update while existing nodes stay pinned", async (t) => {
  const { root, nodes, invitations } = fixture(t);
  const url = "https://api.dev.zlinkchain.io/api/invitation";
  const oldRaw = invitations.get(url), oldInvite = JSON.parse(oldRaw);
  const id = nodes.import(oldRaw, sha(oldRaw));
  nodes.identity(id, "0x" + "1".repeat(40), "p".repeat(64));
  const originalKey = fs.readFileSync(path.join(nodes.dir(id, "validator"), "identity/tendermint/config/priv_validator_key.json"));
  const pending = nodes.createNode(id, "validator", "Pending old node");
  const next = { ...oldInvite, release: "v2", config: "# revised config" };
  invitations.set(url, JSON.stringify(next));
  const catalog = new PublicWorkspaces(nodes, async (url) => invitations.get(url));
  await catalog.refresh("dev");
  const available = catalog.snapshot()[0];
  assert.equal(available.networkId, id, "an existing manual import is recognized as the workspace");
  assert.equal(available.error, null);
  assert.equal(available.update.currentRelease, "v1");
  assert.equal(available.update.release, "v2");
  assert.equal(nodes.network(id).release, "v1", "discovery does not apply an update");
  await catalog.update("dev", available.update.fingerprint);
  assert.equal(nodes.network(id).release, "v2");
  assert.equal(catalog.snapshot()[0].update, null);
  assert.equal(nodes.selectNode(id, "validator", "validator").network(id).release, "v1");
  assert.equal(nodes.selectNode(id, "validator", pending.nodeId).network(id).release, "v1");
  assert.deepEqual(fs.readFileSync(path.join(nodes.dir(id, "validator"), "identity/tendermint/config/priv_validator_key.json")), originalKey);
  const created = nodes.createNode(id, "validator", "New v2 node");
  assert.equal(nodes.selectNode(id, "validator", created.nodeId).network(id).release, "v2");
  const restarted = new Participants(root);
  assert.equal(restarted.selectNode(id, "validator", "validator").network(id).release, "v1");
  assert.equal(restarted.selectNode(id, "validator", created.nodeId).network(id).release, "v2");
  assert.equal(restarted.inventory()[0].nodes.find((node) => node.nodeId === "validator").invitation.release, "v1");
});
test("an update must match the reviewed API response and cannot replace frozen genesis", async (t) => {
  const { nodes, invitations } = fixture(t);
  const url = "https://api.dev.zlinkchain.io/api/invitation";
  const original = JSON.parse(invitations.get(url));
  const id = nodes.import(JSON.stringify(original), sha(JSON.stringify(original)));
  const catalog = new PublicWorkspaces(nodes, async (url) => invitations.get(url));
  invitations.set(url, JSON.stringify({ ...original, release: "v2" }));
  await catalog.refresh("dev");
  const reviewed = catalog.snapshot()[0].update.fingerprint;
  invitations.set(url, JSON.stringify({ ...original, release: "v3" }));
  await assert.rejects(catalog.update("dev", reviewed), /API invitation changed/);
  assert.equal(nodes.network(id).release, "v1");
  const changed = structuredClone(original);
  changed.network.chain_id += 10;
  changed.genesis = JSON.stringify({ ...JSON.parse(changed.genesis), chain_id: "graphene-dev-" + changed.network.chain_id });
  changed.network.file_hashes["genesis.json"] = sha(changed.genesis);
  changed.network.network_id = sha(JSON.stringify(changed.network.file_hashes));
  invitations.set(url, JSON.stringify(changed));
  await catalog.refresh("dev", true);
  const update = catalog.snapshot()[0].update;
  assert.equal(update.networkChanged, true);
  await assert.rejects(catalog.update("dev", update.fingerprint), /different frozen network/);
  assert.equal(nodes.network(id).release, "v1");
  assert.equal(nodes.inventory().length, 1);
});
test("workspace-update API applies only the reviewed invitation", async (t) => {
  const { root, nodes, invitations } = fixture(t);
  const url = "https://api.dev.zlinkchain.io/api/invitation";
  const raw = invitations.get(url);
  nodes.import(raw, sha(raw));
  invitations.set(url, JSON.stringify({ ...JSON.parse(raw), release: "v2" }));
  const { server, token } = createConsole(root, { fetchInvitation: async (url) => invitations.get(url) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const headers = { authorization: "Bearer " + token, origin: base, "content-type": "application/json" };
  const state = await (await fetch(base + "/api/state", { headers })).json();
  const update = state.workspaces[0].update;
  assert.equal((await fetch(base + "/api/workspace-update", { method: "POST", headers, body: JSON.stringify({ workspace: "dev", fingerprint: "0".repeat(64) }) })).status, 400);
  const result = await fetch(base + "/api/workspace-update", { method: "POST", headers, body: JSON.stringify({ workspace: "dev", fingerprint: update.fingerprint }) });
  assert.equal(result.status, 200);
  const finalState = await (await fetch(base + "/api/state", { headers })).json();
  assert.equal(finalState.workspaces[0].update, null);
  assert.equal(finalState.networks.find((network) => network.id === state.workspaces[0].networkId).release, "v2");
});

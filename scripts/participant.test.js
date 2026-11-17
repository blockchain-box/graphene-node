import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Participants, homeCompose } from "../participant/runtime.js";
import { createConsole } from "../participant/server.js";
import { transaction, enrollment } from "../participant/enrollment.js";
import { Interface } from "ethers";

const sha = (x) => createHash("sha256").update(x).digest("hex");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "participant-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const genesis = JSON.stringify({
    chain_id: "graphene-dev-19876",
    validators: [{ address: "GENESIS", pub_key: { value: "genesis-signer" } }],
  });
  const file_hashes = { "genesis.json": sha(genesis) },
    id = sha(JSON.stringify(file_hashes));
  const image = "example.org/graphene@sha256:" + "a".repeat(64);
  const network = {
    stage: "dev",
    chain_id: 19876,
    network_id: id,
    file_hashes,
  };
  const invite = {
    format: "graphene-join-v1",
    release: "v1",
    genesis,
    network,
    config: "# config",
    tunnelPolicy: {allowed_peer:"y".repeat(52),bootstrap:null},
    peer: "a".repeat(40) + "@192.0.2.1:26656",
    rpc: "https://api.example.org/graphene-evm/rpc",
    sentryId: "0x" + "2".repeat(40),
    images: Object.fromEntries(
      ["abci", "postgres", "mpt", "tendermint", "transport", "nginx"].map(
        (k) => [k, image],
      ),
    ),
  };
  const raw = JSON.stringify(invite),
    calls = [];
  const manager = new Participants(root, async (dir, project, args) => {
    calls.push({ dir, project, args });
    return "";
  });
  return { root, invite, raw, id, calls, manager };
}
test("imports by fingerprint, persists bindings and prepares an independent nonvoting peer", async (t) => {
  const { root, manager, id, raw, invite, calls } = fixture(t);
  assert.throws(() => manager.import(raw, "a".repeat(64)), /SHA-256/);
  const tampered = JSON.stringify({ ...invite, genesis: "{}" });
  assert.throws(() => manager.import(tampered, sha(tampered)), /checksum/);
  manager.import(raw, sha(raw));
  manager.prepareSentry(id, "192.0.2.2");
  const node = new Participants(root).inventory()[0].nodes[0];
  assert.equal(node.role, "sentry");
  assert.equal(node.prepared, true);
  const dir = manager.dir(id, "sentry");
  const compose = JSON.parse(fs.readFileSync(path.join(dir, "compose.json")));
  assert.equal(compose.services["home-tunnel"], undefined);
  assert.ok(compose.services.node.command.includes(invite.peer));
  assert.equal(compose.services.node.ports.length, 1);
  assert.notEqual(node.identity.node_id, invite.peer.split("@")[0]);
  await manager.operate(id, "sentry", "start");
  assert.deepEqual(calls[0].args, ["up", "-d"]);
  assert.throws(() => manager.prepareSentry(id, "192.0.2.2"), /already/);
  fs.writeFileSync(path.join(dir, ".rollout-fence.json"), "{}");
  await assert.rejects(manager.operate(id, "sentry", "start"), /fenced/);
});
test("a local sentry can join outbound without publishing peer or RPC ports to the network", (t) => {
  const { manager, raw, id } = fixture(t);
  manager.import(raw, sha(raw));
  manager.prepareSentry(id, "");
  const file = path.join(manager.dir(id, "sentry"), "compose.json");
  const { node, gateway } = JSON.parse(fs.readFileSync(file)).services;
  assert.equal(node.ports, undefined);
  assert.equal(node.command.includes("--p2p.external-address"), false);
  assert.deepEqual(gateway.ports, ["127.0.0.1::26657"]);
});
test("admitted validator handoff preserves keys, rejects genesis bundles and foreign images, and returns the controller receipt", async (t) => {
  const { manager, raw, invite, id, root } = fixture(t);
  manager.import(raw, sha(raw));
  const identity = manager.identity(id, "0x" + "1".repeat(40), "x".repeat(32));
  const dir = manager.dir(id, "validator"),
    file = path.join(dir, "identity/tendermint/config/priv_validator_key.json"),
    before = fs.readFileSync(file);
  const bundle = path.join(root, "bundle");
  function write(name, value) {
    const dest = path.join(bundle, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(
      dest,
      typeof value === "string" ? value : JSON.stringify(value),
    );
  }
  const compose = { ...homeCompose(invite), name: "graphene-dev-0123456789ab" };
  write("network.json", invite.network);
  write("compose.json", compose);
  write("identity/tendermint/config/genesis.json", invite.genesis);
  write("identity/tendermint/config/config.toml", invite.config);
  write("tunnel-policy.json", invite.tunnelPolicy);
  assert.throws(() => manager.prepareValidator(id, bundle), /post-genesis/);
  write("validator-admission.json", {
    schema: 1,
    networkId: id,
    identity: { ...identity, node_id: "wrong" },
  });
  assert.throws(
    () => manager.prepareValidator(id, bundle),
    /admission does not match/,
  );
  write("validator-admission.json", { schema: 1, networkId: id, identity });
  write("compose.json", {
    ...compose,
    services: { ...compose.services, node: { image: "unapproved" } },
  });
  assert.throws(() => manager.prepareValidator(id, bundle), /differs/);
  write("compose.json", compose);
  write("tunnel-policy.json", {...invite.tunnelPolicy,allowed_peer:"o".repeat(52)});
  assert.throws(() => manager.prepareValidator(id,bundle),/tunnel policy/);
  write("tunnel-policy.json",invite.tunnelPolicy);
  manager.prepareValidator(id, bundle);
  await manager.operate(id, "validator", "start");
  assert.deepEqual(before, fs.readFileSync(file));
  assert.equal(
    manager.inventory()[0].nodes[0].receipt.compose_sha256,
    sha(fs.readFileSync(path.join(bundle, "compose.json"))),
  );
  fs.unlinkSync(
    path.join(dir, "identity/tendermint/data/priv_validator_state.json"),
  );
  await assert.rejects(
    manager.operate(id, "validator", "start"),
    /signing history/,
  );
});
test("private API refuses unauthenticated and cross-origin imports; state never includes secrets", async (t) => {
  const { root, raw, id } = fixture(t);
  const { server, token } = createConsole(root, { fetchInvitation: async () => { throw new Error("Public API offline in this test"); } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const origin = "http://127.0.0.1:" + server.address().port,
    auth = { Authorization: "Bearer " + token };
  assert.equal((await fetch(origin + "/api/state")).status, 403);
  for (const [from, code] of [
    ["http://elsewhere.example", 403],
    [origin, 200],
  ]) {
    const res = await fetch(origin + "/api/import", {
      method: "POST",
      headers: { ...auth, Origin: from, "Content-Type": "application/json" },
      body: JSON.stringify({ raw, fingerprint: sha(raw) }),
    });
    assert.equal(res.status, code);
  }
  const state = await (
    await fetch(origin + "/api/state", { headers: auth })
  ).json();
  assert.equal(state.networks[0].id, id);
  assert.equal(state.activity.length, 1);
  assert.ok(!JSON.stringify(state).includes("services"));
});
test("enrollment builds the deployed ABI for the matching owner and chain and refuses duplicate requests", async (t) => {
  const { manager, invite, id, raw } = fixture(t);
  manager.import(raw, sha(raw));
  const i = manager.identity(id, "0x" + "1".repeat(40), "x".repeat(32));
  const status = await enrollment(invite, i, async (url, options) =>
    url.pathname.endsWith("/rpc")
      ? Response.json({ result: JSON.parse(options.body).method === "eth_chainId" ? "0x4da4" : "0x3782dace9d900000" })
      : new Response(null, { status: 404 }),
  );
  assert.equal(status.registered, false);
  assert.equal(status.balance, "4.0");
  assert.throws(() => transaction(invite, i, status, "register", "4"), /stake and transaction fees/);
  const tx = transaction(invite, i, status, "register", "3.5");
  const abi = new Interface([
    "function registerValidator(address,string,string,string,string,uint256)",
  ]);
  assert.equal(tx.from, i.operator_address);
  assert.equal(
    abi.decodeFunctionData("registerValidator", tx.data)[5],
    3500000000000000000n,
  );
  assert.throws(
    () =>
      transaction(
        invite,
        i,
        { registered: true, pending: true },
        "request-sentry",
      ),
    /pending/,
  );
  await assert.rejects(
    enrollment(invite, i, async () => Response.json({ result: "0x1" })),
    /different chain/,
  );
});

test("health distinguishes an isolated node from a live connection to its invited primary",async t=>{
  const {manager,root,raw,id,invite}=fixture(t); manager.import(raw,sha(raw)); manager.prepareSentry(id);
  const me=manager.inventory()[0].nodes[0].identity.node_id;
  let peers=[];
  const runtime=new Participants(root, async (_d,_p,args)=>JSON.stringify({result:args.at(-1).endsWith("/status")?
    {node_info:{id:me,network:JSON.parse(invite.genesis).chain_id},sync_info:{latest_block_height:"0",catching_up:false},validator_info:{voting_power:"0"}}:{peers}}));
  assert.equal((await runtime.operate(id,"sentry","health")).primaryConnected,false);
  peers=[{node_info:{id:invite.peer.split("@")[0]}}];
  assert.equal((await runtime.operate(id,"sentry","health")).primaryConnected,true);
});

test("a changed frozen genesis is rejected before starting Docker", async t=>{
  const {manager,id,raw,calls}=fixture(t); manager.import(raw,sha(raw)); manager.prepareSentry(id);
  fs.appendFileSync(path.join(manager.dir(id,"sentry"),"identity/tendermint/config/genesis.json")," ");
  await assert.rejects(manager.operate(id,"sentry","start"),/Genesis or network binding changed/);
  assert.deepEqual(calls,[]);
});

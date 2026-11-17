import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Participants } from "../participant/runtime.js";
import { createConsole } from "../participant/server.js";
import { PublicCheckpoints } from "../participant/public-checkpoints.js";
import { enrollment } from "../participant/enrollment.js";
import {
  canonical,
  genesisHash,
} from "../participant/checkpoint/snapshot-files.mjs";

function fixture(change = {}) {
  const keys = crypto.generateKeyPairSync("ed25519");
  const genesis = {
    chain_id: "graphene-dev-19876",
    validators: [{ address: "GENESIS", pub_key: { value: "signer" } }],
  };
  const images = Object.fromEntries(
    ["tendermint", "abci", "postgres", "mpt", "transport"].map((k) => [
      k,
      "example.org/" + k + "@sha256:" + "a".repeat(64),
    ]),
  );
  const invite = {
    format: "graphene-join-v1",
    release: "0.0.2",
    config: "# test",
    peer: "a".repeat(40) + "@8.8.8.8:26656",
    sentryId: "0x" + "1".repeat(40),
    rpc: "https://api.dev.zlinkchain.io/graphene-evm/rpc",
    network: { network_id: "a".repeat(64), chain_id: 19876 },
    genesis: JSON.stringify(genesis),
    images,
  };
  invite.images.nginx = "example.org/nginx@sha256:" + "a".repeat(64);
  invite.network.file_hashes = {
    "genesis.json": crypto
      .createHash("sha256")
      .update(invite.genesis)
      .digest("hex"),
  };
  invite.network.network_id = crypto
    .createHash("sha256")
    .update(JSON.stringify(invite.network.file_hashes))
    .digest("hex");
  invite.network.stage = "dev";
  const manifest = {
    schema: 2,
    kind: "graphene-state-snapshot",
    id: "b".repeat(24),
    height: "42",
    chainId: 19876,
    networkId: invite.network.network_id,
    genesis,
    genesisHash: genesisHash(genesis),
    images,
    release: "0.0.2",
    createdAt: new Date().toISOString(),
    appHash: "a".repeat(64),
    blockHash: "b".repeat(64),
    files: Object.fromEntries(
      ["genesis.json", "app-state.json", "mpt.tar.gz", "tendermint.tar.gz"].map(
        (k) => [
          k,
          {
            bytes: 10,
            sha256: "c".repeat(64),
            ...(k.endsWith(".gz") ? { unpackedBytes: 20 } : {}),
          },
        ],
      ),
    ),
    verification: {
      caughtUp: true,
      nonVoting: true,
      height: 43,
      appHash: "d".repeat(64),
    },
    ...change,
  };
  const fingerprint = crypto
    .createHash("sha256")
    .update(keys.publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  const envelope = {
    manifest,
    fingerprint,
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }),
    signature: crypto
      .sign(null, Buffer.from(canonical(manifest)), keys.privateKey)
      .toString("base64"),
  };
  return { invite, envelope };
}

test("enrollment accepts dev decimal balances as well as standard hex without losing precision", async () => {
  for (const [balance, expected] of [
    ["0", "0.0"],
    ["0x0", "0.0"],
    ["1000000000000000001", "1.000000000000000001"],
  ]) {
    const state = await enrollment(
      {
        rpc: "https://api.dev.zlinkchain.io/graphene-evm/rpc",
        network: { chain_id: 19876 },
      },
      { operator_address: "0x" + "1".repeat(40) },
      async (url, options) => ({
        ok: true,
        status: 200,
        json: async () =>
          url.pathname.endsWith("/rpc")
            ? {
                result:
                  JSON.parse(options.body).method === "eth_chainId"
                    ? "0x4da4"
                    : balance,
              }
            : { registered: false },
      }),
    );
    assert.equal(state.balance, expected);
  }
});
test("current checkpoint is discovered and verified from the network API without manual inputs", async () => {
  const { invite, envelope } = fixture();
  const calls = [];
  const checkpoints = new PublicCheckpoints(async (url, path) => {
    calls.push([url, path]);
    return JSON.stringify(envelope);
  });
  const current = await checkpoints.lookup(invite);
  assert.equal(current.available, true);
  assert.equal(current.height, "42");
  assert.equal(
    current.baseUrl,
    "https://api.dev.zlinkchain.io/checkpoints/" + "b".repeat(24) + "/",
  );
  assert.equal(
    calls[0][0],
    "https://api.dev.zlinkchain.io/checkpoints/latest.json",
  );
  assert.equal("raw" in checkpoints.summary(current), false);
  await checkpoints.lookup(invite);
  assert.equal(calls.length, 1);
  await checkpoints.lookup(invite, true);
  assert.equal(calls.length, 2);
});
test("current checkpoint rejects tampering, old snapshots and incompatible images", async () => {
  for (const mode of ["signature", "age", "images", "network", "publisher"]) {
    const { invite, envelope } = fixture(
      mode === "age" ? { createdAt: "2020-01-01T00:00:00Z" } : {},
    );
    if (mode === "signature") envelope.manifest.height = "44";
    if (mode === "images")
      invite.images.abci = "example.org/abci@sha256:" + "f".repeat(64);
    if (mode === "network") invite.network.network_id = "f".repeat(64);
    if (mode === "publisher")
      invite.checkpoint = { fingerprint: "0".repeat(64) };
    assert.equal(
      (
        await new PublicCheckpoints(async () =>
          JSON.stringify(envelope),
        ).lookup(invite)
      ).available,
      false,
      mode,
    );
  }
});
test("missing checkpoints and foreign checkpoint origins remain explicit, with no untrusted fetch", async () => {
  const { invite } = fixture();
  let called = false;
  invite.checkpoint = {
    url: "https://foreign.example.org/checkpoints/latest.json",
  };
  const current = await new PublicCheckpoints(async () => {
    called = true;
    throw Error("HTTP 404");
  }).lookup(invite);
  assert.equal(current.available, false);
  assert.equal(called, false);
  delete invite.checkpoint;
  const missing = await new PublicCheckpoints(async () => {
    throw Error("HTTP 404");
  }).lookup(invite);
  assert.match(missing.error, /has not published/);
});

test("HTTP current-checkpoint selection fills trusted network data and refuses a changed review", async (t) => {
  const { invite, envelope } = fixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "public-checkpoint-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nodes = new Participants(root),
    raw = JSON.stringify(invite),
    id = nodes.import(
      raw,
      crypto.createHash("sha256").update(raw).digest("hex"),
    );
  const node = nodes.createNode(id, "sentry", "Checkpoint node");
  nodes
    .selectNode(id, "sentry", node.nodeId)
    .prepareSentry(id, "sentry.example.org");
  const { server, token } = createConsole(root, {
    fetchInvitation: async () => {
      throw Error("offline");
    },
    fetchCheckpoint: async () => JSON.stringify(envelope),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const headers = {
    authorization: "Bearer " + token,
    origin: base,
    "content-type": "application/json",
  };
  const post = (body) =>
    fetch(base + "/api/checkpoint-current", {
      method: "POST",
      headers,
      body: JSON.stringify({
        id,
        role: "sentry",
        nodeId: node.nodeId,
        ...body,
      }),
    });
  let response = await post({
    checkpointId: "0".repeat(24),
    fingerprint: envelope.fingerprint,
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /changed/);
  response = await post({
    checkpointId: envelope.manifest.id,
    fingerprint: envelope.fingerprint,
    baseUrl: "https://untrusted.example.org/",
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).height, "42");
  const saved = JSON.parse(
    fs.readFileSync(
      path.join(
        nodes.selectNode(id, "sentry", node.nodeId).dir(id, "sentry"),
        "checkpoint-selection.json",
      ),
    ),
  );
  assert.match(
    saved.baseUrl,
    /^https:\/\/api\.dev\.zlinkchain\.io\/checkpoints\//,
  );
});

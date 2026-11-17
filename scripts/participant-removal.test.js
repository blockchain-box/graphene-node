import test from "node:test";
import { spawnSync as __spawn } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { Participants } from "../participant/runtime.js";
import { Hosts } from "../participant/hosts.js";
import { CloudAccounts } from "../participant/cloud-accounts.js";
import { NodeRemoval } from "../participant/removal.js";
import {
  CloudRemoval,
  parseXml,
  awsSignature,
} from "../participant/cloud-removal.js";
import { createConsole } from "../participant/server.js";
const sha = (value) => createHash("sha256").update(value).digest("hex");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "participant-removal-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const genesis = JSON.stringify({
    chain_id: "graphene-dev-19876",
    validators: [{ address: "GENESIS", pub_key: { value: "signer" } }],
  });
  const file_hashes = { "genesis.json": sha(genesis) },
    id = sha(JSON.stringify(file_hashes));
  const raw = JSON.stringify({
    format: "graphene-join-v1",
    release: "v1",
    genesis,
    config: "# config",
    network: { stage: "dev", chain_id: 19876, network_id: id, file_hashes },
    peer: "a".repeat(40) + "@8.8.8.8:26656",
    rpc: "https://example.org/graphene-evm/rpc",
    sentryId: "0x" + "2".repeat(40),
    images: Object.fromEntries(
      ["abci", "postgres", "mpt", "tendermint", "transport", "nginx"].map(
        (k) => [k, "example.org/node@sha256:" + "a".repeat(64)],
      ),
    ),
  });
  const calls = [],
    nodes = new Participants(root, async (dir, project, args) => {
      calls.push({ dir, project, args });
      return "";
    });
  nodes.import(raw, sha(raw));
  return { root, nodes, id, calls };
}
test("removing a local node destroys only its project, data, snapshots and generated SSH files", async (t) => {
  const { root, nodes, id, calls } = fixture(t);
  const first = nodes.createNode(id, "sentry", "Remove me"),
    second = nodes.createNode(id, "sentry", "Keep me");
  const scope = nodes.selectNode(id, "sentry", first.nodeId);
  scope.prepareSentry(id, "sentry.example.org");
  const other = nodes.selectNode(id, "sentry", second.nodeId);
  other.prepareSentry(id, "other.example.org", "", {
    p2pPort: 26658,
    rpcPort: 26659,
  });
  const identity = fs.readFileSync(
    path.join(other.dir(id, "sentry"), "public.json"),
  );
  const manager = new NodeRemoval(nodes);
  const review = await manager.preview({
    id,
    role: "sentry",
    nodeId: first.nodeId,
  });
  assert.equal(calls.length, 0);
  await assert.rejects(
    manager.remove({
      id,
      role: "sentry",
      nodeId: first.nodeId,
      token: review.token,
      confirmation: "wrong",
    }),
    /exact/,
  );
  assert.equal(calls.length, 0);
  await manager.remove({
    id,
    role: "sentry",
    nodeId: first.nodeId,
    token: review.token,
    confirmation: review.confirmation,
  });
  assert.deepEqual(calls[0].args, [
    "down",
    "--volumes",
    "--remove-orphans",
    "--timeout",
    "30",
  ]);
  assert.equal(calls[0].project, scope.project(id, "sentry"));
  assert.equal(fs.existsSync(scope.nodeRoot(id)), false);
  assert.equal(
    fs.existsSync(
      path.join(root, id, "node-invitations", first.nodeId + ".json"),
    ),
    false,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(other.dir(id, "sentry"), "public.json")),
    identity,
  );
  assert.equal(nodes.inventory()[0].nodes.length, 1);
});
test("failed container shutdown keeps node records and files for retry", async (t) => {
  const { root, nodes, id } = fixture(t);
  const record = nodes.createNode(id, "sentry", "Retry");
  const scope = nodes.selectNode(id, "sentry", record.nodeId);
  scope.prepareSentry(id, "sentry.example.org");
  nodes.runner = async () => {
    throw new Error("Docker unavailable");
  };
  const manager = new NodeRemoval(nodes);
  const body = { id, role: "sentry", nodeId: record.nodeId };
  const review = await manager.preview(body);
  await assert.rejects(
    manager.remove({
      ...body,
      token: review.token,
      confirmation: review.confirmation,
    }),
    /not completed/,
  );
  assert.equal(fs.existsSync(scope.dir(id, "sentry")), true);
  assert.equal(nodes.inventory()[0].nodes.length, 1);
  nodes.runner = async () => "";
  const retry = await manager.preview(body);
  assert.equal(retry.resuming, true);
  await manager.remove({
    ...body,
    token: retry.token,
    confirmation: retry.confirmation,
  });
  assert.equal(nodes.inventory()[0].nodes.length, 0);
});
test("cloud credentials are private, support multiple accounts, and never expose secret values", (t) => {
  const { root } = fixture(t);
  const accounts = new CloudAccounts(root);
  const id = accounts.save({
    name: "Cloud one",
    provider: "hetzner",
    values: { token: "secret-canary-one" },
  }).id;
  accounts.save({
    name: "Cloud two",
    provider: "hetzner",
    values: { token: "secret-canary-two" },
  });
  assert.equal(accounts.summary().accounts.length, 2);
  assert.doesNotMatch(JSON.stringify(accounts.summary()), /secret-canary/);
  assert.equal(fs.statSync(accounts.file).mode & 0o777, 0o600);
  accounts.save({ id, name: "Renamed", values: { token: "" } });
  assert.equal(accounts.get(id, "hetzner").values.token, "secret-canary-one");
  assert.throws(() => accounts.get(id, "aws"), /saved credential/);
});
test("a partial cloud removal resumes reviewed resources without deleting a shared host", async (t) => {
  const { root, nodes, id } = fixture(t);
  const record = nodes.createNode(id, "validator", "Cloud validator");
  const scope = nodes.selectNode(id, "validator", record.nodeId);
  fs.writeFileSync(
    path.join(scope.nodeRoot(id), "validator-host.json"),
    JSON.stringify({
      kind: "cloud",
      installed: false,
      provider: "hetzner",
      address: "vm.example.org",
      port: 22,
    }),
  );
  const accounts = new CloudAccounts(root),
    credentialId = accounts.save({
      name: "Project",
      provider: "hetzner",
      values: { token: "secret" },
    }).id;
  const identity = {
    provider: "hetzner",
    id: "1",
    otherNodes: 0,
    otherContainers: 0,
  };
  const resources = [
    { type: "VM", id: "1" },
    { type: "disk", id: "2" },
  ];
  const deleted = [];
  let fail = true;
  const options = {
    accounts,
    makeHosts: (selected) => ({
      get: (i, r) => new Hosts(selected).get(i, r),
      cloudIdentity: async () => identity,
      removalRequest: async (action, role, operation) =>
        operation === "preview"
          ? { files: [], fingerprint: "remote" }
          : { removed: true },
    }),
    makeCloud: () => ({
      plan: async () => ({
        provider: "hetzner",
        identity,
        resources,
        retained: [],
      }),
      destroy: async (resource) => {
        if (resource.id === "2" && fail) throw new Error("disk busy");
        deleted.push(resource.id);
      },
    }),
  };
  const manager = new NodeRemoval(nodes, options),
    body = {
      id,
      role: "validator",
      nodeId: record.nodeId,
      credentialId,
      deleteCloud: true,
      dedicated: true,
    };
  const review = await manager.preview(body);
  await assert.rejects(
    manager.remove({
      ...body,
      token: review.token,
      confirmation: review.confirmation,
    }),
    /not completed/,
  );
  assert.deepEqual(deleted, ["1"]);
  assert.equal(nodes.inventory()[0].nodes.length, 1);
  fail = false;
  const retry = await manager.preview(body);
  await manager.remove({
    ...body,
    token: retry.token,
    confirmation: retry.confirmation,
  });
  assert.deepEqual(deleted, ["1", "2"]);
  assert.equal(nodes.inventory()[0].nodes.length, 0);
});
test("cloud removal refuses a VM containing another node or unrelated containers", async (t) => {
  const { root, nodes, id } = fixture(t);
  const record = nodes.createNode(id, "sentry", "Shared host"),
    scope = nodes.selectNode(id, "sentry", record.nodeId);
  fs.writeFileSync(
    path.join(scope.nodeRoot(id), "sentry-host.json"),
    JSON.stringify({
      kind: "cloud",
      provider: "hetzner",
      address: "shared.example.org",
      port: 22,
    }),
  );
  const accounts = new CloudAccounts(root),
    credentialId = accounts.save({
      name: "Project",
      provider: "hetzner",
      values: { token: "secret" },
    }).id;
  let planned = false;
  const manager = new NodeRemoval(nodes, {
    accounts,
    makeHosts: (selected) => ({
      get: (i, r) => new Hosts(selected).get(i, r),
      cloudIdentity: async () => ({
        provider: "hetzner",
        id: "1",
        otherNodes: 1,
        otherContainers: 0,
      }),
    }),
    makeCloud: () => {
      planned = true;
    },
  });
  await assert.rejects(
    manager.preview({
      id,
      role: "sentry",
      nodeId: record.nodeId,
      credentialId,
      deleteCloud: true,
      dedicated: true,
    }),
    /other nodes/,
  );
  assert.equal(planned, false);
  assert.equal(nodes.inventory()[0].nodes.length, 1);
});
function fakeApi(initial, onDelete = () => {}) {
  const data = new Map(Object.entries(initial)),
    calls = [];
  return {
    data,
    calls,
    fetch: async (url, options = {}) => {
      const parsed = new URL(url);
      let key = parsed.pathname
        .replace(/^\/v[12]/, "")
        .replace(/^\/compute\/v1/, "");
      calls.push({ method: options.method || "GET", key, body: options.body });
      if (options.method === "DELETE") {
        onDelete(key, data, options);
        data.delete(key);
        return new Response("{}", { status: 200 });
      }
      if (!data.has(key)) return new Response("{}", { status: 404 });
      return Response.json(data.get(key));
    },
  };
}
test("Hetzner plans and deletes server, volumes, snapshots, IPs and dedicated firewall", async () => {
  const api = fakeApi({
    "/servers/1": {
      server: { id: 1, volumes: [2], public_net: { ipv4: { id: 5 } } },
    },
    "/volumes/2": { volume: { id: 2, server: 1 } },
    "/images": { images: [{ id: 3, created_from: { id: 1 } }] },
    "/images/3": { image: { id: 3 } },
    "/floating_ips": { floating_ips: [{ id: 4, server: 1 }] },
    "/floating_ips/4": { floating_ip: { id: 4 } },
    "/primary_ips/5": { primary_ip: { id: 5 } },
    "/firewalls": {
      firewalls: [
        {
          id: 6,
          labels: { "graphene-node-id": "node-x" },
          applied_to: [{ type: "server", server: { id: 1 } }],
        },
      ],
    },
    "/firewalls/6": { firewall: { id: 6 } },
  });
  const client = new CloudRemoval(
    { provider: "hetzner", values: { token: "secret" } },
    { provider: "hetzner", id: "1" },
    { fetchImpl: api.fetch, sleep: async () => {} },
  );
  const plan = await client.plan("node-x");
  assert.equal(plan.resources.length, 6);
  assert.equal(
    api.calls.some((call) => call.method === "DELETE"),
    false,
  );
  for (const resource of plan.resources) await client.destroy(resource);
  assert.equal(api.calls.filter((call) => call.method === "DELETE").length, 6);
});
test("DigitalOcean deletes only the reviewed associated resource IDs and waits for job completion", async () => {
  const api = fakeApi(
    {
      "/droplets/1": { droplet: { id: 1 } },
      "/droplets/1/destroy_with_associated_resources": {
        reserved_ips: [{ id: "ip" }],
        snapshots: [{ id: "s" }],
        volumes: [{ id: "v" }],
        volume_snapshots: [{ id: "vs" }],
      },
      "/volumes/v": { volume: { droplet_ids: [1] } },
      "/firewalls": { firewalls: [] },
    },
    (key, data) => {
      if (key.endsWith("/selective")) {
        data.set("/droplets/1/destroy_with_associated_resources/status", {
          completed_at: "now",
          failures: 0,
          droplet: { id: 1 },
        });
        data.delete("/droplets/1");
      }
    },
  );
  const client = new CloudRemoval(
    { provider: "digitalocean", values: { token: "secret" } },
    { provider: "digitalocean", id: "1" },
    { fetchImpl: api.fetch, sleep: async () => {} },
  );
  const plan = await client.plan("node-x");
  for (const resource of plan.resources) await client.destroy(resource);
  const deletion = api.calls.find((call) => call.method === "DELETE");
  assert.deepEqual(JSON.parse(deletion.body), {
    reserved_ips: ["ip"],
    snapshots: ["s"],
    volume_snapshots: ["vs"],
    volumes: ["v"],
  });
});
test("Google removal verifies disk users and releases VM, persistent disks, snapshots and static IP", async () => {
  const base = "/projects/test-project",
    vm = base + "/zones/europe-west3-a/instances/vm",
    disk = base + "/zones/europe-west3-a/disks/data",
    url = (path) => "https://www.googleapis.com/compute/v1" + path;
  const api = fakeApi({
    [vm]: { id: "100", disks: [{ source: url(disk) }] },
    [disk]: { id: "2", users: [url(vm)] },
    [base + "/global/snapshots"]: {
      items: [{ id: "3", name: "snap", sourceDisk: url(disk) }],
    },
    [base + "/global/snapshots/snap"]: { id: "3" },
    [base + "/regions/europe-west3/addresses"]: {
      items: [{ id: "4", name: "address", users: [url(vm)] }],
    },
    [base + "/regions/europe-west3/addresses/address"]: { id: "4" },
  });
  const client = new CloudRemoval(
    { provider: "gcp", values: {} },
    {
      provider: "gcp",
      id: "100",
      name: "vm",
      project: "test-project",
      zone: "europe-west3-a",
    },
    { fetchImpl: api.fetch, sleep: async () => {} },
  );
  client.token = "test-token";
  const plan = await client.plan("node-x");
  assert.equal(plan.resources.length, 4);
  for (const resource of plan.resources) await client.destroy(resource);
  assert.equal(api.calls.filter((call) => call.method === "DELETE").length, 4);
});
test("Azure removal deletes only this VM's disks, interfaces, public IPs and snapshots", async () => {
  const subscription =
      "a".repeat(8) +
      "-" +
      "a".repeat(4) +
      "-" +
      "a".repeat(4) +
      "-" +
      "a".repeat(4) +
      "-" +
      "a".repeat(12),
    base = "/subscriptions/" + subscription,
    group = base + "/resourceGroups/test/providers/",
    vm = group + "Microsoft.Compute/virtualMachines/vm",
    disk = group + "Microsoft.Compute/disks/data",
    nic = group + "Microsoft.Network/networkInterfaces/nic",
    ip = group + "Microsoft.Network/publicIPAddresses/ip",
    snap = group + "Microsoft.Compute/snapshots/snap";
  const api = fakeApi({
    [vm]: {
      id: vm,
      properties: {
        vmId: "machine-id",
        storageProfile: { osDisk: { managedDisk: { id: disk } } },
        networkProfile: { networkInterfaces: [{ id: nic }] },
      },
    },
    [disk]: { id: disk, managedBy: vm, properties: {} },
    [nic]: {
      id: nic,
      properties: {
        virtualMachine: { id: vm },
        ipConfigurations: [{ properties: { publicIPAddress: { id: ip } } }],
      },
    },
    [ip]: {
      id: ip,
      properties: { ipConfiguration: { id: nic + "/ipConfigurations/main" } },
    },
    [base + "/providers/Microsoft.Compute/snapshots"]: {
      value: [
        { id: snap, properties: { creationData: { sourceResourceId: disk } } },
      ],
    },
    [snap]: { id: snap, properties: {} },
  });
  const client = new CloudRemoval(
    { provider: "azure", values: { subscriptionId: subscription } },
    { provider: "azure", id: vm, vmId: "machine-id", subscription },
    { fetchImpl: api.fetch, sleep: async () => {} },
  );
  client.token = "test-token";
  const plan = await client.plan("node-x");
  assert.equal(plan.resources.length, 5);
  for (const resource of plan.resources) await client.destroy(resource);
  assert.equal(api.calls.filter((call) => call.method === "DELETE").length, 5);
});
test("AWS removal verifies account and attachments before terminating and deleting retained resources", async () => {
  const calls = [],
    remaining = new Set(["instance", "volume", "snapshot", "address"]);
  const client = new CloudRemoval(
    { provider: "aws", values: {} },
    {
      provider: "aws",
      id: "i-123",
      accountId: "123456789012",
      region: "eu-central-1",
    },
    { sleep: async () => {} },
  );
  client.aws = async (action, params) => {
    calls.push({ action, params });
    if (action === "DescribeInstances") {
      const vm = {
        instanceId: "i-123",
        instanceState: {
          name: remaining.has("instance") ? "running" : "terminated",
        },
        blockDeviceMapping: { item: { ebs: { volumeId: "vol-1" } } },
      };
      return {
        reservationSet: {
          item: { ownerId: "123456789012", instancesSet: { item: vm } },
        },
      };
    }
    if (action === "DescribeVolumes")
      return {
        volumeSet: {
          item: remaining.has("volume")
            ? { attachmentSet: { item: { instanceId: "i-123" } } }
            : [],
        },
      };
    if (action === "DescribeSnapshots")
      return {
        snapshotSet: {
          item: remaining.has("snapshot") ? { snapshotId: "snap-1" } : [],
        },
      };
    if (action === "DescribeAddresses")
      return {
        addressesSet: {
          item: remaining.has("address") ? { allocationId: "eipalloc-1" } : [],
        },
      };
    remaining.delete(
      {
        TerminateInstances: "instance",
        DeleteVolume: "volume",
        DeleteSnapshot: "snapshot",
        ReleaseAddress: "address",
      }[action],
    );
    return {};
  };
  const plan = await client.plan("node-x");
  assert.equal(plan.resources.length, 4);
  for (const resource of plan.resources) await client.destroy(resource);
  assert.deepEqual(
    calls
      .filter((call) => !call.action.startsWith("Describe"))
      .map((call) => call.action),
    ["TerminateInstances", "DeleteVolume", "DeleteSnapshot", "ReleaseAddress"],
  );
});
test("AWS requests are signed and XML parsing rejects external entities", () => {
  const signed = awsSignature(
    {
      accessKeyId: "example",
      secretAccessKey: "secret",
      sessionToken: "session",
    },
    "eu-central-1",
    "Action=DescribeInstances",
    new Date("2026-11-17T12:00:00Z"),
  );
  assert.match(
    signed.headers.authorization,
    /Credential=example\/20261117\/eu-central-1\/ec2\/aws4_request/,
  );
  assert.equal(signed.headers["x-amz-security-token"], "session");
  assert.doesNotMatch(signed.headers.authorization, /secret/);
  assert.equal(
    parseXml("<Response><items><item>1</item><item>2</item></items></Response>")
      .Response.items.item.length,
    2,
  );
  assert.throws(() => parseXml("<!DOCTYPE x><Response/>"), /Invalid/);
});
test("the removal HTTP API requires a reviewed token and exact node name", async (t) => {
  const { root, nodes, id, calls } = fixture(t);
  const record = nodes.createNode(id, "sentry", "HTTP sentry");
  const scope = nodes.selectNode(id, "sentry", record.nodeId);
  scope.prepareSentry(id, "sentry.example.org");
  const { server, token } = createConsole(root, {
    runner: nodes.runner,
    fetchInvitation: async () => {
      throw new Error("Offline in this test");
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = "http://127.0.0.1:" + server.address().port;
  const call = (action, body) =>
    fetch(origin + "/api/" + action, {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id,
        role: "sentry",
        nodeId: record.nodeId,
        ...body,
      }),
    });
  assert.equal((await call("remove-node", {})).status, 400);
  const response = await call("remove-preview", {});
  assert.equal(response.status, 200);
  const review = await response.json();
  assert.equal(calls.length, 0);
  assert.equal(
    (
      await call("remove-node", {
        token: review.token,
        confirmation: "other node",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("remove-node", {
        token: review.token,
        confirmation: review.confirmation,
      })
    ).status,
    200,
  );
  assert.equal(calls.length, 1);
  assert.equal(nodes.inventory()[0].nodes.length, 0);
});
test("Google service-account authentication uses signed JWTs and the fixed OAuth endpoint", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const key = {
    type: "service_account",
    project_id: "service-project",
    client_email: "service@service-project.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    token_uri: "https://oauth2.googleapis.com/token",
  };
  let checked = false;
  const client = new CloudRemoval(
    { provider: "gcp", values: { serviceAccountJson: JSON.stringify(key) } },
    { provider: "gcp", project: "target-project" },
    {
      fetchImpl: async (url, opts) => {
        assert.equal(url, "https://oauth2.googleapis.com/token");
        const jwt = new URLSearchParams(opts.body).get("assertion");
        const parts = jwt.split(".");
        assert.equal(
          verify(
            "RSA-SHA256",
            Buffer.from(parts[0] + "." + parts[1]),
            publicKey,
            Buffer.from(parts[2], "base64url"),
          ),
          true,
        );
        assert.equal(
          JSON.parse(Buffer.from(parts[1], "base64url")).aud,
          "https://oauth2.googleapis.com/token",
        );
        checked = true;
        return Response.json({ access_token: "opaque-token" });
      },
    },
  );
  assert.equal(await client.accessToken(), "opaque-token");
  assert.equal(checked, true);
});
test("Azure authenticates only against the selected tenant and verifies the VM subscription", async () => {
  let calls = 0;
  const values = {
    tenantId: "tenant",
    clientId: "client",
    clientSecret: "secret",
    subscriptionId: "subscription",
  };
  const client = new CloudRemoval(
    { provider: "azure", values },
    { provider: "azure", subscription: "subscription" },
    {
      fetchImpl: async (url, opts) => {
        calls++;
        assert.equal(
          url,
          "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
        );
        assert.equal(
          new URLSearchParams(opts.body).get("scope"),
          "https://management.azure.com/.default",
        );
        return Response.json({ access_token: "opaque" });
      },
    },
  );
  assert.equal(await client.accessToken(), "opaque");
  assert.equal(calls, 1);
  const wrong = new CloudRemoval(
    { provider: "azure", values },
    { provider: "azure", subscription: "different" },
    {
      fetchImpl: async () => {
        throw new Error("Must not send credentials");
      },
    },
  );
  await assert.rejects(wrong.accessToken(), /subscription/);
});
test("a new disk or replacement VM prevents cloud deletion after review", async () => {
  const api = fakeApi({ "/servers/1": { server: { id: 1, volumes: [2] } } });
  const client = new CloudRemoval(
    { provider: "hetzner", values: { token: "secret" } },
    { provider: "hetzner", id: "1" },
    { fetchImpl: api.fetch },
  );
  const resource = client.resource("server", "1", "/servers/1", {
    guard: { volumes: ["2"] },
  });
  api.data.set("/servers/1", { server: { id: 1, volumes: [2, 3] } });
  await assert.rejects(client.destroy(resource), /attachments changed/);
  assert.equal(
    api.calls.some((call) => call.method === "DELETE"),
    false,
  );
  const base = "/projects/test-project/zones/us-central1-a/instances/vm";
  const google = fakeApi({ [base]: { id: "replacement" } });
  const gcp = new CloudRemoval(
    { provider: "gcp", values: {} },
    { provider: "gcp", project: "test-project" },
    { fetchImpl: google.fetch },
  );
  gcp.token = "opaque";
  await assert.rejects(
    gcp.destroy(gcp.resource("instance", "original", base)),
    /replaced/,
  );
  assert.equal(
    google.calls.some((call) => call.method === "DELETE"),
    false,
  );
});
test("symlinked node directories cannot cause deletion outside the workspace", async (t) => {
  const { root, nodes, id } = fixture(t);
  const record = nodes.createNode(id, "validator", "Symlink node"),
    scope = nodes.selectNode(id, "validator", record.nodeId);
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep"), "safe");
  fs.symlinkSync(outside, scope.dir(id, "validator"));
  assert.throws(() => scope.removalPlan(id, "validator"), /symbolic links/);
  assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "safe");
});
test("shared cloud hosts remove the selected remote runtime without deleting the VM", async (t) => {
  const { root, nodes, id } = fixture(t);
  const record = nodes.createNode(id, "validator", "Shared node"),
    scope = nodes.selectNode(id, "validator", record.nodeId);
  fs.writeFileSync(
    path.join(scope.nodeRoot(id), "validator-host.json"),
    JSON.stringify({
      kind: "cloud",
      installed: true,
      provider: "aws",
      address: "shared.example.org",
      port: 22,
    }),
  );
  const calls = [];
  const manager = new NodeRemoval(nodes, {
    makeHosts: (selected) => ({
      get: (i, r) => new Hosts(selected).get(i, r),
      removalRequest: async (i, r, action) => {
        calls.push(action);
        return action === "preview"
          ? { files: ["/remote/this-node"], fingerprint: "reviewed" }
          : { removed: true };
      },
    }),
    makeCloud: () => {
      throw new Error("Shared VM must never be deleted");
    },
  });
  const body = {
    id,
    role: "validator",
    nodeId: record.nodeId,
    sharedHost: true,
    deleteCloud: false,
  };
  const plan = await manager.preview(body);
  assert.equal(plan.resources.length, 0);
  assert.match(plan.retained.join(" "), /Shared cloud VM/);
  await manager.remove({
    ...body,
    token: plan.token,
    confirmation: plan.confirmation,
  });
  assert.deepEqual(calls, ["preview", "remove"]);
  assert.equal(nodes.inventory()[0].nodes.length, 0);
});
test(
  "real Docker cleanup removes only the selected project's containers, volumes and files",
  { skip: process.env.GRAPHENE_TEST_DOCKER !== "1" },
  async () => {
    const { docker } = await import("../participant/runtime.js");
    const { root, nodes, id } = fixture({ after() {} });
    nodes.runner = docker;
    const first = nodes.createNode(id, "sentry", "Docker remove"),
      second = nodes.createNode(id, "sentry", "Docker retain");
    const scopes = [first, second].map((record) =>
      nodes.selectNode(id, "sentry", record.nodeId),
    );
    try {
      for (const scope of scopes) {
        const dir = scope.dir(id, "sentry");
        fs.mkdirSync(path.join(dir, "data"), { recursive: true });
        fs.writeFileSync(path.join(dir, "data/owned"), "node data");
        fs.writeFileSync(
          path.join(dir, "compose.json"),
          JSON.stringify({
            services: {
              probe: {
                image: "nginx:1.28-alpine",
                volumes: ["./data:/node-data", "owned:/owned"],
              },
            },
            volumes: { owned: {} },
          }),
        );
        await docker(dir, scope.project(id, "sentry"), ["up", "-d"]);
      }
      const manager = new NodeRemoval(nodes),
        body = { id, role: "sentry", nodeId: first.nodeId };
      const plan = await manager.preview(body);
      await manager.remove({
        ...body,
        token: plan.token,
        confirmation: plan.confirmation,
      });
      assert.equal(fs.existsSync(scopes[0].nodeRoot(id)), false);
      const output = await docker(
        scopes[1].dir(id, "sentry"),
        scopes[1].project(id, "sentry"),
        ["ps", "--format", "json"],
      );
      assert.match(output, /running/);
      assert.equal(
        fs.existsSync(path.join(scopes[1].dir(id, "sentry"), "data/owned")),
        true,
      );
    } finally {
      for (const scope of scopes)
        if (fs.existsSync(path.join(scope.dir(id, "sentry"), "compose.json")))
          await docker(scope.dir(id, "sentry"), scope.project(id, "sentry"), [
            "down",
            "--volumes",
            "--remove-orphans",
          ]);
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
test("standalone SSH cleanup works without upgrading the remote runtime and is retryable", (t) => {
  const { root, nodes, id } = fixture(t);
  const remoteHome = path.join(root, "remote-home"),
    remote = new Participants(path.join(remoteHome, ".graphene/participants"));
  const raw = fs.readFileSync(nodes.invitationFile(id), "utf8");
  remote.import(raw, sha(raw));
  const first = remote.createNode(id, "validator", "Remote remove"),
    second = remote.createNode(id, "validator", "Remote keep");
  const scope = remote.selectNode(id, "validator", first.nodeId);
  fs.mkdirSync(scope.dir(id, "validator"), { recursive: true });
  fs.writeFileSync(
    path.join(scope.dir(id, "validator"), "private-owned"),
    "sensitive node data",
  );
  const source = fs.readFileSync(
    new URL("../participant/removal-files.js", import.meta.url),
    "utf8",
  );
  const invoke = (body) => {
    const result = __spawn(
      process.execPath,
      ["--input-type=module", "-e", source, "--", "--node-removal"],
      {
        input: JSON.stringify({
          id,
          role: "validator",
          nodeId: first.nodeId,
          ...body,
        }),
        env: { ...process.env, HOME: remoteHome },
        encoding: "utf8",
        timeout: 15000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const plan = invoke({ action: "preview" });
  assert.ok(plan.files.length);
  assert.match(
    invoke({ action: "remove", fingerprint: "wrong" }).error,
    /changed/,
  );
  assert.equal(fs.existsSync(scope.dir(id, "validator")), true);
  assert.equal(
    invoke({ action: "remove", fingerprint: plan.fingerprint }).removed,
    true,
  );
  assert.equal(
    invoke({ action: "remove", fingerprint: plan.fingerprint }).removed,
    true,
  );
  assert.equal(fs.existsSync(scope.nodeRoot(id)), false);
  assert.equal(
    fs.existsSync(
      remote.selectNode(id, "validator", second.nodeId).nodeRoot(id),
    ),
    true,
  );
});
test("metadata checks use only provider metadata paths and AWS IMDSv2", async () => {
  const { cloudMetadata } = await import("../participant/cloud-metadata.js");
  const calls = [];
  const aws = await cloudMetadata("aws", async (url, opts) => {
    calls.push({ url, opts });
    return new Response(
      url.endsWith("/api/token")
        ? "metadata-token"
        : JSON.stringify({
            instanceId: "i-abcdef123",
            region: "eu-central-1",
            accountId: "123456789012",
          }),
    );
  });
  assert.equal(aws.id, "i-abcdef123");
  assert.equal(calls[0].opts.method, "PUT");
  assert.equal(
    calls[1].opts.headers["X-aws-ec2-metadata-token"],
    "metadata-token",
  );
  assert.ok(
    calls.every((call) => call.url.startsWith("http://169.254.169.254/")),
  );
});

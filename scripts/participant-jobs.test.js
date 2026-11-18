import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { Jobs, jobContext, logOutput } from "../participant/jobs.js";
import { Participants } from "../participant/runtime.js";
import { createConsole } from "../participant/server.js";
import {
  filterJobs,
  activityView,
  jobType,
} from "../participant/ui/activity.js";
const temporary = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "participant-jobs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};
const sha = (value) => createHash("sha256").update(value).digest("hex");

test("jobs stream redacted output, persist results, and recover interrupted runs", async (t) => {
  const root = temporary(t),
    jobs = new Jobs(root);
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const running = jobs.start(
    { action: "logs", networkId: "network", nodeId: "server" },
    async () => {
      logOutput("line one\napi-token ");
      logOutput("split-");
      logOutput("secret\n");
      logOutput("-----BEGIN PRIVATE KEY-----\n");
      logOutput("hidden-key-material\n");
      logOutput("-----END PRIVATE KEY-----\n");
      await gate;
      return {
        text: "line two split-secret",
        password: "never persist",
        count: 1,
      };
    },
    { secrets: ["split-secret"] },
  );
  assert.equal(jobs.get(running.job.id).status, "running");
  assert.match(jobs.logs(running.job.id).text, /line one/);
  assert.doesNotMatch(
    jobs.logs(running.job.id).text,
    /split-secret|hidden-key-material/,
  );
  assert.throws(() => jobs.remove(running.job.id), /Running jobs/);
  finish();
  await running.promise;
  const reloaded = new Jobs(root),
    completed = reloaded.get(running.job.id);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.result.count, 1);
  assert.equal(completed.result.password, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(completed), /never persist|split-secret/);
  const orphan = {
    id: "a".repeat(24),
    action: "start",
    status: "running",
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(root, "jobs", orphan.id + ".json"),
    JSON.stringify(orphan),
  );
  assert.equal(new Jobs(root).get(orphan.id).status, "interrupted");
  const cancelled = jobs.start(
    { action: "stop" },
    () =>
      new Promise((resolve, reject) =>
        jobContext().signal.addEventListener("abort", () =>
          reject(new Error("Aborted")),
        ),
      ),
  );
  jobs.cancel(cancelled.job.id);
  await assert.rejects(cancelled.promise, /Aborted/);
  assert.equal(jobs.get(cancelled.job.id).status, "cancelled");
});

test("legacy activity migrates once and deleted records do not return after restart", (t) => {
  const root = temporary(t),
    line = JSON.stringify({
      id: "network",
      role: "validator",
      action: "start",
      ok: true,
      time: new Date().toISOString(),
    });
  fs.writeFileSync(path.join(root, "activity.jsonl"), line + "\n");
  const jobs = new Jobs(root),
    [record] = jobs.list();
  assert.equal(record.legacy, true);
  jobs.remove(record.id);
  assert.deepEqual(new Jobs(root).list(), []);
});

test("activity sorts and filters real jobs, keeps selected output across filters, and escapes server output", () => {
  const rows = [
    {
      id: "old",
      action: "logs",
      nodeId: "one",
      nodeName: "First server",
      role: "validator",
      status: "succeeded",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T00:01:00Z",
    },
    {
      id: "new",
      action: "inspect",
      nodeId: "two",
      nodeName: "Other server",
      role: "sentry",
      status: "running",
      startedAt: "2026-01-02T00:00:00Z",
    },
  ];
  const filters = {
    search: "",
    status: "all",
    type: "all",
    operation: "all",
    server: "all",
    sort: "newest",
  };
  assert.deepEqual(
    filterJobs(rows, filters).map((job) => job.id),
    ["new", "old"],
  );
  assert.deepEqual(
    filterJobs(rows, { ...filters, sort: "oldest" }).map((job) => job.id),
    ["old", "new"],
  );
  assert.equal(
    filterJobs(rows, { ...filters, status: "running" })[0].id,
    "new",
  );
  assert.equal(filterJobs(rows, { ...filters, server: "one" })[0].id, "old");
  assert.equal(jobType(rows[1]), "checks");
  const html = activityView({
    jobs: rows,
    nodes: [],
    networkId: "network",
    selected: "old",
    filters: { ...filters, status: "running" },
    log: { id: "old", text: "<script>unsafe</script>\nloaded output" },
  });
  assert.match(html, /selected run is outside these filters/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /Wrap lines/);
  assert.match(html, /Follow output/);
});

function networkFixture(root) {
  const genesis = JSON.stringify({
      chain_id: "graphene-dev-19876",
      validators: [{ address: "GENESIS", pub_key: { value: "signer" } }],
    }),
    file_hashes = { "genesis.json": sha(genesis) },
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
        (key) => [key, "example.org/node@sha256:" + "a".repeat(64)],
      ),
    ),
  });
  const nodes = new Participants(root);
  nodes.import(raw, sha(raw));
  nodes.prepareSentry(id, "sentry.example.org");
  return { id, nodes };
}

test("async API returns a running job before work finishes and exposes its own archived output", async (t) => {
  const root = temporary(t),
    { id, nodes } = networkFixture(root);
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const { server, token } = createConsole(root, {
    runner: async () => {
      logOutput("Server-specific live output\n");
      await gate;
      return JSON.stringify({
        Service: "node",
        State: "running",
        Health: "healthy",
      });
    },
    fetchInvitation: async () => {
      throw new Error("offline");
    },
    fetchCheckpoint: async () => {
      throw new Error("offline");
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = "http://127.0.0.1:" + server.address().port;
  const request = (route, options = {}) =>
    fetch(origin + "/api/" + route, {
      ...options,
      headers: {
        Authorization: "Bearer " + token,
        Origin: origin,
        ...options.headers,
      },
    });
  assert.equal((await fetch(origin + "/api/jobs")).status, 403);
  const response = await request("status", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "respond-async" },
    body: JSON.stringify({ id, role: "sentry" }),
  });
  assert.equal(response.status, 202);
  const { job } = await response.json();
  assert.equal(job.status, "running");
  const live = await (await request("jobs/" + job.id + "/logs")).json();
  assert.match(live.text, /Server-specific live output/);
  assert.equal(
    (await request("jobs/" + job.id, { method: "DELETE" })).status,
    400,
  );
  finish();
  let completed;
  for (let attempt = 0; attempt < 30; attempt++) {
    completed = await (await request("jobs/" + job.id)).json();
    if (completed.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.nodeId, "sentry");
  assert.equal(completed.host, "Local Docker Engine");
  const output = await (await request("jobs/" + job.id + "/logs")).json();
  assert.match(output.text, /running/);
  assert.equal(
    (await request("jobs/" + job.id, { method: "DELETE" })).status,
    200,
  );
  assert.equal(new Jobs(root).list().length, 0);
  await request("logs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, role: "sentry" }),
  });
  const archived = new Jobs(root),
    logsJob = archived.list().find((job) => job.action === "logs");
  assert.equal(
    (archived.logs(logsJob.id).text.match(/"Service":"node"/g) || []).length,
    1,
  );
});

test("server inspection reports host resources and service results without changing node state", async (t) => {
  const root = temporary(t),
    { id, nodes } = networkFixture(root);
  const calls = [];
  nodes.runner = async (dir, project, args) => {
    calls.push(args);
    if (args[0] === "ps")
      return JSON.stringify({ Service: "node", State: "running" });
    if (args[0] === "stats")
      return JSON.stringify({ Name: "node", CPUPerc: "1%" });
    throw new Error("Consensus unavailable");
  };
  const { inspectNode } = await import("../participant/inspection.js");
  const report = await inspectNode(nodes, id, "sentry");
  assert.ok(report.host.totalMemory > 0);
  assert.ok(report.host.disk.total > 0);
  assert.equal(report.checks.status.ok, true);
  assert.equal(report.checks.health.ok, false);
  assert.equal(report.checks.stats.ok, true);
  assert.ok(
    calls.every((args) => !["up", "stop", "restart", "down"].includes(args[0])),
  );
});

test("activity opens safely before the first job exists", () => {
  const filters = {
    search: "",
    status: "all",
    type: "all",
    operation: "all",
    server: "all",
    sort: "newest",
  };
  const html = activityView({ jobs: [], nodes: [], filters, log: null });
  assert.match(html, /No commands yet/);
  assert.match(html, /No run selected/);
});

test("upgrading older imported history does not duplicate records with a different legacy ID", (t) => {
  const root = temporary(t),
    old = {
      id: "network",
      role: "sentry",
      action: "start",
      ok: true,
      time: new Date().toISOString(),
      runId: "b".repeat(24),
    };
  fs.writeFileSync(
    path.join(root, "activity.jsonl"),
    JSON.stringify(old) + "\n",
  );
  fs.mkdirSync(path.join(root, "jobs"));
  const id = sha(JSON.stringify(old)).slice(0, 24);
  fs.writeFileSync(
    path.join(root, "jobs", id + ".json"),
    JSON.stringify({
      id,
      networkId: old.id,
      role: old.role,
      action: old.action,
      status: "succeeded",
      startedAt: old.time,
      endedAt: old.time,
      legacy: true,
    }),
  );
  assert.equal(new Jobs(root).list().length, 1);
});

test("cloud inspection sends a standalone compatible script through the existing SSH route", async () => {
  const { Hosts } = await import("../participant/hosts.js");
  const { spawnSync } = await import("node:child_process");
  const hosts = new Hosts({ selection: { nodeId: "node-" + "a".repeat(12) } });
  hosts.get = () => ({
    installed: true,
    kind: "cloud",
    runtime: ".graphene/join-runtimes/" + "b".repeat(64),
    address: "server.example.org",
  });
  hosts.ssh = async (host, command, input) => {
    const quoted = command.split(" -e ")[1];
    const script = quoted.slice(1, -1).split("'\\''").join("'");
    const syntax = spawnSync(
      process.execPath,
      ["--input-type=module", "--check"],
      { input: script, encoding: "utf8" },
    );
    assert.equal(syntax.status, 0, syntax.stderr);
    assert.doesNotMatch(script, /from ["']\.\/jobs\.js/);
    assert.match(script, /environmentSecrets/);
    assert.equal(JSON.parse(input).nodeId, "node-" + "a".repeat(12));
    return Buffer.from(
      JSON.stringify({ host: { hostname: host.address }, checks: {} }),
    );
  };
  assert.equal(
    (await hosts.inspect("network", "sentry")).host.hostname,
    "server.example.org",
  );
});

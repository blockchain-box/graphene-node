import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMemoryRouter } from "react-router-dom";
import {
  routePath,
  routeDefinitions,
  workspaceKey,
} from "../participant/ui/routes.js";
import { createConsole } from "../participant/server.js";

test("React Router matches workspace, node, setup, settings and run paths and restores Back/Forward", async (t) => {
  const run = "a".repeat(24),
    node = "node-" + "b".repeat(12);
  const activity = routePath({
    workspace: "workspace-dev",
    page: "activity",
    run,
  });
  assert.equal(activity, "/dev/activity/" + run);
  assert.equal(workspaceKey("test"), "workspace-test");
  const router = createMemoryRouter(
    routeDefinitions.map(([id, path]) => ({ id, path })),
    { initialEntries: [activity] },
  );
  t.after(() => router.dispose());
  assert.equal(router.state.matches.at(-1).params.run, run);
  const nodePath = routePath({
    workspace: "workspace-test",
    page: "validator",
    node,
    step: "monitor",
  });
  await router.navigate(nodePath);
  assert.deepEqual(router.state.matches.at(-1).params, {
    workspace: "test",
    node,
    step: "monitor",
  });
  await router.navigate(
    routePath({
      workspace: "workspace-prod",
      page: "settings",
      tab: "credentials",
    }),
  );
  assert.equal(router.state.matches.at(-1).params.tab, "credentials");
  await router.navigate(-1);
  assert.equal(router.state.location.pathname, nodePath);
  await router.navigate(1);
  assert.equal(router.state.location.pathname, "/prod/settings/credentials");
  assert.ok(!router.state.location.search);
});

test("the loopback server serves the browser application for deep links without swallowing API or asset errors", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "participant-routes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { server, token } = createConsole(root);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = "http://127.0.0.1:" + server.address().port;
  for (const url of [
    "/dev/health",
    "/test/settings/credentials",
    "/dev/activity/" + "c".repeat(24),
    "/prod/sentries/node-" + "d".repeat(12) + "/configuration",
  ]) {
    const response = await fetch(origin + url);
    assert.equal(response.status, 200, url);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(await response.text(), /router.bundle.js/);
  }
  const bundle = await fetch(origin + "/router.bundle.js");
  assert.equal(bundle.status, 200);
  assert.match(bundle.headers.get("content-type"), /javascript/);
  assert.equal((await fetch(origin + "/missing.js")).status, 404);
  assert.equal(
    (
      await fetch(origin + "/api/missing", {
        headers: { Authorization: "Bearer " + token },
      })
    ).status,
    404,
  );
});

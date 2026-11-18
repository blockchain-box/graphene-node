import { pages, routePath } from "../participant/ui/routes.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(
  new URL("../participant/ui/index.html", import.meta.url),
  "utf8",
);
const source = fs
  .readFileSync(new URL("../participant/ui/app.js", import.meta.url), "utf8")
  .replace(/^import[\s\S]*?;\n/gm, "");
function boot({ token = "a".repeat(64), hash = "", page = "settings" } = {}) {
  const elements = new Map();
  let focused;
  for (const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const following = html.slice(match.index + match[0].length);
    elements.set(match[1], {
      hidden: /\bhidden\b/.test(match[0]),
      textContent: following.split("<")[0],
      addEventListener() {},
      querySelectorAll: () => [],
      focus() {
        focused = match[1];
      },
    });
  }
  const storage = new Map(token ? [["participant-session", token]] : []);
  const local = new Map();
  const location = new URL(
    "http://127.0.0.1:8787" + routePath({ page }) + hash,
  );
  let complete, fail;
  const response = new Promise((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  const calls = [];
  const classes = new Set();
  const classList = {
    contains: (name) => classes.has(name),
    toggle: (name, enabled) => {
      const present = enabled === undefined ? !classes.has(name) : enabled;
      if (present) classes.add(name);
      else classes.delete(name);
      return present;
    },
  };
  let routeListener;
  let route = { page };
  const context = vm.createContext({
    pages,
    routePath,
    routeState: () => route,
    subscribeRoutes: (listener) => {
      routeListener = listener;
      return () => {};
    },
    navigatePath: () => {},
    navigateRoute: (next) => {
      route = next;
      location.pathname = routePath(next);
    },
    document: {
      getElementById: (id) => elements.get(id),
      documentElement: { classList },
      body: { classList },
      addEventListener() {},
    },
    window: { addEventListener() {} },
    location,
    history: {
      replaceState: (_state, _title, url) => {
        location.href = new URL(url, location).href;
      },
    },
    sessionStorage: {
      getItem: (key) => storage.get(key),
      setItem: (key, value) => storage.set(key, value),
    },
    localStorage: {
      getItem: (key) => local.get(key),
      setItem: (key, value) => local.set(key, value),
    },
    fetch: (...args) => {
      calls.push(args);
      return response;
    },
    URL,
    URLSearchParams,
    setInterval: () => 0,
  });
  vm.runInContext(source, context);
  return {
    elements,
    calls,
    classList,
    focused: () => focused,
    navigate: (page) => {
      route = { ...route, page };
      location.pathname = routePath(route);
      routeListener();
    },
    location,
    storage,
    heading: () =>
      elements.get("gate-title")?.textContent ||
      /<h1[^>]*>([^<]+)/.exec(html)[1],
    complete: async () => {
      complete({
        ok: true,
        json: async () => ({
          networks: [],
          workspaces: [],
          activity: [],
          cloudAccounts: { accounts: [] },
          defaultPage: "overview",
        }),
      });
      await new Promise(setImmediate);
    },
    fail: async () => {
      fail(new Error("Connection lost"));
      await new Promise(setImmediate);
    },
  };
}

test("refresh shows loading while the saved session loads, then opens the requested page", async () => {
  const app = boot();
  assert.match(
    app.heading(),
    /loading/i,
    "A refresh must not briefly tell a signed-in user to launch the console again",
  );
  assert.equal(app.elements.get("gate-help").hidden, true);
  assert.equal(app.elements.get("shell").hidden, true);
  await app.complete();
  assert.equal(app.elements.get("gate").hidden, true);
  assert.equal(app.elements.get("shell").hidden, false);
  assert.equal(app.elements.get("title").textContent, "Settings");
});

test("first launch consumes the fragment and keeps launcher help hidden while loading", async () => {
  const app = boot({ token: "", hash: "#" + "b".repeat(64) });
  assert.match(app.heading(), /loading/i);
  assert.equal(app.location.hash, "");
  assert.equal(app.storage.get("participant-session"), "b".repeat(64));
  await app.complete();
  assert.equal(app.elements.get("shell").hidden, false);
});

test("a missing session shows launcher instructions without requesting state", () => {
  const app = boot({ token: "" });
  assert.match(app.heading(), /open your node console/i);
  assert.equal(app.elements.get("gate-help").hidden, false);
  assert.equal(app.calls.length, 0);
});

test("an actual startup failure shows its error and a retry control", async () => {
  const app = boot();
  await app.fail();
  assert.match(app.heading(), /unable to load/i);
  assert.equal(app.elements.get("gate-error").textContent, "Connection lost");
  assert.equal(app.elements.get("gate-retry").hidden, false);
  assert.equal(app.elements.get("gate-retry").disabled, false);
  assert.equal(app.elements.get("shell").hidden, true);
});

test("router navigation closes the mobile menu and focuses the new page", async () => {
  const app = boot();
  await app.complete();
  app.elements.get("menu").onclick();
  assert.equal(app.classList.contains("nav-open"), true);
  app.navigate("overview");
  assert.equal(app.classList.contains("nav-open"), false);
  assert.equal(app.elements.get("scrim").hidden, true);
  assert.equal(app.elements.get("title").textContent, "Overview");
  assert.equal(app.focused(), "title");
});

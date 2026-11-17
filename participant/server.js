import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { enrollment, transaction } from "./enrollment.js";
import { Participants, check } from "./runtime.js";
import { Hosts } from "./hosts.js";
import { invitationFromUrl } from "./invitation-api.js";
import { PublicWorkspaces } from "./public-workspaces.js";
import { CloudAccounts } from "./cloud-accounts.js";
import { NodeRemoval } from "./removal.js";
import { PublicCheckpoints } from "./public-checkpoints.js";

const assets = {
  "/": ["index.html", "text/html"],
  "/app.js": ["app.js", "text/javascript"],
  "/progress.js": ["progress.js", "text/javascript"],
  "/deployment-steps.js": ["deployment-steps.js", "text/javascript"],
  "/styles.css": ["styles.css", "text/css"],
  "/graphene-logo.png": ["graphene-logo.png", "image/png"],
};
const icons = new Set([
  "home",
  "network",
  "server",
  "shield-check",
  "layers",
  "refresh-cw",
]);
export function createConsole(
  root,
  {
    token = randomBytes(32).toString("hex"),
    runner,
    defaultPage = "overview",
    fetchInvitation = invitationFromUrl,
    removalOptions = {},
    fetchCheckpoint,
  } = {},
) {
  const nodes = new Participants(root, runner);
  const hosts = new Hosts(nodes);
  const workspaces = new PublicWorkspaces(nodes, fetchInvitation);
  const checkpoints = new PublicCheckpoints(fetchCheckpoint);
  const cloudAccounts = new CloudAccounts(root);
  const removal = new NodeRemoval(nodes, { accounts: cloudAccounts, ...removalOptions });
  const activityFile = path.join(root, "activity.jsonl");
  let busy = false;
  function record(action, id, role, ok, nodeId) {
    fs.appendFileSync(
      activityFile,
      JSON.stringify({ time: new Date().toISOString(), action, id, role, ok, nodeId }) +
        "\n",
      { mode: 0o600 },
    );
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
    );
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const json = (code, value) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const host = "127.0.0.1:" + server.address().port;
    if (req.headers.host !== host)
      return json(403, {
        error: "Use the private loopback link printed by the launcher.",
      });
    const route = req.url.split("?")[0];
    if (req.method === "GET") {
      const icon = /^\/icons\/([a-z-]+)\.svg$/.exec(route);
      const asset = Object.hasOwn(assets, route) && assets[route];
      if (asset || (icon && icons.has(icon[1]))) {
        const file = asset
          ? new URL("./ui/" + asset[0], import.meta.url)
          : new URL(
              "./ui/icons/" + icon[1] + ".svg",
              import.meta.url,
            );
        res.writeHead(200, {
          "Content-Type": asset ? asset[1] : "image/svg+xml",
        });
        return res.end(fs.readFileSync(file));
      }
    }
    if (!route.startsWith("/api/")) return json(404, { error: "Not found" });
    if (
      req.headers.authorization !== "Bearer " + token ||
      ((req.method !== "GET" || req.headers.origin) &&
        req.headers.origin !== "http://" + host)
    )
      return json(403, {
        error: "Open the complete private link printed in your terminal.",
      });
    try {
      if (route === "/api/session" && req.method === "GET")
        return json(200, {
          format: "graphene-participant-console-v1",
          root: fs.realpathSync(root),
        });
      if (route === "/api/removal-status" && req.method === "GET") return json(200, { removals: removal.progress() });
      if (route === "/api/state" && req.method === "GET") {
        if (!busy) await workspaces.refresh();
        const activity = fs.existsSync(activityFile)
          ? fs
              .readFileSync(activityFile, "utf8")
              .trim()
              .split("\n")
              .filter(Boolean)
              .slice(-100)
              .map((x) => JSON.parse(x))
              .reverse()
          : [];
        const networks = await hosts.inventory();
        await Promise.all(networks.map(async network => {
          network.publicCheckpoint = checkpoints.summary(await checkpoints.lookup(nodes.network(network.id)));
          await Promise.all(network.nodes.map(async node => {
            node.publicCheckpoint = checkpoints.summary(await checkpoints.lookup(nodes.selectNode(network.id, node.role, node.nodeId).network(network.id)));
          }));
        }));
        return json(200, {
          networks,
          workspaces: workspaces.snapshot(),
          cloudAccounts: cloudAccounts.summary(),
          activity,
          busy,
          defaultPage,
        });
      }
      const action = route.slice(5);
      if (
        req.method !== "POST" ||
        ![
          "import",
          "import-url",
          "create-node",
          "workspace-refresh",
          "workspace-update",
          "cloud-account-save",
          "remove-preview",
          "remove-node",
          "ssh-generate",
          "ssh-trust",
          "sentry-invitation",
          "identity",
          "prepare-validator",
          "prepare-validator-public",
          "prepare-sentry",
          "host",
          "host-install",
          "connection",
          "review",
          "checkpoint-select",
          "checkpoint-current",
          "checkpoint-restore",
          "start",
          "stop",
          "status",
          "health",
          "logs",
          "enrollment",
          "register",
          "request-sentry",
        ].includes(action)
      )
        return json(404, { error: "Unknown console action" });
      check(
        req.headers["content-type"]?.split(";")[0] === "application/json",
        "Expected a JSON request.",
      );
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        check(
          size <= 8 * 1024 * 1024,
          "Invitation is too large (8 MiB maximum).",
        );
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (busy)
        return json(409, {
          error: "Another node operation is running. Wait for it to finish.",
        });
      busy = true;
      try {
        const scopedNodes = !["import", "import-url", "create-node", "workspace-refresh", "workspace-update", "cloud-account-save", "remove-preview", "remove-node"].includes(action)
          ? nodes.selectNode(body.id, body.role, body.nodeId) : nodes;
        const scopedHosts = new Hosts(scopedNodes);
        let id = body.id,
          role = body.role,
          result;
        if (action === "cloud-account-save") {
          result = cloudAccounts.save(body);
        } else if (action === "remove-preview") {
          result = await removal.preview(body);
        } else if (action === "remove-node") {
          result = await removal.remove(body);
        } else if (action === "workspace-update") {
          check(typeof body.workspace === "string", "Choose Dev, Test or Prod.");
          result = await workspaces.update(body.workspace, body.fingerprint);
        } else if (action === "workspace-refresh") {
          check(typeof body.workspace === "string", "Choose Dev, Test or Prod.");
          result = { workspaces: await workspaces.refresh(body.workspace, true) };
        } else if (action === "import" || action === "import-url") {
          id = nodes.import(
            action === "import-url"
              ? await invitationFromUrl(body.url)
              : body.raw,
            body.fingerprint,
          );
          result = { id };
        } else if (action === "create-node") {
          result = nodes.createNode(id, role, body.name);
        } else if (action === "ssh-generate") {
          result = await scopedHosts.generateSsh(id, role);
        } else if (action === "ssh-trust") {
          result = scopedHosts.trustSsh(id, role, body);
        } else if (action === "host") {
          result = await scopedHosts.save(id, role, body);
        } else if (action === "host-install") {
          result = await scopedHosts.install(id, role);
        } else if (action === "checkpoint-current") {
          const current = await checkpoints.lookup(scopedNodes.network(id), true);
          check(current.available, current.error);
          check(body.checkpointId === current.id && body.fingerprint === current.fingerprint,
            "The public checkpoint changed. Refresh and review the current checkpoint.");
          const selection = { ...body, raw:current.raw, fingerprint:current.fingerprint, baseUrl:current.baseUrl };
          result = scopedHosts.get(id, role).kind === "cloud"
            ? await scopedHosts.call(id, role, "checkpoint-select", selection)
            : scopedNodes.selectCheckpoint(id, role, current.raw, current.fingerprint, current.baseUrl);
        } else if (
          !["enrollment", "register", "request-sentry"].includes(action) &&
          scopedHosts.get(id, role).kind === "cloud"
        ) {
          if (["prepare-validator-public", "prepare-sentry"].includes(action) && scopedNodes.network(id).publicPeer)
            await scopedHosts.install(id, role);
          result = await scopedHosts.call(id, role, action, body);
        } else if (action === "identity") {
          role = "validator";
          scopedNodes.identity(id, body.operator, body.password);
        } else if (action === "prepare-validator") {
          role = "validator";
          scopedNodes.prepareValidator(id, body.bundle);
        } else if (action === "prepare-validator-public") {
          role = "validator";
          scopedNodes.prepareInvitedValidator(id);
        } else if (action === "prepare-sentry") {
          role = "sentry";
          scopedNodes.prepareSentry(id, body.address, body.peer, body);
        } else if (action === "connection") {
          result = scopedNodes.configureConnection(id, role, body.peer);
        } else if (action === "review") {
          result = scopedNodes.reviewDeployment(id, role);
        } else if (action === "sentry-invitation") {
          result = scopedNodes.sentryInvitation(id);
        } else if (action === "checkpoint-select") {
          result = scopedNodes.selectCheckpoint(
            id,
            role,
            body.raw,
            body.fingerprint,
            body.baseUrl,
          );
        } else if (action === "checkpoint-restore") {
          result = await scopedNodes.restore(id, role);
        } else if (
          ["enrollment", "register", "request-sentry"].includes(action)
        ) {
          role = "validator";
          const invite = scopedNodes.network(id),
            identity = (await scopedHosts.inventory())
              .find((n) => n.id === id)
              ?.nodes.find((n) => n.nodeId === (body.nodeId || role))?.identity;
          check(
            identity,
            "Create a validator identity on the selected host first.",
          );
          const state = await enrollment(invite, identity);
          result =
            action === "enrollment"
              ? state
              : transaction(invite, identity, state, action, body.amount);
        } else result = await scopedNodes.operate(id, role, action);
        if (
          ![
            "status",
            "health",
            "logs",
            "enrollment",
            "register",
            "request-sentry",
          ].includes(action)
        )
          record(action, id, role, true, result?.nodeId || body.nodeId);
        return json(200, result ?? { ok: true });
      } catch (error) {
        if (
          ![
            "status",
            "health",
            "logs",
            "enrollment",
            "register",
            "request-sentry",
          ].includes(action)
        )
          record(
            action,
            /^[a-f0-9]{64}$/.test(body.id) ? body.id : null,
            ["validator", "sentry"].includes(body.role) ? body.role : null,
            false,
            body.nodeId,
          );
        throw error;
      } finally {
        busy = false;
      }
    } catch (error) {
      return json(400, { error: error.message });
    }
  });
  return { server, token };
}
function openConsole(url) {
  if (process.env.GRAPHENE_NO_OPEN || process.env.SSH_CONNECTION) return;
  const child = spawn(
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer.exe"
        : "xdg-open",
    [url],
    { stdio: "ignore" },
  );
  child.on("error", () => {});
  child.unref();
}

async function existingConsole(root) {
  try {
    const file = path.join(root, ".console-session.json");
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.size > 4096) return null;
    const session = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      !Number.isInteger(session.port) ||
      session.port < 1 ||
      session.port > 65535 ||
      !/^[a-f0-9]{64}$/.test(session.token)
    )
      return null;
    const origin = "http://127.0.0.1:" + session.port;
    const response = await fetch(origin + "/api/session", {
      headers: { Authorization: "Bearer " + session.token },
      redirect: "error",
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const identity = await response.json();
    return identity.format === "graphene-participant-console-v1" &&
      identity.root === fs.realpathSync(root)
      ? origin + "/#" + session.token
      : null;
  } catch {
    return null;
  }
}

async function launchConsole() {
  const root = path.resolve(
    process.env.GRAPHENE_PARTICIPANT_DIR ||
      path.join(os.homedir(), ".graphene", "participants"),
  );
  const sentry = process.argv.includes("--sentry");
  const reuse = async () => {
    let url = await existingConsole(root);
    if (!url) return false;
    if (sentry) url = url.replace("/#", "/?page=sentry#");
    console.log(
      "Graphene participant console is already running — open this private link:\n" +
        url +
        "\nLocal node data: " +
        root,
    );
    openConsole(url);
    return true;
  };
  if (await reuse()) return;
  const { server, token } = createConsole(root, {
    defaultPage: sentry ? "sentry" : "overview",
  });
  const sessionFile = path.join(root, ".console-session.json");
  const port = Number(process.env.SETUP_PORT || 8787);
  check(
    Number.isInteger(port) && port >= 0 && port <= 65535,
    "SETUP_PORT must be a port number between 0 and 65535.",
  );
  server.on("error", async (e) => {
    // A concurrent launch may have finished binding while we were starting.
    if (e.code === "EADDRINUSE" && (await reuse())) return;
    console.error(
      e.code === "EADDRINUSE"
        ? "Console port " +
            port +
            " is in use by another process or an older launcher. Stop that console, or choose another port: SETUP_PORT=8788 npm start"
        : e.message,
    );
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    const url = "http://127.0.0.1:" + server.address().port + "/#" + token;
    const next = sessionFile + "." + token + ".tmp";
    try {
      fs.writeFileSync(
        next,
        JSON.stringify({ port: server.address().port, token }) + "\n",
        { mode: 0o600, flag: "wx" },
      );
      fs.renameSync(next, sessionFile);
    } catch (error) {
      server.close();
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    const cleanup = () => {
      try {
        if (JSON.parse(fs.readFileSync(sessionFile, "utf8")).token === token)
          fs.unlinkSync(sessionFile);
      } catch {
        /* An absent or newer session belongs to its own launcher. */
      }
    };
    server.once("close", cleanup);
    process.once("exit", cleanup);
    console.log(
      "Graphene participant console — open this private link on this computer:\n" +
        url +
        "\nLocal node data: " +
        root,
    );
    openConsole(url);
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  launchConsole().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

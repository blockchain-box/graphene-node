import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { enrollment, transaction } from "./enrollment.js";
import { Participants, check } from "./runtime.js";

const assets = {
  "/": ["index.html", "text/html"],
  "/app.js": ["app.js", "text/javascript"],
  "/progress.js": ["progress.js", "text/javascript"],
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
  } = {},
) {
  const nodes = new Participants(root, runner);
  const activityFile = path.join(root, "activity.jsonl");
  let busy = false;
  function record(action, id, role, ok) {
    fs.appendFileSync(
      activityFile,
      JSON.stringify({ time: new Date().toISOString(), action, id, role, ok }) +
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
              "../scripts/launcher-icons/" + icon[1] + ".svg",
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
      if (route === "/api/state" && req.method === "GET") {
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
        return json(200, {
          networks: nodes.inventory(),
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
          "identity",
          "prepare-validator",
          "prepare-sentry",
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
        let id = body.id,
          role = body.role,
          result;
        if (action === "import") {
          id = nodes.import(body.raw, body.fingerprint);
          result = { id };
        } else if (action === "identity") {
          role = "validator";
          nodes.identity(id, body.operator, body.password);
        } else if (action === "prepare-validator") {
          role = "validator";
          nodes.prepareValidator(id, body.bundle);
        } else if (action === "prepare-sentry") {
          role = "sentry";
          nodes.prepareSentry(id, body.address);
        } else if (
          ["enrollment", "register", "request-sentry"].includes(action)
        ) {
          role = "validator";
          const invite = nodes.network(id),
            identity = JSON.parse(
              fs.readFileSync(path.join(nodes.dir(id, role), "public.json")),
            );
          const state = await enrollment(invite, identity);
          result =
            action === "enrollment"
              ? state
              : transaction(invite, identity, state, action, body.amount);
        } else result = await nodes.operate(id, role, action);
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
          record(action, id, role, true);
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
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = path.resolve(
    process.env.GRAPHENE_PARTICIPANT_DIR ||
      path.join(os.homedir(), ".graphene", "participants"),
  );
  const sentry = process.argv.includes("--sentry");
  const { server, token } = createConsole(root, {
    defaultPage: sentry ? "sentry" : "overview",
  });
  server.on("error", (e) => {
    console.error(
      e.code === "EADDRINUSE"
        ? "The console port is in use. Open the existing terminal link, or close the old launcher first."
        : e.message,
    );
    process.exitCode = 1;
  });
  server.listen(Number(process.env.SETUP_PORT || 8787), "127.0.0.1", () => {
    const url = "http://127.0.0.1:" + server.address().port + "/#" + token;
    console.log(
      "Graphene participant console — open this private link on this computer:\n" +
        url +
        "\nLocal node data: " +
        root,
    );
    if (!process.env.GRAPHENE_NO_OPEN && !process.env.SSH_CONNECTION) {
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
  });
}

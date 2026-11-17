// The same prepared-host path as grph-deployment: explicit provider, strict SSH
// host trust, independent data directory, then install/monitor the pinned runtime.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { check } from "./runtime.js";

export const providers = [
  "hetzner",
  "aws",
  "gcp",
  "azure",
  "digitalocean",
  "other",
];
const source = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
function run(command, args, input, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const output = [],
      errors = [];
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 12 * 1024 * 1024) child.kill("SIGTERM");
      else output.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      errors.push(chunk);
      if (errors.length > 30) errors.shift();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(output));
      else {
        const detail = Buffer.concat(errors).toString();
        reject(
          new Error(
            "Host operation failed: " +
              (detail.length > 2200
                ? detail.slice(0, 1400) + "\n…\n" + detail.slice(-800)
                : detail),
          ),
        );
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
export class Hosts {
  constructor(nodes) {
    this.nodes = nodes;
  }
  file(id, role) {
    this.nodes.network(id);
    this.nodes.dir(id, role);
    return path.join(this.nodes.nodeRoot(id), role + "-host.json");
  }
  get(id, role) {
    const file = this.file(id, role);
    return fs.existsSync(file) ? read(file) : { kind: "local" };
  }
  async cloudIdentity(id, role) {
    const host = this.get(id, role);
    check(host.kind === "cloud", "Select a cloud node.");
    const script = fs.readFileSync(new URL("./cloud-metadata.js", import.meta.url), "utf8");
    const result = await this.ssh(host, "node --input-type=module -e " + quote(script) + " -- --cloud-metadata",
      JSON.stringify({ provider: host.provider, id, role, nodeId: this.nodes.selection?.nodeId || role }), 60000);
    const identity = JSON.parse(result.toString());
    check(!identity.error, identity.error);
    return identity;
  }
  async removalRequest(id, role, action, fingerprint) {
    const host=this.get(id,role);
    check(host.kind === "cloud", "Select a cloud node.");
    const script=fs.readFileSync(new URL("./removal-files.js",import.meta.url),"utf8");
    const result=await this.ssh(host,"node --input-type=module -e "+quote(script)+" -- --node-removal",JSON.stringify({action,id,role,nodeId:this.nodes.selection?.nodeId||role,fingerprint}),180000);
    const value=JSON.parse(result.toString());check(!value.error,value.error);return value;
  }
  ssh(host, command, input, timeout) {
    return run(
      "ssh",
      [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "ForwardAgent=no",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "PermitLocalCommand=no",
        "-o",
        "ServerAliveInterval=20",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "UserKnownHostsFile=" + host.knownHosts,
        "-i",
        host.key,
        "-p",
        String(host.port),
        host.user + "@" + host.address,
        command,
      ],
      input,
      timeout,
    );
  }
  async generateSsh(id, role) {
    this.file(id, role);
    const folder = path.join(this.nodes.nodeRoot(id), "ssh", role);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const key = path.join(folder, "id_ed25519");
    if (!fs.existsSync(key)) {
      check(
        !fs.existsSync(key + ".pub"),
        "Restore the matching private key or choose an existing key path.",
      );
      await run("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        "graphene-participant-" + role,
        "-f",
        key,
      ]);
    }
    return {
      privateKeyPath: key,
      publicKey: fs.readFileSync(key + ".pub", "utf8").trim(),
    };
  }
  trustSsh(id, role, body) {
    this.file(id, role);
    check(
      /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(body.address || ""),
      "Enter the SSH host first.",
    );
    const port = Number(body.port || 22);
    check(
      Number.isInteger(port) && port > 0 && port <= 65535,
      "Enter a valid SSH port.",
    );
    const parts = (body.hostPublicKey || "").trim().split(/\s+/),
      bytes = Buffer.from(parts[1] || "", "base64");
    check(
      parts[0] === "ssh-ed25519" &&
        bytes.length === 51 &&
        bytes.readUInt32BE(0) === 11 &&
        bytes.subarray(4, 15).toString() === "ssh-ed25519" &&
        bytes.readUInt32BE(15) === 32,
      "Paste the independently verified ssh-ed25519 public host key.",
    );
    const folder = path.join(this.nodes.nodeRoot(id), "ssh", role);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const pin = parts[0] + " " + parts[1],
      name = port === 22 ? body.address : "[" + body.address + "]:" + port;
    const file = path.join(
      folder,
      "known_hosts-" +
        createHash("sha256")
          .update(name + pin)
          .digest("hex")
          .slice(0, 16),
    );
    fs.writeFileSync(file, name + " " + pin + "\n", { mode: 0o600 });
    return {
      knownHosts: file,
      fingerprint:
        "SHA256:" +
        createHash("sha256").update(bytes).digest("base64").replace(/=+$/, ""),
    };
  }
  async save(id, role, body) {
    const previous = this.get(id, role);
    check(
      !previous.installed && !fs.existsSync(this.nodes.dir(id, role)),
      "Host selection is bound once an identity exists. Use its original host.",
    );
    let host = { kind: "local", configured: true };
    if (body.kind !== "local") {
      check(
        body.kind === "cloud" && providers.includes(body.provider),
        "Choose a local host or cloud provider.",
      );
      check(
        typeof body.address === "string" &&
          /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(body.address),
        "Enter an SSH hostname or configured SSH alias.",
      );
      check(
        /^[a-z_][a-z0-9_-]{0,31}$/.test(body.user || ""),
        "Enter the remote Linux user.",
      );
      const port = Number(body.port || 22);
      check(
        Number.isInteger(port) && port > 0 && port <= 65535,
        "Enter a valid SSH port.",
      );
      for (const name of ["key", "knownHosts"])
        check(
          typeof body[name] === "string" &&
            path.isAbsolute(body[name]) &&
            fs.statSync(body[name]).isFile(),
          "Choose an absolute existing " + name + " file on this computer.",
        );
      host = {
        kind: "cloud",
        configured: true,
        provider: body.provider,
        address: body.address,
        user: body.user,
        port,
        key: body.key,
        knownHosts: body.knownHosts,
      };
      // Read-only preflight: never install software merely by saving a connection.
      const facts = JSON.parse(
        (
          await this.ssh(
            host,
            "node -e 'process.stdout.write(JSON.stringify({node:process.versions.node,platform:process.platform}))'",
          )
        ).toString(),
      );
      check(
        facts.platform === "linux" && Number(facts.node.split(".")[0]) >= 24,
        "Prepare a Linux cloud host with Node.js 24+, npm, Python 3 and Docker Compose.",
      );
    }
    const file = this.file(id, role),
      temp = file + "." + randomBytes(6).toString("hex");
    fs.writeFileSync(temp, JSON.stringify(host) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temp, file);
    return { kind: host.kind };
  }
  async install(id, role) {
    const host = this.get(id, role);
    check(host.kind === "cloud", "Choose a cloud host first.");
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "graphene-join-runtime-"),
    );
    try {
      const files = read(new URL("./kit-files.json", import.meta.url));
      for (const file of files) {
        check(
          !file.includes("..") && !path.isAbsolute(file),
          "Invalid runtime allowlist.",
        );
        const from = path.join(source, file),
          to = path.join(temporary, file);
        check(
          fs.statSync(from).isFile() && !fs.lstatSync(from).isSymbolicLink(),
          "Missing bundled runtime: " + file,
        );
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
      }
      fs.copyFileSync(
        new URL("./runtime-package.json", import.meta.url),
        path.join(temporary, "package.json"),
      );
      fs.copyFileSync(
        new URL("./runtime-package-lock.json", import.meta.url),
        path.join(temporary, "package-lock.json"),
      );
      const archive = await run("tar", ["-czf", "-", "-C", temporary, "."]);
      const revision = createHash("sha256").update(archive).digest("hex");
      // The path is content-specific. Never replace an existing running console.
      const runtime = ".graphene/join-runtimes/" + revision;
      const command =
        'set -eu; umask 077; mkdir -p "$HOME"/' +
        quote(runtime) +
        '; cd "$HOME"/' +
        quote(runtime) +
        "; tar -xzf -; node --version >&2; npm ci --ignore-scripts --no-audit --no-fund >&2; python3 --version >&2; docker compose version >&2";
      await this.ssh(host, command, archive, 600000);
      const raw = JSON.stringify(this.nodes.network(id));
      const imported = JSON.parse(
        (
          await this.ssh(
            host,
            'cd "$HOME"/' +
              quote(runtime) +
              " && node participant/remote-worker.js",
            JSON.stringify({
              action: "import",
              body: {
                id,
                role,
                nodeId: this.nodes.selection?.nodeId,
                name: this.nodes.selection?.name,
                updateInvitation: true,
                raw,
                fingerprint: createHash("sha256").update(raw).digest("hex"),
              },
            }),
          )
        ).toString(),
      );
      check(!imported.error, imported.error);
      host.runtime = runtime;
      host.installed = true;
      const hostFile = this.file(id, role),
        next = hostFile + "." + randomBytes(6).toString("hex");
      fs.writeFileSync(next, JSON.stringify(host) + "\n", {
        mode: 0o600,
      });
      fs.renameSync(next, hostFile);
      return { ok: true };
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  async call(id, role, action, body = {}) {
    const host = this.get(id, role);
    check(
      host.installed &&
        /^\.graphene\/join-runtimes\/[a-f0-9]{64}$/.test(host.runtime),
      "Install the participant runtime on this cloud host first.",
    );
    if (action === "prepare-validator") {
      check(
        path.isAbsolute(body.bundle || ""),
        "Enter the absolute local admission-bundle folder.",
      );
      body = {
        ...body,
        files: Object.fromEntries(
          [
            "validator-admission.json",
            "compose.json",
            "network.json",
            "tunnel-policy.json",
            "identity/tendermint/config/config.toml",
            "identity/tendermint/config/genesis.json",
          ].map((file) => {
            const absolute = path.join(body.bundle, file),
              root = fs.realpathSync(body.bundle);
            check(
              fs.realpathSync(absolute) === path.join(root, file) &&
                fs.statSync(absolute).size < 8 * 1024 * 1024,
              "Choose regular public admission files.",
            );
            return [file, fs.readFileSync(absolute, "utf8")];
          }),
        ),
      };
      delete body.bundle;
    }
    const result = await this.ssh(
      host,
      'cd "$HOME"/' +
        quote(host.runtime) +
        " && node participant/remote-worker.js",
      JSON.stringify({ action, body: { ...body, id, role, nodeId: this.nodes.selection?.nodeId } }),
      action === "checkpoint-restore" ? 3600000 : 600000,
    );
    const value = JSON.parse(result.toString());
    check(!value.error, value.error);
    return value;
  }
  async inventory() {
    const networks = this.nodes.inventory();
    await Promise.all(
      networks.flatMap((network) =>
        this.nodes.deployments(network.id).map(async ({ nodeId, role, name }) => {
          const scoped = new Hosts(this.nodes.selectNode(network.id, role, nodeId));
          const host = scoped.get(network.id, role);
          network.hosts ||= {};
          network.hosts[nodeId] = host;
          if (host.kind !== "cloud" || !host.installed) return;
          try {
            const result = await scoped.call(network.id, role, "inventory");
            const remote = result
              .find((n) => n.id === network.id)
              ?.nodes.find((n) => n.nodeId === nodeId || (nodeId === role && !n.nodeId && n.role === role));
            network.nodes = network.nodes.filter((n) => n.nodeId !== nodeId);
            if (remote) network.nodes.push({ ...remote, nodeId, role, name });
          } catch (error) {
            network.hosts[nodeId] = { ...host, error: error.message };
          }
        }),
      ),
    );
    return networks;
  }
}

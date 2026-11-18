import { planNodeFiles, removedNodeReceipt, deleteNodeFiles } from "./removal-files.js";
import fs from "node:fs";
import { jobContext, logOutput } from "./jobs.js";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { isIPv4 } from "node:net";
import { hostname, peerAddress, directConnection, publicSentryConfig } from "./connections.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isDeepStrictEqual } from "node:util";
import {
  initializeValidator,
  installValidatorFiles,
  writeValidatorReceipt,
} from "../agents/lib/validator-files.js";
import {
  generateTendermintNodeKey,
  generateTendermintValidatorKey,
} from "../agents/validator-agent/src/keygen.js";

import { verifySelection, restoreCheckpoint } from "./checkpoint.js";
import nacl from "tweetnacl";
import z32 from "z32";
const exec = promisify(execFile);
export const check = (v, message) => {
  if (!v) throw new Error(message);
};
const sha = (data) => createHash("sha256").update(data).digest("hex");
const hex = /^[a-f0-9]{64}$/;
const pin = /^[^\s$]+@sha256:[a-f0-9]{64}$/;
const roles = ["validator", "sentry"];
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    file,
    typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
}
// Never execute a Compose document supplied in an invitation. Map only pinned
// image references and the chain binding onto the kit's fixed service topology.
const homeTemplate = read(new URL("./validator-compose.json", import.meta.url));
export function homeCompose(invite) {
  const c = structuredClone(homeTemplate);
  c.name = "graphene-" + invite.network.stage;
  for (const svc of Object.values(c.services))
    svc.image = invite.images[svc.image];
  c.services.abci.environment.CHAIN_ID = String(invite.network.chain_id);
  c.services.abci.environment.GENESIS_STAGE =
    invite.network.stage === "dev" ? "dev" : "prod";
  return c;
}
export function validateInvitation(raw, fingerprint) {
  check(
    typeof raw === "string" && sha(raw) === fingerprint,
    "The file does not match the invitation SHA-256.",
  );
  const invite = JSON.parse(raw),
    n = invite.network;
  check(
    invite.format === "graphene-join-v1" &&
      ["dev", "staging", "production"].includes(n?.stage) &&
      Number.isSafeInteger(n.chain_id) &&
      n.chain_id > 0 &&
      hex.test(n.network_id),
    "Choose a Graphene network invitation.",
  );
  const rpc = new URL(invite.rpc);
  check(
    rpc.protocol === "https:" &&
      !rpc.username &&
      !rpc.password &&
      rpc.pathname === "/graphene-evm/rpc" &&
      !rpc.search &&
      !rpc.hash &&
      /^0x[a-f0-9]{40}$/.test(invite.sentryId),
    "Invalid public enrollment endpoint or sentry address.",
  );
  const hashes = n.file_hashes;
  check(
    sha(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(hashes).sort(([a], [b]) => (a < b ? -1 : 1)),
        ),
      ),
    ) === n.network_id && sha(invite.genesis) === hashes["genesis.json"],
    "Network or genesis checksum mismatch.",
  );
  const genesis = JSON.parse(invite.genesis);
  check(
    genesis.chain_id === "graphene-" + n.stage + "-" + n.chain_id &&
      genesis.validators?.length > 0,
    "Invitation is missing the frozen chain.",
  );
  if (invite.publicPeer !== undefined) peerAddress(invite.publicPeer);
  if (invite.checkpoint !== undefined) {
    const checkpoint = new URL(invite.checkpoint.url);
    check(checkpoint.protocol === "https:" && checkpoint.origin === rpc.origin &&
      checkpoint.pathname === "/checkpoints/latest.json" && !checkpoint.username &&
      !checkpoint.password && !checkpoint.search && !checkpoint.hash &&
      hex.test(invite.checkpoint.fingerprint || ""), "Invalid public checkpoint endpoint or publisher.");
  }
  const peer = /^([a-f0-9]{40})@([0-9.]+):26656$/.exec(invite.peer);
  check(
    (Object.hasOwn(hashes, "peer-transport.json")
      ? /^[a-f0-9]{40}$/.test(invite.peer)
      : peer && isIPv4(peer[2])) &&
      typeof invite.release === "string" &&
      invite.release.length &&
      typeof invite.config === "string",
    "Invalid deployment release or primary peer.",
  );
  check(
    invite.images &&
      ["abci", "postgres", "mpt", "tendermint", "transport", "nginx"].every(
        (k) =>
          typeof invite.images[k] === "string" && pin.test(invite.images[k]),
      ),
    "Expected the pinned runtime for this chain.",
  );
  if (invite.tunnelPolicy !== undefined) {
    check(
      /^[ybndrfg8ejkmcpqxot1uwisza345h769]{51}[yo]$/.test(
        invite.tunnelPolicy?.allowed_peer,
      ) &&
        (invite.tunnelPolicy.bootstrap === null ||
          (Array.isArray(invite.tunnelPolicy.bootstrap) &&
            invite.tunnelPolicy.bootstrap.every((b) => typeof b === "string"))),
      "Invalid primary tunnel policy.",
    );
  }
  if (
    Object.hasOwn(hashes, "peer-transport.json") ||
    invite.privateTransport !== undefined
  ) {
    check(
      typeof invite.privateTransport === "string" &&
        sha(invite.privateTransport) === hashes["peer-transport.json"],
      "Private transport checksum mismatch.",
    );
    const binding = JSON.parse(invite.privateTransport);
    check(
      binding.transport === "grph-noise-v1" &&
        invite.tunnelPolicy &&
        binding.primary_tunnel_key === invite.tunnelPolicy.allowed_peer,
      "Primary tunnel key differs from the frozen network.",
    );
  }
  return invite;
}
function runDocker(command, args, options) {
  logOutput("docker compose " + args.slice(5).join(" ") + "\n");
  return new Promise((resolve, reject) => {
    const child = execFile(command,args,{...options,signal:jobContext()?.signal},(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr}));
    child.stdout?.on("data", text=>{if(jobContext())jobContext().outputCaptured=true;logOutput(text);});
    child.stderr?.on("data", logOutput);
  });
}
export async function docker(directory, project, args) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      key.startsWith("COMPOSE_") ||
      ["ABCI_DB_PASSWORD", "ABCI_ADMIN_PASSWORD", "MPT_DB_API_TOKEN"].includes(
        key,
      )
    )
      delete env[key];
  const options = {
    cwd: directory,
    signal: jobContext()?.signal,
    env,
    timeout: 600000,
    maxBuffer: 1024 * 1024,
  };
  try {
    // Bind mounts and signing state belong to this machine.
    const endpoint =
      (!env.DOCKER_CONTEXT && env.DOCKER_HOST) ||
      (
        await exec(
          "docker",
          ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
          options,
        )
      ).stdout.trim();
    check(
      /^(unix:\/\/\/|npipe:\/\/\/)/.test(endpoint),
      "Select a local Docker engine.",
    );
    // Run against the exact socket we checked, even if the user's active context changes.
    delete env.DOCKER_CONTEXT;
    env.DOCKER_HOST = endpoint;
    return (
      await runDocker(
        "docker",
        [
          "compose",
          "--project-name",
          project,
          "--file",
          "compose.json",
          ...args,
        ],
        options,
      )
    ).stdout;
  } catch (err) {
    throw new Error(
      err.code === "ENOENT"
        ? "Install Docker with Compose and start its local engine."
        : (err.stderr || err.message).trim().slice(-1500),
    );
  }
}

export class Participants {
  constructor(root, runner = docker, selection = null) {
    this.root = root;
    this.runner = runner;
    this.selection = selection;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  network(id) {
    check(
      typeof id === "string" && hex.test(id),
      "Select an imported network.",
    );
    const pinned = read(this.invitationFile(id));
    if (this.selection && !pinned.publicPeer) {
      const file = path.join(this.nodeRoot(id), this.selection.role, "connection.json");
      const connection = fs.existsSync(file) ? read(file) : null;
      if (connection?.mode === "public")
        return { ...pinned, publicPeer:peerAddress(connection.peer) };
    }
    // Unprepared identities may adopt a newly published route without changing
    // their pinned release, genesis or keys. Prepared deployments keep their route.
    if (this.selection && !pinned.publicPeer &&
        !fs.existsSync(path.join(this.nodeRoot(id), this.selection.role, "prepared"))) {
      const latest = read(path.join(this.root, id, "invitation.json"));
      const stable = ({ publicPeer, checkpoint, ...value }) => value;
      if (latest.publicPeer && isDeepStrictEqual(stable(pinned), stable(latest)))
        return { ...pinned, publicPeer:latest.publicPeer };
    }
    return pinned;
  }
  invitationFile(id) {
    check(typeof id === "string" && hex.test(id), "Select an imported network.");
    if (this.selection?.networkId === id) {
      const snapshot = path.join(this.root, id, "node-invitations", this.selection.nodeId + ".json");
      if (fs.existsSync(snapshot)) return snapshot;
    }
    return path.join(this.root, id, "invitation.json");
  }
  dir(id, role) {
    check(roles.includes(role) && hex.test(id), "Unknown node or network.");
    check(!this.selection || (this.selection.networkId === id && this.selection.role === role), "This node belongs to another network or role.");
    return path.join(this.nodeRoot(id), role);
  }
  nodeRoot(id) {
    check(hex.test(id), "Select an imported network.");
    return this.selection && !this.selection.legacy ? path.join(this.root, id, "instances", this.selection.nodeId) : path.join(this.root, id);
  }
  deployments(id) {
    this.network(id);
    const directory = path.join(this.root, id, "node-records");
    return [
      ...roles.map((role) => ({ nodeId: role, role, name: role === "validator" ? "Validator" : "Sentry" })),
      ...(fs.existsSync(directory) ? fs.readdirSync(directory).filter((file) => /^node-[a-f0-9]{12}\.json$/.test(file)).map((file) => read(path.join(directory, file))) : []),
    ].filter((record) => !this.selection || record.nodeId === this.selection.nodeId);
  }
  selectNode(id, role, nodeId) {
    this.network(id);
    check(roles.includes(role), "Choose a validator or sentry.");
    if (nodeId === undefined || nodeId === role) return new Participants(this.root, this.runner, { networkId: id, nodeId: role, role, legacy: true });
    check(typeof nodeId === "string" && /^node-[a-f0-9]{12}$/.test(nodeId), "Choose a valid node.");
    const file = path.join(this.root, id, "node-records", nodeId + ".json");
    check(fs.existsSync(file), "Node not found in this network.");
    const record = read(file);
    check(record.nodeId === nodeId && record.role === role, "This node belongs to another role.");
    return new Participants(this.root, this.runner, { ...record, networkId: id });
  }
  createNode(id, role, name, nodeId = "node-" + randomBytes(6).toString("hex")) {
    this.network(id);
    check(roles.includes(role), "Choose a validator or sentry.");
    check(typeof name === "string" && name.trim().length > 0 && name.trim().length <= 80 && !/[\x00-\x1f]/.test(name), "Enter a node name of 1–80 characters.");
    check(/^node-[a-f0-9]{12}$/.test(nodeId), "Choose a valid node.");
    const record = { nodeId, role, name: name.trim() };
    const file = path.join(this.root, id, "node-records", nodeId + ".json");
    if (fs.existsSync(file)) {
      check(isDeepStrictEqual(read(file), record), "This node ID is already bound to another deployment.");
      return record;
    }
    check(!this.deployments(id).some((node) => node.role === role && node.name.toLowerCase() === record.name.toLowerCase()), "Choose a unique name for this node role.");
    fs.mkdirSync(path.join(this.root, id, "instances", nodeId), { recursive: true, mode: 0o700 });
    const snapshot = path.join(this.root, id, "node-invitations", nodeId + ".json");
    if (!fs.existsSync(snapshot)) write(snapshot, fs.readFileSync(path.join(this.root, id, "invitation.json"), "utf8"));
    write(file, record);
    return record;
  }
  updateInvitation(raw, fingerprint, expectedFingerprint) {
    const invitation = validateInvitation(raw, fingerprint);
    const id = invitation.network.network_id;
    const file = path.join(this.root, id, "invitation.json");
    check(fs.existsSync(file), "Fetch the network before updating it.");
    const previous = fs.readFileSync(file, "utf8");
    check(sha(previous) === expectedFingerprint, "The installed invitation changed. Refresh before updating.");
    check(isDeepStrictEqual(JSON.parse(previous).network, invitation.network), "An update cannot replace the frozen network or genesis.");
    const catalog = new Participants(this.root, this.runner);
    for (const record of catalog.deployments(id)) {
      const scope = catalog.selectNode(id, record.role, record.nodeId);
      if (!fs.existsSync(scope.dir(id, record.role)) && !fs.existsSync(path.join(scope.nodeRoot(id), record.role + "-host.json")) && record.nodeId === record.role) continue;
      const snapshot = path.join(this.root, id, "node-invitations", record.nodeId + ".json");
      if (!fs.existsSync(snapshot)) write(snapshot, previous);
    }
    const history = path.join(this.root, id, "invitation-history", sha(previous) + ".json");
    if (!fs.existsSync(history)) write(history, previous);
    const temporary = file + "." + randomBytes(8).toString("hex");
    write(temporary, raw);
    fs.renameSync(temporary, file);
    return id;
  }
  removalPlan(id, role) {
    this.network(id);
    return planNodeFiles(this.root,id,role,this.selection?.nodeId||role);
  }
  removedReceipt(id, role, nodeId, fingerprint) {
    return removedNodeReceipt(this.root,id,role,nodeId,fingerprint);
  }
  async removeNode(id, role, fingerprint, options = {}) {
    return deleteNodeFiles(this.root,id,role,this.selection?.nodeId||role,fingerprint,{runner:this.runner,...options});
  }

  import(raw, fingerprint) {
    const invite = validateInvitation(raw, fingerprint);
    const id = invite.network.network_id,
      file = path.join(this.root, id, "invitation.json");
    if (fs.existsSync(file)) {
      const old = fs.readFileSync(file, "utf8");
      if (sha(old) !== fingerprint) {
        const { tunnelPolicy, ...previousFormat } = invite;
        const withoutPeer = (value) => {
          const { publicPeer, ...stable } = value;
          return stable;
        };
        check(
          (tunnelPolicy &&
            isDeepStrictEqual(JSON.parse(old), previousFormat)) ||
            isDeepStrictEqual(
              withoutPeer(JSON.parse(old)),
              withoutPeer(invite),
            ),
          "A different invitation for this network is already installed. Keep the existing release and node data.",
        );
        const next = file + "." + randomBytes(8).toString("hex");
        write(next, raw);
        fs.renameSync(next, file);
      }
    } else write(file, raw);
    return id;
  }
  inventory() {
    return fs
      .readdirSync(this.root)
      .filter(
        (id) =>
          (!this.selection || this.selection.networkId === id) &&
          hex.test(id) &&
          fs.existsSync(path.join(this.root, id, "invitation.json")),
      )
      .map((id) => {
        const {
          network,
          release,
          peer,
          rpc,
          sentryId,
          privateTransport,
          publicPeer,
        } = this.network(id);
        return {
          id,
          privatePeers: Boolean(privateTransport),
          publicPeer: publicPeer || (!privateTransport ? peer : null),
          stage: network.stage,
          chain: network.chain_id,
          release,
          peer,
          rpc,
          sentryId,
          nodes: this.deployments(id).flatMap(({ nodeId, role, name }) => {
            const scope = this.selectNode(id, role, nodeId);
            const dir = scope.dir(id, role);
            const binding = scope.network(id);
            if (!fs.existsSync(dir) && nodeId === role && !fs.existsSync(path.join(this.nodeRoot(id), role + "-host.json"))) return [];
            return [
              {
                nodeId,
                name,
                release: scope.network(id).release,
                invitation: { release: binding.release, rpc: binding.rpc, peer: binding.peer,
                  publicPeer: binding.publicPeer || (!binding.privateTransport ? binding.peer : null),
                  privatePeers: Boolean(binding.privateTransport), sentryId: binding.sentryId },
                hasData: fs.existsSync(dir),
                role,
                connection: fs.existsSync(path.join(dir, "connection.json"))
                  ? read(path.join(dir, "connection.json"))
                  : null,
                invitationFingerprint: fs.existsSync(
                  path.join(dir, "public/invitation.json"),
                )
                  ? sha(
                      fs.readFileSync(path.join(dir, "public/invitation.json")),
                    )
                  : null,
                deployment: fs.existsSync(
                  path.join(dir, "deployment-review.json"),
                )
                  ? read(path.join(dir, "deployment-review.json"))
                  : null,
                prepared: fs.existsSync(path.join(dir, "prepared")),
                identity: fs.existsSync(path.join(dir, "public.json"))
                  ? read(path.join(dir, "public.json"))
                  : null,
                checkpoint: fs.existsSync(
                  path.join(dir, "checkpoint-selection.json"),
                )
                  ? (() => {
                      const s = read(
                        path.join(dir, "checkpoint-selection.json"),
                      );
                      return {
                        id: s.envelope.manifest.id,
                        height: s.envelope.manifest.height,
                        fingerprint: s.fingerprint,
                        baseUrl: s.baseUrl,
                      };
                    })()
                  : null,
                restore: fs.existsSync(
                  path.join(dir, ".checkpoint-restore.json"),
                )
                  ? (({ id, height, phase }) => ({ id, height, phase }))(
                      read(path.join(dir, ".checkpoint-restore.json")),
                    )
                  : null,
                receipt: fs.existsSync(path.join(dir, "home-ready.json"))
                  ? read(path.join(dir, "home-ready.json"))
                  : null,
              },
            ];
          }),
        };
      });
  }
  identity(id, operator, password) {
    check(
      typeof password === "string" && password.length >= 32,
      "Use a keystore passphrase of at least 32 characters.",
    );
    const { network: n } = this.network(id);
    return initializeValidator(
      this.dir(id, "validator"),
      n.stage,
      n.chain_id,
      operator,
      password,
    );
  }
  prepareValidator(id, bundle) {
    const invite = this.network(id),
      dir = this.dir(id, "validator");
    check(
      typeof bundle === "string" && path.isAbsolute(bundle),
      "Enter the absolute path to the extracted admission bundle.",
    );
    check(
      !fs.existsSync(path.join(dir, "prepared")),
      "This validator is already prepared.",
    );
    // Validate and install the same bytes. An extraction folder can change while the
    // operator is reviewing it; never copy files from that folder after validation.
    const snapshot = fs.mkdtempSync(path.join(this.root, id, ".admission-"));
    try {
      for (const file of [
        "validator-admission.json",
        "compose.json",
        "network.json",
        "tunnel-policy.json",
        "identity/tendermint/config/config.toml",
        "identity/tendermint/config/genesis.json",
      ]) {
        const source = path.join(bundle, file),
          resolved = fs.realpathSync(bundle);
        check(
          fs.existsSync(source),
          file === "validator-admission.json"
            ? "This console accepts only a post-genesis admission bundle."
            : "Admission bundle is missing " + file + ".",
        );
        check(
          fs.realpathSync(source) === path.join(resolved, file) &&
            fs.statSync(source).isFile() &&
            fs.statSync(source).size <= 8 * 1024 * 1024,
          "Choose regular files from an extracted admission bundle.",
        );
        write(path.join(snapshot, file), fs.readFileSync(source, "utf8"));
      }
      this.installAdmission(id, invite, dir, snapshot);
    } finally {
      fs.rmSync(snapshot, { recursive: true, force: true });
    }
  }
  prepareInvitedValidator(id) {
    const invite = this.network(id),
      dir = this.dir(id, "validator");
    const peer = invite.publicPeer || (!invite.privateTransport && invite.peer);
    check(peer, "Load an invitation from the public sentry API first.");
    peerAddress(peer);
    check(
      fs.existsSync(path.join(dir, "public.json")),
      "Create your validator identity on the selected host first.",
    );
    check(
      !fs.existsSync(path.join(dir, "prepared")),
      "This validator is already prepared.",
    );
    const identity = read(path.join(dir, "public.json"));
    check(
      !JSON.parse(invite.genesis).validators.some(
        (v) =>
          v.pub_key.value === identity.validator_public_key ||
          v.address === identity.validator_address,
      ),
      "Genesis validators belong in the network deployment console.",
    );
    this.requireFresh(id, "validator");
    const compose = directConnection(homeCompose(invite), peer);
    // Build only our fixed topology. Invitations cannot supply commands or mounts.
    for (const [name, value] of [
      ["compose.json", compose],
      ["network.json", invite.network],
      ["identity/tendermint/config/config.toml", invite.config],
      ["identity/tendermint/config/genesis.json", invite.genesis],
      ["connection.json", { mode: "public", peer, private: true }],
    ]) {
      const file = path.join(dir, name);
      if (fs.existsSync(file))
        check(
          fs.readFileSync(file, "utf8") ===
            (typeof value === "string"
              ? value
              : JSON.stringify(value, null, 2) + "\n"),
          "Incomplete setup contains different runtime files. Preserve this identity and recover its original setup.",
        );
      else write(file, value);
    }
    if (!fs.existsSync(path.join(dir, ".env")))
      write(
        path.join(dir, ".env"),
        ["ABCI_DB_PASSWORD", "ABCI_ADMIN_PASSWORD", "MPT_DB_API_TOKEN"]
          .map((k) => k + "=" + randomBytes(32).toString("hex"))
          .join("\n") + "\n",
      );
    this.validateRuntime(id, "validator");
    // This prepares synchronization only. Voting power comes from canonical
    // registration/stake and the network's normal validator admission process.
    write(path.join(dir, "prepared"), id);
  }
  installAdmission(id, invite, dir, bundle) {
    const admissionFile = path.join(bundle, "validator-admission.json");
    check(
      fs.existsSync(admissionFile),
      "This console accepts only a post-genesis admission bundle.",
    );
    const identity = read(path.join(dir, "public.json")),
      incoming = read(path.join(bundle, "network.json"));
    check(
      isDeepStrictEqual(incoming, invite.network) &&
        sha(
          fs.readFileSync(
            path.join(bundle, "identity/tendermint/config/genesis.json"),
          ),
        ) === invite.network.file_hashes["genesis.json"],
      "Bundle does not match the imported network.",
    );
    check(
      !JSON.parse(invite.genesis).validators.some(
        (v) =>
          v.pub_key.value === identity.validator_public_key ||
          v.address === identity.validator_address,
      ),
      "Genesis validators belong in the deployment console.",
    );
    // Admission changes the node name and may tune resource limits, never the service commands or mounts.
    const compose = read(path.join(bundle, "compose.json")),
      expected = homeCompose(invite);
    check(
      new RegExp("^graphene-" + incoming.stage + "-[a-f0-9]{12}$").test(
        compose.name,
      ),
      "Expected an enrolled validator deployment.",
    );
    expected.name = compose.name;
    const stripLimits = (c) => {
      for (const s of Object.values(c.services)) {
        if (s.cpus !== undefined)
          check(
            typeof s.cpus === "string" &&
              /^\d+(?:\.\d{1,2})?$/.test(s.cpus) &&
              +s.cpus >= 0.1 &&
              +s.cpus <= 1024,
            "Invalid CPU limit in validator bundle.",
          );
        if (s.mem_limit !== undefined)
          check(
            typeof s.mem_limit === "string" &&
              /^\d+m$/.test(s.mem_limit) &&
              parseInt(s.mem_limit) >= 128 &&
              parseInt(s.mem_limit) <= 1048576,
            "Invalid memory limit in validator bundle.",
          );
        delete s.cpus;
        delete s.mem_limit;
        if (s.logging?.driver === "json-file") {
          const opts = s.logging.options,
            size = opts?.["max-size"],
            files = opts?.["max-file"];
          check(
            opts &&
              (size === undefined ||
                (typeof size === "string" &&
                  /^\d+m$/.test(size) &&
                  parseInt(size) >= 1 &&
                  parseInt(size) <= 1024)) &&
              (files === undefined ||
                (typeof files === "string" &&
                  /^\d+$/.test(files) &&
                  +files >= 1 &&
                  +files <= 100)),
            "Invalid log limits in validator bundle.",
          );
          delete s.logging.options["max-size"];
          delete s.logging.options["max-file"];
        }
      }
    };
    stripLimits(expected);
    stripLimits(compose);
    check(
      isDeepStrictEqual(compose, expected) &&
        fs.readFileSync(
          path.join(bundle, "identity/tendermint/config/config.toml"),
          "utf8",
        ) === invite.config,
      "Runtime differs from the trusted invitation.",
    );
    check(
      invite.tunnelPolicy &&
        isDeepStrictEqual(
          read(path.join(bundle, "tunnel-policy.json")),
          invite.tunnelPolicy,
        ),
      "The validator tunnel policy must match the primary in a verified invitation. Download a current invitation from the operator.",
    );
    installValidatorFiles(dir, bundle);
    write(path.join(dir, "prepared"), id);
    if (invite.publicPeer || !invite.privateTransport)
      this.configureConnection(
        id,
        "validator",
        invite.publicPeer || invite.peer,
      );
  }
  prepareSentry(id, address = "", peer = "", options = {}) {
    const invite = this.network(id),
      dir = this.dir(id, "sentry");
    peer = peer || invite.publicPeer || "";
    if (peer) peer = peerAddress(peer);
    const privatePeers = Boolean(invite.privateTransport) && !peer;
    address = privatePeers && address === "" ? "" : hostname(address);
    const p2pPort = Number(options.p2pPort || 26656);
    const rpcPort = Number(options.rpcPort || 26657);
    check([p2pPort, rpcPort].every((port) => Number.isInteger(port) && port > 0 && port <= 65535) && p2pPort !== rpcPort, "Choose two distinct public ports between 1 and 65535.");
    const catalog = new Participants(this.root, this.runner);
    for (const network of catalog.inventory()) {
      for (const node of network.nodes) {
        if (node.role !== "sentry" || !node.prepared || (network.id === id && node.nodeId === (this.selection?.nodeId || "sentry"))) continue;
        const other = catalog.selectNode(network.id, "sentry", node.nodeId);
        const hostFile = path.join(other.nodeRoot(network.id), "sentry-host.json");
        if (fs.existsSync(hostFile) && read(hostFile).kind === "cloud") continue;
        check(![node.connection?.p2pPort || 26656, node.connection?.rpcPort || 26657].some((port) => port === p2pPort || port === rpcPort), "Another sentry on this machine uses these ports. Choose different P2P and RPC ports.");
      }
    }
    check(!fs.existsSync(dir), "This network already has a local sentry.");
    const tmp = fs.mkdtempSync(path.join(this.root, id, ".sentry-"));
    try {
      const tn = generateTendermintNodeKey(),
        key = generateTendermintValidatorKey();
      const compose = homeCompose(invite);
      let request;
      if (privatePeers) {
        const seed = randomBytes(32);
        write(path.join(tmp, "identity/tunnel.json"), {
          seed: seed.toString("hex"),
          host: "node",
          port: 26656,
        });
        write(path.join(tmp, "tunnel-policy.json"), invite.tunnelPolicy);
        request = {
          format: "graphene-sentry-request-v1",
          role: "sentry",
          network_id: id,
          node_id: tn.nodeId,
          tunnel_key: z32.encode(nacl.sign.keyPair.fromSeed(seed).publicKey),
        };
      } else delete compose.services["home-tunnel"];
      const node = compose.services.node;
      if (!privatePeers) directConnection(compose, peer || invite.peer);
      if (address && !privatePeers)
        node.command.push("--p2p.external-address", address + ":" + p2pPort);
      node.networks = privatePeers ? ["backend"] : ["backend", "egress"];
      if (address && !privatePeers) node.ports = [p2pPort + ":26656"];
      compose.services.gateway = {
        image: invite.images.nginx,
        restart: "unless-stopped",
        networks: ["backend", "egress"],
        ports: [address ? rpcPort + ":26657" : "127.0.0.1::26657"],
        volumes: ["./gateway:/etc/nginx/conf.d:ro", "./public:/public:ro"],
        depends_on: { node: { condition: "service_started" } },
      };
      write(
        path.join(tmp, "gateway/default.conf"),
        fs.readFileSync(
          new URL("./public-tendermint.conf", import.meta.url),
          "utf8",
        ),
      );
      const publicFields = Object.fromEntries(
        [
          "format",
          "network",
          "release",
          "peer",
          "rpc",
          "sentryId",
          "genesis",
          "config",
          "images",
          "tunnelPolicy",
          "privateTransport",
          "checkpoint",
        ]
          .filter((name) => invite[name] !== undefined)
          .map((name) => [name, invite[name]]),
      );
      const publicInvitation =
        JSON.stringify(
          { ...publicFields, ...(!privatePeers ? { publicPeer: tn.nodeId + "@" + address + ":" + p2pPort } : {}) },
          null,
          2,
        ) + "\n";
      write(path.join(tmp, "public/invitation.json"), publicInvitation);
      write(
        path.join(tmp, "public/invitation.sha256"),
        sha(publicInvitation) + "\n",
      );
      fs.chmodSync(path.join(tmp, "public"), 0o755);
      for (const name of ["invitation.json", "invitation.sha256"])
        fs.chmodSync(path.join(tmp, "public", name), 0o644);
      write(path.join(tmp, "connection.json"), {
        mode: privatePeers ? "grph" : "public",
        peer: peer || invite.peer,
        domain: address,
        p2pPort,
        rpcPort,
      });
      write(path.join(tmp, "compose.json"), compose);
      write(path.join(tmp, "network.json"), invite.network);
      write(
        path.join(tmp, "public.json"),
        request || {
          role: "sentry",
          node_id: tn.nodeId,
          endpoint: address ? address + ":" + p2pPort : null,
        },
      );
      const tm = path.join(tmp, "identity/tendermint");
      write(path.join(tm, "config/config.toml"), publicSentryConfig(invite.config));
      write(path.join(tm, "config/genesis.json"), invite.genesis);
      write(path.join(tm, "config/node_key.json"), { priv_key: tn.privateKey });
      write(path.join(tm, "config/priv_validator_key.json"), {
        address: key.address,
        pub_key: key.publicKey,
        priv_key: key.privateKey,
      });
      write(path.join(tm, "data/priv_validator_state.json"), {
        height: "0",
        round: 0,
        step: 0,
      });
      write(
        path.join(tmp, ".env"),
        ["ABCI_DB_PASSWORD", "ABCI_ADMIN_PASSWORD", "MPT_DB_API_TOKEN"]
          .map((k) => k + "=" + randomBytes(32).toString("hex"))
          .join("\n") + "\n",
      );
      write(path.join(tmp, "prepared"), id);
      fs.renameSync(tmp, dir);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  connection(id, role) {
    const file = path.join(this.dir(id, role), "connection.json");
    return fs.existsSync(file) ? read(file) : null;
  }
  sentryInvitation(id) {
    const file = path.join(this.dir(id, "sentry"), "public/invitation.json");
    check(fs.existsSync(file), "Prepare a public sentry first.");
    return read(file);
  }
  deploymentFingerprint(id, role) {
    const dir = this.dir(id, role);
    return sha(
      JSON.stringify(
        ["compose.json", "connection.json", "network.json", "public.json"].map(
          (name) =>
            fs.existsSync(path.join(dir, name))
              ? fs.readFileSync(path.join(dir, name), "utf8")
              : null,
        ),
      ),
    );
  }
  reviewDeployment(id, role) {
    const dir = this.dir(id, role),
      invite = this.network(id),
      connection = this.connection(id, role);
    check(
      fs.existsSync(path.join(dir, "prepared")),
      "Complete network and identity setup first.",
    );
    this.validateRuntime(id, role);
    check(
      role !== "validator" || connection?.mode === "public",
      "Configure the public sentry connection first.",
    );
    const compose = read(path.join(dir, "compose.json"));
    const ports = Object.entries(compose.services).flatMap(([name, service]) =>
      (service.ports || []).map((port) => name + ": " + port),
    );
    check(
      role !== "validator" || ports.length === 0,
      "Private validators cannot publish any host ports.",
    );
    check(
      role !== "sentry" ||
        (connection?.domain &&
          ports.includes("node: " + (connection.p2pPort || 26656) + ":26656") &&
          ports.includes("gateway: " + (connection.rpcPort || 26657) + ":26657")),
      "Public sentries require a domain and both public endpoints.",
    );
    const review = {
      fingerprint: this.deploymentFingerprint(id, role),
      networkId: id,
      release: invite.release,
      peer: connection?.peer || invite.peer,
      endpoint: connection?.domain || null,
      ports,
      services: Object.keys(compose.services),
      privateValidator: role === "validator",
      storage: dir,
    };
    const file = path.join(dir, "deployment-review.json"),
      temp = file + "." + randomBytes(6).toString("hex");
    write(temp, review);
    fs.renameSync(temp, file);
    return review;
  }
  requireReviewed(id, role) {
    const file = path.join(this.dir(id, role), "deployment-review.json");
    check(
      fs.existsSync(file) &&
        read(file).fingerprint === this.deploymentFingerprint(id, role),
      "Review the current deployment before starting or restoring it.",
    );
  }
  configureConnection(id, role, peer) {
    check(
      role === "validator",
      "Set a sentry's public domain during preparation.",
    );
    const dir = this.dir(id, role);
    check(
      fs.existsSync(path.join(dir, "prepared")),
      "Install the approved admission bundle first.",
    );
    check(
      !fs.existsSync(path.join(dir, ".checkpoint-restore.json")) &&
        !fs.existsSync(path.join(dir, ".rollout-fence.json")),
      "Keep the connection settings used by the checkpoint restore.",
    );
    this.requireFresh(id, role);
    const marker = path.join(dir, "runtime-started.json");
    check(
      !fs.existsSync(marker),
      "An existing validator's connection cannot be rebound here.",
    );
    peer = peerAddress(peer);
    const composeFile = path.join(dir, "compose.json"),
      compose = read(composeFile);
    // Idempotent edits to the trusted, admitted topology; no incoming commands are accepted.
    const args = compose.services.node.command;
    for (const flag of ["--p2p.persistent_peers", "--p2p.private_peer_ids"]) {
      const index = args.indexOf(flag);
      if (index !== -1) args.splice(index, 2);
    }
    const strict = args.indexOf("--p2p.addr_book_strict=false");
    if (strict !== -1) args.splice(strict, 1);
    directConnection(compose, peer);
    for (const [name, value] of [
      ["compose.json", compose],
      ["connection.json", { mode: "public", peer, private: true }],
    ]) {
      const file = path.join(dir, name),
        temp = file + "." + randomBytes(8).toString("hex");
      write(temp, value);
      fs.renameSync(temp, file);
    }
    return { peer };
  }
  project(id, role) {
    return "graphene-join-" + sha(this.dir(id, role)).slice(0, 16) + "-" + role;
  }
  validateRuntime(id, role) {
    const dir = this.dir(id, role);
    for (const name of [
      ".env",
      "identity/tendermint/config/node_key.json",
      "identity/tendermint/config/priv_validator_key.json",
      "identity/tendermint/data/priv_validator_state.json",
    ])
      check(
        fs.existsSync(path.join(dir, name)),
        "Identity or signing history missing. Restore your backup.",
      );
    const invite = this.network(id),
      identity = read(path.join(dir, "public.json"));
    const config = path.join(dir, "identity/tendermint/config");
    check(
      isDeepStrictEqual(read(path.join(dir, "network.json")), invite.network) &&
        sha(fs.readFileSync(path.join(config, "genesis.json"))) ===
          invite.network.file_hashes["genesis.json"],
      "Genesis or network binding changed. Restore the verified runtime before starting.",
    );
    const publicFrom = (key) => {
      const secret = Buffer.from(key.value, "base64");
      check(
        key.type === "tendermint/PrivKeyEd25519" && secret.length === 64,
        "Invalid Tendermint key. Restore the original identity.",
      );
      const pub = Buffer.from(
        nacl.sign.keyPair.fromSeed(secret.subarray(0, 32)).publicKey,
      );
      check(
        pub.equals(secret.subarray(32)),
        "Tendermint key pair does not match. Restore the original identity.",
      );
      return pub;
    };
    const nodeKey = read(path.join(config, "node_key.json")),
      signer = read(path.join(config, "priv_validator_key.json"));
    const pub = publicFrom(signer.priv_key);
    check(
      sha(publicFrom(nodeKey.priv_key)).slice(0, 40) === identity.node_id &&
        signer.pub_key.value === pub.toString("base64") &&
        signer.address === sha(pub).slice(0, 40).toUpperCase(),
      "Local keys do not match the node identity. Restore the original identity.",
    );
    if (role === "validator")
      check(
        identity.validator_public_key === signer.pub_key.value &&
          identity.validator_address === signer.address,
        "Validator signing key differs from the enrolled identity.",
      );
    else
      check(
        !JSON.parse(invite.genesis).validators.some(
          (v) =>
            v.pub_key.value === signer.pub_key.value ||
            v.address === signer.address,
        ),
        "A nonvoting sentry cannot start with a genesis signing key.",
      );
    if (
      this.connection(id, role)?.mode !== "public" &&
      (invite.privateTransport || (role === "validator" && invite.tunnelPolicy))
    ) {
      const tunnel = read(path.join(dir, "identity/tunnel.json"));
      check(
        hex.test(tunnel.seed) &&
          z32.encode(
            nacl.sign.keyPair.fromSeed(Buffer.from(tunnel.seed, "hex"))
              .publicKey,
          ) === identity.tunnel_key &&
          isDeepStrictEqual(
            read(path.join(dir, "tunnel-policy.json")),
            invite.tunnelPolicy,
          ),
        "Grph tunnel identity or peer policy differs from the approved runtime.",
      );
    }
  }
  requireFresh(id, role) {
    const dir = this.dir(id, role),
      tm = path.join(dir, "identity/tendermint/data");
    const signing = read(path.join(tm, "priv_validator_state.json"));
    check(
      String(signing.height) === "0" &&
        Number(signing.round) === 0 &&
        Number(signing.step) === 0,
      "Checkpoint restore requires a fresh node with no signing history.",
    );
    for (const name of [
      "blockstore.db",
      "state.db",
      "evidence.db",
      "tx_index.db",
    ])
      check(
        !fs.existsSync(path.join(tm, name)),
        "Existing consensus data cannot be replaced.",
      );
    for (const name of [
      "data/mpt/db",
      "data/abci-postgres",
      "data/evm-postgres",
    ])
      check(
        !fs.existsSync(path.join(dir, name)) ||
          fs.readdirSync(path.join(dir, name)).length === 0,
        "Existing ledger data cannot be replaced. Use a fresh node.",
      );
  }
  selectCheckpoint(id, role, raw, fingerprint, baseUrl) {
    const dir = this.dir(id, role);
    check(
      fs.existsSync(path.join(dir, "prepared")),
      "Prepare this node before selecting a checkpoint.",
    );
    check(
      !fs.existsSync(path.join(dir, ".checkpoint-restore.json")) &&
        !fs.existsSync(path.join(dir, ".rollout-fence.json")),
      "A restore already owns this node. Retry the saved checkpoint.",
    );
    this.requireFresh(id, role);
    const selection = verifySelection(
      this.network(id),
      raw,
      fingerprint,
      baseUrl,
    );
    const file = path.join(dir, "checkpoint-selection.json"),
      tmp = file + "." + randomBytes(6).toString("hex");
    write(tmp, selection);
    fs.renameSync(tmp, file);
    return {
      id: selection.envelope.manifest.id,
      height: selection.envelope.manifest.height,
    };
  }
  async restore(id, role) {
    const dir = this.dir(id, role);
    check(
      fs.existsSync(path.join(dir, "prepared")),
      "Prepare this node first.",
    );
    check(
      role !== "validator" || this.connection(id, role)?.mode === "public",
      "Configure the public sentry address before restoring the private validator.",
    );
    this.requireReviewed(id, role);
    this.validateRuntime(id, role);
    const saved = read(path.join(dir, "checkpoint-selection.json"));
    const selection = verifySelection(
      this.network(id),
      JSON.stringify(saved.envelope),
      saved.fingerprint,
      saved.baseUrl,
    );
    const fence = path.join(dir, ".rollout-fence.json");
    if (fs.existsSync(fence)) {
      const owner = read(fence);
      check(
        ["snapshot-bootstrap-pending", "snapshot-restore"].includes(
          owner.kind,
        ) && owner.operationId === selection.envelope.manifest.id,
        "Another operation owns this node. Preserve its fence.",
      );
    } else if (!fs.existsSync(path.join(dir, ".checkpoint-restore.json"))) {
      this.requireFresh(id, role);
      write(fence, {
        kind: "snapshot-bootstrap-pending",
        operationId: selection.envelope.manifest.id,
      });
    }
    const result = await restoreCheckpoint(
      dir,
      this.project(id, role),
      role,
      selection,
    );
    if (role === "validator") writeValidatorReceipt(dir);
    return result;
  }
  async operate(id, role, action) {
    const dir = this.dir(id, role);
    check(
      fs.existsSync(path.join(dir, "prepared")),
      "Prepare this node before running Docker.",
    );
    const args = {
      start: ["up", "-d"],
      stop: ["stop"],
      status: ["ps", "--all", "--format", "json"],
      logs: ["logs", "--no-color", "--tail", "200"],
      stats: ["stats", "--no-stream", "--format", "json"],
      health: [
        "exec",
        "-T",
        "node",
        "wget",
        "-qO-",
        "http://127.0.0.1:26657/status",
      ],
    };
    check(Object.hasOwn(args, action), "Unknown node action.");
    if (action === "start") {
      this.requireReviewed(id, role);
      const selected = path.join(dir, "checkpoint-selection.json");
      check(
        !fs.existsSync(selected) ||
          (fs.existsSync(path.join(dir, ".checkpoint-restore.json")) &&
            read(path.join(dir, ".checkpoint-restore.json")).phase ===
              "complete"),
        "Restore the selected checkpoint before starting this node.",
      );
      if (role === "sentry") {
        const file = path.join(dir, "compose.json");
        const compose = read(file);
        const args = compose.services.node.command;
        const index = args.indexOf("--p2p.external_address");
        if (index !== -1) {
          args[index] = "--p2p.external-address";
          const tmp = file + "." + randomBytes(6).toString("hex") + ".tmp";
          write(tmp, compose);
          fs.renameSync(tmp, file);
        }
      }
      check(
        !fs.existsSync(path.join(dir, ".rollout-fence.json")),
        "Node is fenced; recover it before starting.",
      );
      this.validateRuntime(id, role);
      check(
        role !== "validator" || this.connection(id, role)?.mode === "public",
        "Configure the public sentry address before starting the private validator.",
      );
      if (!fs.existsSync(path.join(dir, "runtime-started.json")))
        write(path.join(dir, "runtime-started.json"), {
          at: new Date().toISOString(),
        });
    }
    const out = await this.runner(dir, this.project(id, role), args[action]);
    if (action === "start" && role === "validator") writeValidatorReceipt(dir);
    if (action === "health") {
      const s = JSON.parse(out).result;
      check(
        s.node_info.network === JSON.parse(this.network(id).genesis).chain_id,
        "Node reports a different network.",
      );
      check(
        s.node_info.id === read(path.join(dir, "public.json")).node_id,
        "Docker is reporting another node identity.",
      );
      const peers = JSON.parse(
        await this.runner(
          dir,
          "graphene-join-" + sha(dir).slice(0, 16) + "-" + role,
          [
            "exec",
            "-T",
            "node",
            "wget",
            "-qO-",
            "http://127.0.0.1:26657/net_info",
          ],
        ),
      ).result.peers;
      const primary = (
        this.connection(id, role)?.peer || this.network(id).peer
      ).split("@")[0];
      return {
        primaryConnected: peers.some((p) => p.node_info.id === primary),
        height: s.sync_info.latest_block_height,
        catchingUp: s.sync_info.catching_up,
        votingPower: s.validator_info.voting_power,
        blockTime: s.sync_info.latest_block_time,
      };
    }
    if (action === "logs") return { text: out.slice(-24000) };
    if (action === "stats") return out.trim() ? out.trim().split("\n").flatMap(line=>JSON.parse(line)) : [];
    if (action === "status") {
      const lines = out.trim()
        ? out
            .trim()
            .split("\n")
            .flatMap((line) => JSON.parse(line))
        : [];
      return lines.map(({ Service, State, Health }) => ({
        service: Service,
        state: State,
        health: Health,
      }));
    }
    return { ok: true };
  }
}

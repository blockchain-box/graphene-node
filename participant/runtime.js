import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { isIPv4 } from "node:net";
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
  const peer = /^([a-f0-9]{40})@([0-9.]+):26656$/.exec(invite.peer);
  check(
    (Object.hasOwn(hashes, "peer-transport.json") ? /^[a-f0-9]{40}$/.test(invite.peer) : peer && isIPv4(peer[2])) &&
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
    check(/^[ybndrfg8ejkmcpqxot1uwisza345h769]{51}[yo]$/.test(invite.tunnelPolicy?.allowed_peer) &&
      (invite.tunnelPolicy.bootstrap === null || (Array.isArray(invite.tunnelPolicy.bootstrap) &&
      invite.tunnelPolicy.bootstrap.every(b => typeof b === "string"))), "Invalid primary tunnel policy.");
  }
  if (Object.hasOwn(hashes, "peer-transport.json") || invite.privateTransport !== undefined) {
    check(typeof invite.privateTransport === "string" && sha(invite.privateTransport) === hashes["peer-transport.json"],
      "Private transport checksum mismatch.");
    const binding = JSON.parse(invite.privateTransport);
    check(binding.transport === "grph-noise-v1" && invite.tunnelPolicy && binding.primary_tunnel_key === invite.tunnelPolicy.allowed_peer,
      "Primary tunnel key differs from the frozen network.");
  }
  return invite;
}
export async function docker(directory, project, args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COMPOSE_") || ["ABCI_DB_PASSWORD","ABCI_ADMIN_PASSWORD","MPT_DB_API_TOKEN"].includes(key)) delete env[key];
  const options = {
    cwd: directory,
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
    check(/^(unix:\/\/\/|npipe:\/\/\/)/.test(endpoint), "Select a local Docker engine.");
    // Run against the exact socket we checked, even if the user's active context changes.
    delete env.DOCKER_CONTEXT;
    env.DOCKER_HOST = endpoint;
    return (
      await exec(
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
  constructor(root, runner = docker) {
    this.root = root;
    this.runner = runner;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  network(id) {
    check(
      typeof id === "string" && hex.test(id),
      "Select an imported network.",
    );
    return read(path.join(this.root, id, "invitation.json"));
  }
  dir(id, role) {
    check(roles.includes(role) && hex.test(id), "Unknown node or network.");
    return path.join(this.root, id, role);
  }
  import(raw, fingerprint) {
    const invite = validateInvitation(raw, fingerprint);
    const id = invite.network.network_id,
      file = path.join(this.root, id, "invitation.json");
    if (fs.existsSync(file))
      {
        const old = fs.readFileSync(file,"utf8");
        if (sha(old) !== fingerprint) {
          const {tunnelPolicy, ...previousFormat} = invite;
          check(tunnelPolicy && isDeepStrictEqual(JSON.parse(old),previousFormat),
            "A different invitation for this network is already installed. Keep the existing release and node data.");
          const next = file+"."+randomBytes(8).toString("hex");
          write(next,raw); fs.renameSync(next,file);
        }
      }
    else write(file, raw);
    return id;
  }
  inventory() {
    return fs
      .readdirSync(this.root)
      .filter(
        (id) =>
          hex.test(id) &&
          fs.existsSync(path.join(this.root, id, "invitation.json")),
      )
      .map((id) => {
        const { network, release, peer, rpc, sentryId, privateTransport } = this.network(id);
        return {
          id,
          privatePeers: Boolean(privateTransport),
          stage: network.stage,
          chain: network.chain_id,
          release,
          peer,
          rpc,
          sentryId,
          nodes: roles.flatMap((role) => {
            const dir = this.dir(id, role);
            if (!fs.existsSync(dir)) return [];
            return [
              {
                role,
                prepared: fs.existsSync(path.join(dir, "prepared")),
                identity: fs.existsSync(path.join(dir, "public.json"))
                  ? read(path.join(dir, "public.json"))
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
    const snapshot = fs.mkdtempSync(path.join(this.root,id,".admission-"));
    try {
      for (const file of ["validator-admission.json","compose.json","network.json","tunnel-policy.json","identity/tendermint/config/config.toml","identity/tendermint/config/genesis.json"]) {
        const source=path.join(bundle,file), resolved=fs.realpathSync(bundle);
        check(fs.existsSync(source),file==="validator-admission.json" ? "This console accepts only a post-genesis admission bundle." : "Admission bundle is missing "+file+".");
        check(fs.realpathSync(source)===path.join(resolved,file) && fs.statSync(source).isFile() && fs.statSync(source).size <= 8*1024*1024,
          "Choose regular files from an extracted admission bundle.");
        write(path.join(snapshot,file),fs.readFileSync(source,"utf8"));
      }
      this.installAdmission(id,invite,dir,snapshot);
    } finally {fs.rmSync(snapshot,{recursive:true,force:true});}
  }
  installAdmission(id,invite,dir,bundle) {
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
        if (s.cpus !== undefined) check(typeof s.cpus === "string" && /^\d+(?:\.\d{1,2})?$/.test(s.cpus) && +s.cpus >= 0.1 && +s.cpus <= 1024,"Invalid CPU limit in validator bundle.");
        if (s.mem_limit !== undefined) check(typeof s.mem_limit === "string" && /^\d+m$/.test(s.mem_limit) && parseInt(s.mem_limit)>=128 && parseInt(s.mem_limit)<=1048576,"Invalid memory limit in validator bundle.");
        delete s.cpus;
        delete s.mem_limit;
        if (s.logging?.driver === "json-file") {
          const opts=s.logging.options, size=opts?.["max-size"], files=opts?.["max-file"];
          check(opts && (size===undefined || (typeof size==="string" && /^\d+m$/.test(size) && parseInt(size)>=1 && parseInt(size)<=1024)) &&
            (files===undefined || (typeof files==="string" && /^\d+$/.test(files) && +files>=1 && +files<=100)),"Invalid log limits in validator bundle.");
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
    check(invite.tunnelPolicy && isDeepStrictEqual(read(path.join(bundle,"tunnel-policy.json")),invite.tunnelPolicy),
      "The validator tunnel policy must match the primary in a verified invitation. Download a current invitation from the operator.");
    installValidatorFiles(dir, bundle);
    write(path.join(dir, "prepared"), id);
  }
  prepareSentry(id, address = "") {
    const invite = this.network(id),
      dir = this.dir(id, "sentry");
    check(address === "" || isIPv4(address), "Enter a valid advertised IPv4 address, or leave it empty to sync outbound.");
    check(!fs.existsSync(dir), "This network already has a local sentry.");
    const tmp = fs.mkdtempSync(path.join(this.root, id, ".sentry-"));
    try {
      const tn = generateTendermintNodeKey(),
        key = generateTendermintValidatorKey();
      const compose = homeCompose(invite);
      const privatePeers = Boolean(invite.privateTransport);
      check(!privatePeers || !address, "Private sentries do not advertise a public IP address.");
      let request;
      if (privatePeers) {
        const seed = randomBytes(32);
        write(path.join(tmp,"identity/tunnel.json"),{seed:seed.toString("hex"),host:"node",port:26656});
        write(path.join(tmp,"tunnel-policy.json"), invite.tunnelPolicy);
        request = {format:"graphene-sentry-request-v1",role:"sentry",network_id:id,node_id:tn.nodeId,
          tunnel_key:z32.encode(nacl.sign.keyPair.fromSeed(seed).publicKey)};
      } else delete compose.services["home-tunnel"];
      const node = compose.services.node;
      if (!privatePeers) node.command.push("--p2p.persistent_peers", invite.peer);
      if (address) node.command.push("--p2p.external-address", address + ":26656");
      if (!privatePeers) node.networks = ["backend", "egress"];
      if (address) node.ports = ["26656:26656"];
      compose.services.gateway = {
        image: invite.images.nginx,
        restart: "unless-stopped",
        networks: ["backend", "egress"],
        ports: [address ? "26657:26657" : "127.0.0.1::26657"],
        volumes: ["./gateway:/etc/nginx/conf.d:ro"],
        depends_on: { node: { condition: "service_started" } },
      };
      write(
        path.join(tmp, "gateway/default.conf"),
        fs.readFileSync(
          new URL("./public-tendermint.conf", import.meta.url),
          "utf8",
        ),
      );
      write(path.join(tmp, "compose.json"), compose);
      write(path.join(tmp, "network.json"), invite.network);
      write(path.join(tmp, "public.json"), request || {
        role: "sentry",
        node_id: tn.nodeId,
        endpoint: address ? address + ":26656" : null,
      });
      const tm = path.join(tmp, "identity/tendermint");
      write(path.join(tm, "config/config.toml"), invite.config);
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
      logs: ["logs", "--no-color", "--tail", "60", "node"],
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
    if (action === 'logs' && (this.network(id).privateTransport || (role === 'validator' && this.network(id).tunnelPolicy))) args.logs.push('home-tunnel');
    if (action === "start") {
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
      const invite = this.network(id), identity = read(path.join(dir,"public.json"));
      const config = path.join(dir,"identity/tendermint/config");
      check(isDeepStrictEqual(read(path.join(dir,"network.json")),invite.network) &&
        sha(fs.readFileSync(path.join(config,"genesis.json"))) === invite.network.file_hashes["genesis.json"],
        "Genesis or network binding changed. Restore the verified runtime before starting.");
      const publicFrom = key => {
        const secret=Buffer.from(key.value,"base64");
        check(key.type==="tendermint/PrivKeyEd25519" && secret.length===64,"Invalid Tendermint key. Restore the original identity.");
        const pub=Buffer.from(nacl.sign.keyPair.fromSeed(secret.subarray(0,32)).publicKey);
        check(pub.equals(secret.subarray(32)),"Tendermint key pair does not match. Restore the original identity.");
        return pub;
      };
      const nodeKey=read(path.join(config,"node_key.json")), signer=read(path.join(config,"priv_validator_key.json"));
      const pub=publicFrom(signer.priv_key);
      check(sha(publicFrom(nodeKey.priv_key)).slice(0,40)===identity.node_id &&
        signer.pub_key.value===pub.toString("base64") && signer.address===sha(pub).slice(0,40).toUpperCase(),
        "Local keys do not match the node identity. Restore the original identity.");
      if(role==="validator") check(identity.validator_public_key===signer.pub_key.value && identity.validator_address===signer.address,
        "Validator signing key differs from the enrolled identity.");
      else check(!JSON.parse(invite.genesis).validators.some(v=>v.pub_key.value===signer.pub_key.value || v.address===signer.address),
        "A nonvoting sentry cannot start with a genesis signing key.");
      if(invite.privateTransport || (role==="validator" && invite.tunnelPolicy)) {
        const tunnel=read(path.join(dir,"identity/tunnel.json"));
        check(hex.test(tunnel.seed) && z32.encode(nacl.sign.keyPair.fromSeed(Buffer.from(tunnel.seed,"hex")).publicKey)===identity.tunnel_key &&
          isDeepStrictEqual(read(path.join(dir,"tunnel-policy.json")),invite.tunnelPolicy),
          "Grph tunnel identity or peer policy differs from the approved runtime.");
      }
    }
    const out = await this.runner(
      dir,
      "graphene-join-" + sha(dir).slice(0, 16) + "-" + role,
      args[action],
    );
    if (action === "start" && role === "validator") writeValidatorReceipt(dir);
    if (action === "health") {
      const s = JSON.parse(out).result;
      check(
        s.node_info.network === JSON.parse(this.network(id).genesis).chain_id,
        "Node reports a different network.",
      );
      check(s.node_info.id === read(path.join(dir,"public.json")).node_id, "Docker is reporting another node identity.");
      const peers = JSON.parse(await this.runner(dir,"graphene-join-" + sha(dir).slice(0,16) + "-" + role,
        ["exec","-T","node","wget","-qO-","http://127.0.0.1:26657/net_info"])).result.peers;
      const primary = this.network(id).peer.split("@")[0];
      return {
        primaryConnected: peers.some(p => p.node_info.id === primary),
        height: s.sync_info.latest_block_height,
        catchingUp: s.sync_info.catching_up,
        votingPower: s.validator_info.voting_power,
        blockTime: s.sync_info.latest_block_time,
      };
    }
    if (action === "logs") return { text: out.slice(-24000) };
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

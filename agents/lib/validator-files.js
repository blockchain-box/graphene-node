// Host identity and public bundle installation shared by the controller and participant kit.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import nacl from "tweetnacl";
import z32 from "z32";
import { generateAll } from "../validator-agent/src/keygen.js";
import { saveKeystore } from "./keystore.js";
const tunnelPublicKey = (seed) =>
  z32.encode(nacl.sign.keyPair.fromSeed(Buffer.from(seed, "hex")).publicKey);
const stages = ["dev", "staging", "production"];
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
function write(file, content, flag = "w") {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    file,
    typeof content === "string"
      ? content
      : JSON.stringify(content, null, 2) + "\n",
    { mode: 0o600, flag },
  );
}

export function initializeValidator(
  directory,
  stage,
  chain,
  operator,
  passphrase = process.env.GRAPHENE_HOME_PASSPHRASE,
) {
  requireValue(
    path.isAbsolute(directory) &&
      stages.includes(stage) &&
      /^[1-9]\d*$/.test(String(chain)) &&
      Number.isSafeInteger(Number(chain)),
    "Use an absolute directory, valid stage and positive chain ID",
  );
  requireValue(
    /^0x[0-9a-f]{40}$/i.test(operator),
    "Supply the operator wallet address",
  );
  requireValue(
    operator.toLowerCase() !== "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc" &&
      !/^0x0{40}$/i.test(operator),
    "Do not use a public development or zero address",
  );
  requireValue(
    typeof passphrase === "string" && passphrase.length >= 32,
    "Set GRAPHENE_HOME_PASSPHRASE to at least 32 characters on the home host",
  );
  requireValue(
    !fs.existsSync(directory),
    "Identity destination exists; existing keys and signing history are never overwritten",
  );
  const keys = generateAll();
  const tm = path.join(directory, "identity/tendermint");
  const transportSeed = crypto.randomBytes(32).toString("hex");
  // Reserve the identity root exclusively before writing any private key.
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.mkdirSync(path.join(tm, "config"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(tm, "data"), { mode: 0o700 });
  write(
    path.join(tm, "config/node_key.json"),
    { priv_key: keys.tendermint.node.privateKey },
    "wx",
  );
  write(
    path.join(tm, "config/priv_validator_key.json"),
    {
      address: keys.tendermint.validator.address,
      pub_key: keys.tendermint.validator.publicKey,
      priv_key: keys.tendermint.validator.privateKey,
    },
    "wx",
  );
  write(
    path.join(tm, "data/priv_validator_state.json"),
    { height: "0", round: 0, step: 0 },
    "wx",
  );
  write(
    path.join(directory, "identity/tunnel.json"),
    { seed: transportSeed, host: "node", port: 26656 },
    "wx",
  );
  saveKeystore(
    keys,
    passphrase,
    path.join(directory, "identity/keystore.enc"),
    true,
  );
  const identity = {
    schema: 1,
    stage,
    chain_id: Number(chain),
    operator_address: operator.toLowerCase(),
    role: "home",
    node_id: keys.tendermint.node.nodeId,
    validator_address: keys.tendermint.validator.address,
    validator_public_key: keys.tendermint.validator.publicKey.value,
    tunnel_key: tunnelPublicKey(transportSeed),
    network_public_key: "0x" + keys.grph.keyPair.publicKey,
    encryption_public_key: "0x" + keys.x25519.publicKey,
    agent_address: keys.agent.address.toLowerCase(),
  };
  write(path.join(directory, "public.json"), identity, "wx");
  return identity;
}

export function installValidatorFiles(
  directory,
  bundle,
  { allowGenesis = false } = {},
) {
  requireValue(
    !fs.existsSync(path.join(directory, ".rollout-fence.json")),
    "Node is fenced; recover it through Blockchain updates",
  );
  const identity = read(path.join(directory, "public.json"));
  const network = read(path.join(bundle, "network.json"));
  const genesisFile = path.join(
    bundle,
    "identity/tendermint/config/genesis.json",
  );
  const genesis = read(genesisFile);
  const compose = read(path.join(bundle, "compose.json"));
  const key = read(
    path.join(directory, "identity/tendermint/config/priv_validator_key.json"),
  );
  requireValue(
    identity.role === "home" &&
      stages.includes(identity.stage) &&
      network.stage === identity.stage &&
      network.chain_id === identity.chain_id,
    "Bundle stage or chain does not match the home identity",
  );
  requireValue(
    key.pub_key.value === identity.validator_public_key &&
      key.address === identity.validator_address,
    "The installed consensus key differs from the home public identity",
  );
  const genesisAuthorized = genesis.validators.some(
    (validator) =>
      validator.pub_key.value === identity.validator_public_key &&
      validator.address === identity.validator_address,
  );
  // The authenticated deployment controller verifies live registration before
  // issuing this public admission record. It never carries signing material.
  const admissionFile = path.join(bundle, "validator-admission.json");
  let registered = false;
  if (fs.existsSync(admissionFile)) {
    const admission = read(admissionFile);
    registered =
      admission.schema === 1 &&
      admission.networkId === network.network_id &&
      admission.identity?.role === "home" &&
      [
        "stage",
        "chain_id",
        "operator_address",
        "validator_public_key",
        "validator_address",
        "node_id",
        "tunnel_key",
        "network_public_key",
        "encryption_public_key",
        "agent_address",
      ].every((field) => admission.identity[field] === identity[field]);
    requireValue(
      registered,
      "Live validator admission does not match this identity or frozen network",
    );
  }
  requireValue(
    allowGenesis || (!genesisAuthorized && registered),
    "A participant requires post-genesis admission",
  );
  requireValue(
    genesisAuthorized || registered,
    "Genesis does not authorize this home signer; verify its on-chain enrollment through the deployment controller",
  );
  requireValue(
    crypto
      .createHash("sha256")
      .update(fs.readFileSync(genesisFile))
      .digest("hex") === network.file_hashes?.["genesis.json"],
    "Genesis does not match the frozen network manifest",
  );
  const binding = path.join(directory, "network.json");
  if (fs.existsSync(binding))
    requireValue(
      read(binding).network_id === network.network_id,
      "Existing validator belongs to another frozen network",
    );
  requireValue(
    fs.existsSync(
      path.join(
        directory,
        "identity/tendermint/data/priv_validator_state.json",
      ),
    ),
    "Signing history is missing; restore/fence the signer instead of resetting it",
  );
  requireValue(
    fs.existsSync(path.join(directory, "identity/tunnel.json")),
    "Original home tunnel identity is missing",
  );
  requireValue(
    new RegExp("^graphene-" + identity.stage + "(?:-[a-f0-9]{12})?$").test(
      compose.name,
    ) &&
      compose.services?.abci?.environment?.CHAIN_ID ===
        String(identity.chain_id),
    "Runtime is configured for a different stage or chain",
  );
  // Only these controller-produced files are admitted. Never import identity,
  // passwords, signing state or the controller's cloud credentials.
  const files = [
    "compose.json",
    "network.json",
    "tunnel-policy.json",
    "identity/tendermint/config/config.toml",
    "identity/tendermint/config/genesis.json",
  ];
  if (registered) files.push("validator-admission.json");
  const contents = files.map((relative) =>
    fs.readFileSync(path.join(bundle, relative), "utf8"),
  );
  const env = path.join(directory, ".env");
  if (!fs.existsSync(env)) {
    requireValue(
      !fs.existsSync(path.join(directory, "data/abci-postgres")),
      "Home database credentials are missing; restore their backup before continuing",
    );
  }
  files.forEach((relative, index) =>
    write(path.join(directory, relative), contents[index]),
  );
  if (!fs.existsSync(env)) {
    write(
      env,
      ["ABCI_DB_PASSWORD", "ABCI_ADMIN_PASSWORD", "MPT_DB_API_TOKEN"]
        .map((name) => name + "=" + crypto.randomBytes(32).toString("hex"))
        .join("\n") + "\n",
      "wx",
    );
  }
  return identity;
}

export function writeValidatorReceipt(directory) {
  const identity = read(path.join(directory, "public.json"));
  const network = read(path.join(directory, "network.json"));
  requireValue(
    network.stage === identity.stage && network.chain_id === identity.chain_id,
    "Cannot record a different home network",
  );
  const receipt = {
    schema: 1,
    role: "home",
    stage: identity.stage,
    chain_id: identity.chain_id,
    validator_public_key: identity.validator_public_key,
    network_id: network.network_id,
    compose_sha256: crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(directory, "compose.json")))
      .digest("hex"),
    installed_at: new Date().toISOString(),
  };
  const file = path.join(directory, "home-ready.json");
  write(file, receipt);
  if (process.getuid?.() === 0) {
    const owner = fs.statSync(path.join(directory, "public.json"));
    fs.chownSync(file, owner.uid, owner.gid);
  }
  return file;
}

// Participant checkpoint files use the home layout for both node roles.
// Runs offline in the digest-pinned transport container. No Docker socket or credentials.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createGunzip } from "node:zlib";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const requireValue = (value, message) => {
  if (!value) throw Error(message);
};
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
export const canonical = (v) =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
          .join(",")}}`
      : JSON.stringify(v);
export const genesisHash = (v) =>
  crypto
    .createHash("sha256")
    .update(
      canonical(v).replace(
        /[\u007f-\uffff]/g,
        (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
      ),
    )
    .digest("hex");
export const artifacts = [
  "genesis.json",
  "app-state.json",
  "mpt.tar.gz",
  "tendermint.tar.gz",
];
const tmNames = ["blockstore.db", "state.db", "evidence.db", "tx_index.db"];
const imageKeys = {
  node: "tendermint",
  abci: "abci",
  "abci-db": "postgres",
  mpt: "mpt",
};
async function hash(file) {
  const h = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}
function writeOwned(file, value, owner, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file + ".tmp", JSON.stringify(value), { mode });
  // The loopback console must be able to read recovery metadata on Linux too.
  if (process.getuid?.() === 0) fs.chownSync(file + ".tmp", owner.uid, owner.gid);
  fs.renameSync(file + ".tmp", file);
}
function regular(file) {
  const s = fs.lstatSync(file);
  requireValue(
    s.isFile() && !s.isSymbolicLink(),
    "Snapshot input must be a regular file",
  );
  return s;
}
function safePath(root, relative) {
  const file = path.join(root, relative);
  let current = root;
  requireValue(!fs.lstatSync(root).isSymbolicLink(), "Unsafe node directory");
  for (const part of relative.split("/")) {
    requireValue(part && part !== "." && part !== "..", "Unsafe snapshot path");
    current = path.join(current, part);
    if (fs.existsSync(current))
      requireValue(
        !fs.lstatSync(current).isSymbolicLink(),
        "Snapshot paths cannot traverse links",
      );
  }
  return file;
}
function safeTree(file) {
  const s = fs.lstatSync(file);
  requireValue(
    !s.isSymbolicLink() && (s.isFile() || s.isDirectory()),
    "Snapshot cannot contain links or special files",
  );
  if (s.isDirectory())
    for (const name of fs.readdirSync(file)) safeTree(path.join(file, name));
}
export function sanitizeState(row, chain) {
  requireValue(
    row &&
      String(row.chain_id) === String(chain) &&
      /^[1-9][0-9]*$/.test(String(row.current_height)) &&
      Number.isSafeInteger(Number(row.current_height)),
    "Invalid committed application state",
  );
  for (const key of [
    "current_app_root",
    "current_block_hash",
    "genesis_app_root",
    "genesis_block_hash",
  ])
    requireValue(
      /^0x[a-f0-9]{64}$/i.test(row[key] || ""),
      "Invalid application root",
    );
  const versions =
    typeof row.genesis_versions === "string"
      ? JSON.parse(row.genesis_versions)
      : row.genesis_versions;
  requireValue(
    Array.isArray(versions) &&
      versions.every(
        (v) => typeof v === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(v),
      ),
    "Invalid genesis versions",
  );
  return {
    chain_id: Number(chain),
    session_token: null,
    current_height: String(row.current_height),
    current_app_root: row.current_app_root,
    current_block_hash: row.current_block_hash,
    genesis_app_root: row.genesis_app_root,
    genesis_block_hash: row.genesis_block_hash,
    genesis_versions: JSON.stringify(versions),
  };
}
export function verifyEnvelope(
  envelope,
  fingerprint,
  network,
  genesis,
  images,
  { localVerification = false, maintenance = false, now = Date.now() } = {},
) {
  const m = envelope?.manifest;
  if (!localVerification) {
    requireValue(
      /^[a-f0-9]{64}$/.test(fingerprint || ""),
      "Pin a publisher fingerprint",
    );
    const key = crypto.createPublicKey(envelope.publicKey);
    requireValue(
      crypto
        .createHash("sha256")
        .update(key.export({ type: "spki", format: "der" }))
        .digest("hex") === fingerprint,
      "Wrong snapshot publisher",
    );
    requireValue(
      crypto.verify(
        null,
        Buffer.from(canonical(m)),
        key,
        Buffer.from(envelope.signature || "", "base64"),
      ),
      "Invalid snapshot signature",
    );
  }
  requireValue(
    m?.schema === 2 &&
      m.kind === "graphene-state-snapshot" &&
      /^[a-f0-9]{24}$/.test(m.id),
    "Select a full state snapshot",
  );
  requireValue(
    m.networkId === network.network_id &&
      String(m.chainId) === String(network.chain_id) &&
      m.genesisHash === genesisHash(genesis) &&
      genesisHash(m.genesis) === m.genesisHash,
    "Wrong snapshot network or genesis",
  );
  requireValue(
    /^[1-9][0-9]*$/.test(m.height) &&
      Number.isSafeInteger(Number(m.height)) &&
      /^[a-f0-9]{64}$/i.test(m.appHash) &&
      /^[a-f0-9]{64}$/i.test(m.blockHash),
    "Invalid snapshot anchor",
  );
  requireValue(
    Number.isFinite(Date.parse(m.createdAt)) &&
      Date.parse(m.createdAt) <= now + 60000 &&
      now - Date.parse(m.createdAt) <= 7 * 86400000,
    "Snapshot is expired",
  );
  for (const key of ["tendermint", "abci", "postgres", "mpt", "transport"])
    requireValue(
      /@sha256:[a-f0-9]{64}$/.test(m.images?.[key] || "") &&
        m.images[key] === images[key],
      "Snapshot requires matching release images",
    );
  requireValue(
    Object.keys(m.files || {})
      .sort()
      .join() === artifacts.slice().sort().join(),
    "Invalid snapshot artifact list",
  );
  for (const [name, f] of Object.entries(m.files))
    requireValue(
      /^[a-f0-9]{64}$/.test(f.sha256 || "") &&
        Number.isSafeInteger(f.bytes) &&
        f.bytes > 0 &&
        f.bytes <= (name.endsWith(".json") ? 4 * 1024 ** 2 : 64 * 1024 ** 3) &&
        (!name.endsWith(".gz") ||
          (Number.isSafeInteger(f.unpackedBytes) &&
            f.unpackedBytes > 0 &&
            f.unpackedBytes <= 256 * 1024 ** 3)),
      "Invalid snapshot size or hash",
    );
  if (!localVerification && !maintenance)
    requireValue(
      m.verification?.caughtUp === true &&
        m.verification.nonVoting === true &&
        Number.isSafeInteger(m.verification.height) &&
        m.verification.height > Number(m.height) &&
        /^[a-f0-9]{64}$/i.test(m.verification.appHash || ""),
      "Snapshot has not passed isolated restore verification",
    );
  return m;
}
export async function verifyArchive(
  file,
  kind,
  { maxBytes = 256 * 1024 ** 3, maxEntries = 1000000, compressed = true } = {},
) {
  const input = fs.createReadStream(file);
  const stream = compressed ? input.pipe(createGunzip()) : input;
  if (compressed) input.on("error", (error) => stream.destroy(error));
  let buffer = Buffer.alloc(0),
    remaining = 0,
    bytes = 0,
    entries = 0,
    ended = false;
  const names = new Set();
  try {
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > maxBytes)
        throw new Error("Checkpoint archive exceeds its unpacked size limit.");
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        if (remaining) {
          const take = Math.min(remaining, buffer.length);
          buffer = buffer.subarray(take);
          remaining -= take;
          if (remaining) break;
        }
        if (buffer.length < 512) break;
        const header = buffer.subarray(0, 512);
        buffer = buffer.subarray(512);
        if (header.every((byte) => byte === 0)) {
          ended = true;
          continue;
        }
        if (ended || ++entries > maxEntries)
          throw new Error("Invalid checkpoint tar stream.");
        const field = (start, end) =>
          header.subarray(start, end).toString("utf8").split("\0")[0];
        const checksum = header.reduce(
          (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
          0,
        );
        if (parseInt(field(148, 156).trim(), 8) !== checksum)
          throw new Error("Invalid tar checksum.");
        let name = field(0, 100);
        if (field(345, 500))
          throw new Error("Tar path prefixes are not supported.");
        name = name.replace(/^\.\//, "").replace(/\/$/, "");
        const type = field(156, 157) || "0";
        const mode = parseInt(field(100, 108).trim(), 8);
        if (!Number.isInteger(mode) || mode & 0o7000)
          throw new Error("Privileged archive permissions are forbidden.");
        if (!["0", "5"].includes(type) || field(157, 257))
          throw new Error(
            "Checkpoint archives cannot contain links or special entries.",
          );
        const allowed =
          kind === "mpt"
            ? /^(db|db\/(state|blocks|receipts|transactions)(\/[a-zA-Z0-9_.-]+)*)$/
            : /^(blockstore\.db|state\.db|evidence\.db|tx_index\.db)(\/[a-zA-Z0-9_.-]+)*$/;
        if (
          !allowed.test(name) ||
          name.split("/").some((part) => part === ".." || part === ".") ||
          names.has(name)
        )
          throw new Error(
            `Unsafe or duplicate checkpoint archive path: ${name}`,
          );
        if (
          type === "0" &&
          !/^(?:[0-9]{6,}\.(?:ldb|sst|log)|MANIFEST-[0-9]{6,}|CURRENT(?:\.bak)?|LOCK|LOG(?:\.old)?)$/.test(
            path.posix.basename(name),
          )
        )
          throw new Error(
            "Only native LevelDB files may appear in checkpoint archives; identity/configuration files are forbidden.",
          );
        names.add(name);
        const sizeText = field(124, 136).trim();
        if (!/^[0-7]+$/.test(sizeText))
          throw new Error("Invalid tar entry size.");
        const size = parseInt(sizeText, 8);
        if (
          !Number.isSafeInteger(size) ||
          size > maxBytes ||
          (type === "5" && size !== 0)
        )
          throw new Error("Invalid tar entry.");
        remaining = Math.ceil(size / 512) * 512;
      }
    }
    if (remaining || buffer.length || !ended || !entries)
      throw new Error("Truncated checkpoint archive.");
    if (
      kind === "mpt" &&
      !["state", "blocks", "receipts", "transactions"].every((name) =>
        names.has(`db/${name}`),
      )
    )
      throw new Error("Incomplete trie checkpoint.");
    if (
      kind === "tendermint" &&
      !["blockstore.db", "state.db", "evidence.db", "tx_index.db"].every(
        (name) => names.has(name),
      )
    )
      throw new Error("Incomplete Tendermint checkpoint.");
    return { entries, bytes };
  } finally {
    input.destroy();
    stream.destroy();
  }
}

async function protectedFiles(root) {
  const names = [
    ".env",
    "identity/tendermint/config/node_key.json",
    "identity/tendermint/config/priv_validator_key.json",
    "identity/tendermint/data/priv_validator_state.json",
    "identity/tunnel.json",
    "identity/keystore.enc",
    "identity/recovery-passphrase",
  ];
  const result = {};
  for (const name of names) {
    const file = safePath(root, name);
    if (fs.existsSync(file)) {
      regular(file);
      result[name] = await hash(file);
    }
  }
  requireValue(
    result[names[1]] && result[names[2]] && result[names[3]],
    "Original node identity and signing history are required",
  );
  return result;
}
function fresh(root) {
  const tm = "identity/tendermint/data";
  const state = read(safePath(root, tm + "/priv_validator_state.json"));
  requireValue(
    String(state.height) === "0" &&
      Number(state.round) === 0 &&
      Number(state.step) === 0,
    "Automatic restore requires a fresh signer with no signing history",
  );
  for (const name of tmNames)
    requireValue(
      !fs.existsSync(safePath(root, tm + "/" + name)),
      "Existing consensus data cannot be replaced",
    );
  for (const relative of [
    "data/mpt/db",
    "data/abci-postgres",
    "data/evm-postgres",
  ]) {
    const f = safePath(root, relative);
    requireValue(
      !fs.existsSync(f) || fs.readdirSync(f).length === 0,
      "Existing application data cannot be replaced",
    );
  }
}
export async function operate(data, root = "/node") {
  const owner = regular(safePath(root, "public.json"));
  const write = (file, value) => writeOwned(file, value, owner);
  requireValue(/^[a-f0-9]{24}$/.test(data.id || ""), "Invalid snapshot ID");
  requireValue(
    ["sentry", "validator"].includes(data.role),
    "Invalid snapshot target role",
  );
  const work = safePath(root, "data/.checkpoint-work/" + data.id),
    capture = safePath(root, "data/.checkpoint-work/" + data.id + "/capture");
  const network = read(safePath(root, "network.json")),
    genesis = read(safePath(root, "identity/tendermint/config/genesis.json")),
    compose = read(safePath(root, "compose.json"));
  requireValue(network.network_id === data.networkId, "Wrong node network");
  const tm = "identity/tendermint/data";
  requireValue(!data.localVerification && !data.maintenanceOperation,
    "Participants require a signed public snapshot");
  requireValue(["validate", "prepare", "install", "finish", "activate", "complete"].includes(data.action),
    "Unsupported participant snapshot operation");
  const envelope = data.envelope;
  const images = { ...data.images };
  for (const [service, key] of Object.entries(imageKeys))
    requireValue(
      compose.services[service]?.image === images[key],
      "Target runtime image differs from selected release",
    );
  const m = verifyEnvelope(
    envelope,
    data.fingerprint,
    network,
    genesis,
    images,
  );
  requireValue(m.id === data.id, "Wrong snapshot selection");
  if (data.action === "validate") return { valid: true };
  const input = capture;
  for (const name of artifacts) {
    const file = path.join(input, name),
      info = regular(file);
    requireValue(
      info.size === m.files[name].bytes &&
        (await hash(file)) === m.files[name].sha256,
      "Snapshot artifact checksum mismatch",
    );
  }
  const state = sanitizeState(
    read(path.join(input, "app-state.json")),
    m.chainId,
  );
  requireValue(
    state.current_height === m.height &&
      state.current_app_root.slice(2).toLowerCase() ===
        m.appHash.toLowerCase() &&
      genesisHash(read(path.join(input, "genesis.json"))) === m.genesisHash,
    "Snapshot metadata differs from signed manifest",
  );
  const journalFile = safePath(root, ".checkpoint-restore.json"),
    fence = safePath(root, ".rollout-fence.json");
  let previous = fs.existsSync(journalFile) ? read(journalFile) : null;
  if (previous)
    requireValue(
      previous.id === data.id,
      "A different snapshot restore needs recovery",
    );
  const protectedNow = await protectedFiles(root);
  if (previous?.phase === "complete")
    return { phase: "complete", height: m.height };
  const signingState =
    "identity/tendermint/data/priv_validator_state.json";
  if (previous?.phase === "verified") {
    delete protectedNow[signingState];
    const expected = { ...previous.protected };
    delete expected[signingState];
    requireValue(
      canonical(protectedNow) === canonical(expected),
      "Node identity changed during activation",
    );
  }
  if (data.action === "complete") {
    requireValue(
      previous?.phase === "verified",
      "Verify before recording completion",
    );
    write(journalFile, {
      ...previous,
      phase: "complete",
      height: m.height,
      completedAt: new Date().toISOString(),
    });
    return { phase: "complete", height: m.height };
  }
  if (previous && previous.phase !== "verified")
    requireValue(
      canonical(protectedNow) === canonical(previous.protected),
      "Node identity or signing history changed during restore",
    );
  if (fs.existsSync(fence)) {
    const owner = read(fence),
      pending =
        owner.kind === "snapshot-bootstrap-pending" &&
        (!owner.operationId || owner.operationId === data.id);
    requireValue(
      (pending && data.action === "prepare" && !previous) ||
        (owner.kind === "snapshot-restore" && owner.operationId === data.id),
      "Another maintenance operation owns this node",
    );
  }
  if (data.action === "prepare") {
    for (const name of ["mpt.tar.gz", "tendermint.tar.gz"]) {
      const stats = await verifyArchive(
        path.join(input, name),
        name === "mpt.tar.gz" ? "mpt" : "tendermint",
        { maxBytes: m.files[name].unpackedBytes },
      );
      requireValue(
        stats.bytes === m.files[name].unpackedBytes,
        "Snapshot unpacked size differs from manifest",
      );
    }
    if (!previous) fresh(root);
    write(fence, {
      kind: "snapshot-restore",
      operationId: data.id,
      networkId: m.networkId,
    });
    const journal = previous || {
      id: data.id,
      phase: "prepared",
      protected: protectedNow,
      manifestHash: genesisHash(m),
    };
    requireValue(
      journal.manifestHash === genesisHash(m),
      "Snapshot selection changed during restore",
    );
    write(journalFile, journal);
    return { phase: journal.phase, height: m.height };
  }
  requireValue(
    previous && fs.existsSync(fence),
    "Prepare and fence the target before restoring",
  );
  if (data.action === "install") {
    if (!["files-installed", "verified"].includes(previous.phase)) {
      const staged = path.join(work, "unpacked"),
        complete = path.join(work, "unpacked.complete");
      if (!fs.existsSync(complete)) {
        fs.rmSync(staged, { recursive: true, force: true });
        fs.mkdirSync(staged, { recursive: true, mode: 0o700 });
        for (const name of ["mpt.tar.gz", "tendermint.tar.gz"])
          execFileSync(
            "tar",
            [
              "-xzf",
              path.join(input, name),
              "--no-same-permissions",
              "-C",
              staged,
            ],
            { timeout: 3600000 },
          );
        safeTree(staged);
        write(complete, { id: data.id });
      }
      safeTree(staged);
      const pairs = [
        ["db", "data/mpt/db"],
        ...tmNames.map((n) => [n, tm + "/" + n]),
      ];
      for (const [name, dest] of pairs) {
        const from = path.join(staged, name),
          to = safePath(root, dest),
          backup = path.join(work, "previous", name);
        fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
        fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
        if (fs.existsSync(from)) {
          if (fs.existsSync(to)) {
            requireValue(!fs.existsSync(backup), "Conflicting restore backup");
            fs.renameSync(to, backup);
          }
          fs.renameSync(from, to);
        } else
          requireValue(
            fs.existsSync(to),
            "Interrupted snapshot installation is incomplete",
          );
      }
      write(journalFile, { ...previous, phase: "files-installed" });
    }
    const schema = compose.services.abci.environment.APP_ABCI_DB_SCHEMA;
    requireValue(
      /^[a-z_][a-z0-9_]*$/.test(schema),
      "Invalid application schema",
    );
    const literal = JSON.stringify(state).replaceAll("'", "''");
    return {
      phase: "files-installed",
      sql: `BEGIN; DELETE FROM ${schema}.app_states WHERE chain_id=${m.chainId}; INSERT INTO ${schema}.app_states SELECT * FROM json_populate_record(NULL::${schema}.app_states, '${literal}'::json); COMMIT;`,
    };
  }
  if (data.action === "finish") {
    requireValue(
      data.appHash?.toLowerCase() === m.appHash.toLowerCase(),
      "Restored application root does not match the signed snapshot",
    );
    requireValue(
      canonical(await protectedFiles(root)) ===
        canonical(previous.protected),
      "Protected node files changed during restore",
    );
    write(journalFile, { ...previous, phase: "verified" });
    return { phase: "verified" };
  }
  if (data.action === "activate") {
    requireValue(
      previous.phase === "verified",
      "Verify restored data before activation",
    );
    fs.unlinkSync(fence);
    return { phase: "complete", height: m.height };
  }
  throw Error("Unsupported snapshot file operation");
}
if (process.env.GRAPHENE_SNAPSHOT_HELPER === "1") {
  let input = "";
  for await (const part of process.stdin) input += part;
  try {
    console.log(JSON.stringify(await operate(JSON.parse(input))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

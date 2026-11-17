import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const requireCondition = (value, message) => {
  if (!value) throw new Error(message);
};
function validate(root, id, role, nodeId) {
  requireCondition(
    /^[a-f0-9]{64}$/.test(id) &&
      ["validator", "sentry"].includes(role) &&
      (nodeId === role || /^node-[a-f0-9]{12}$/.test(nodeId)),
    "Select a valid node.",
  );
  requireCondition(
    path.isAbsolute(root),
    "Use an absolute participant directory.",
  );
}
export function planNodeFiles(root, id, role, nodeId = role) {
  validate(root, id, role, nodeId);
  const nodeRoot =
      nodeId === role
        ? path.join(root, id)
        : path.join(root, id, "instances", nodeId),
    directory = path.join(nodeRoot, role);
  const paths =
    nodeId === role
      ? [
          directory,
          path.join(nodeRoot, role + "-host.json"),
          path.join(root, id, "ssh", role),
        ]
      : [nodeRoot];
  paths.push(
    path.join(root, id, "node-records", nodeId + ".json"),
    path.join(root, id, "node-invitations", nodeId + ".json"),
  );
  const protectedFiles = [
    path.join(directory, "public.json"),
    path.join(directory, "compose.json"),
    path.join(nodeRoot, role + "-host.json"),
  ];
  for (const target of [...paths, directory, ...protectedFiles]) {
    requireCondition(
      path.resolve(target).startsWith(path.resolve(root, id) + path.sep),
      "Refusing to delete outside this node's workspace.",
    );
    let ancestor = target;
    while (ancestor !== path.resolve(root)) {
      if (fs.existsSync(ancestor))
        requireCondition(
          !fs.lstatSync(ancestor).isSymbolicLink(),
          "Resolve symbolic links before removing a node.",
        );
      ancestor = path.dirname(ancestor);
    }
  }
  const files = paths.filter((file) => fs.existsSync(file));
  const entries = files.map((file) => {
    const stat = fs.lstatSync(file);
    return { file, dev: stat.dev, ino: stat.ino, birthtime: stat.birthtimeMs };
  });
  const bindings = protectedFiles
    .filter((file) => fs.existsSync(file))
    .map((file) => ({ file, hash: hash(fs.readFileSync(file)) }));
  const project = "graphene-join-" + hash(directory).slice(0, 16) + "-" + role;
  const fingerprint = hash(
    JSON.stringify({ id, role, nodeId, entries, bindings, project }),
  );
  return {
    id,
    role,
    nodeId,
    directory,
    project,
    files,
    entries,
    bindings,
    fingerprint,
    hasCompose: fs.existsSync(path.join(directory, "compose.json")),
  };
}
export function removedNodeReceipt(root, id, role, nodeId, fingerprint) {
  validate(root, id, role, nodeId);
  const file = path.join(root, id, "removed-nodes", nodeId + ".json");
  if (!fs.existsSync(file)) return null;
  const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  return receipt.fingerprint === fingerprint ? receipt : null;
}
async function localDocker(directory, project, args) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("COMPOSE_")) delete env[key];
  const endpoint =
    (!env.DOCKER_CONTEXT && env.DOCKER_HOST) ||
    (
      await exec(
        "docker",
        ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
        { env, timeout: 15000 },
      )
    ).stdout.trim();
  requireCondition(
    /^(unix:\/\/\/|npipe:\/\/\/)/.test(endpoint),
    "Select the deployment host's local Docker engine.",
  );
  delete env.DOCKER_CONTEXT;
  env.DOCKER_HOST = endpoint;
  await exec(
    "docker",
    ["compose", "--project-name", project, "--file", "compose.json", ...args],
    { cwd: directory, env, timeout: 120000, maxBuffer: 1024 * 1024 },
  );
}
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + "." + randomBytes(6).toString("hex");
  fs.writeFileSync(temporary, JSON.stringify(value) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(temporary, file);
}
export async function deleteNodeFiles(
  root,
  id,
  role,
  nodeId,
  fingerprint,
  { runner = localDocker, stopContainers = true, resumePlan } = {},
) {
  const receipt = removedNodeReceipt(root, id, role, nodeId, fingerprint);
  if (receipt) return receipt;
  const current = planNodeFiles(root, id, role, nodeId),
    plan = resumePlan || current;
  requireCondition(
    plan.fingerprint === fingerprint &&
      (resumePlan || current.fingerprint === fingerprint),
    "Node configuration changed. Review removal again.",
  );
  for (const entry of plan.entries)
    if (fs.existsSync(entry.file)) {
      const stat = fs.lstatSync(entry.file);
      requireCondition(
        stat.dev === entry.dev &&
          stat.ino === entry.ino &&
          stat.birthtimeMs === entry.birthtime &&
          !stat.isSymbolicLink(),
        "Node files were replaced. Stop and review this removal.",
      );
    }
  for (const binding of plan.bindings)
    if (fs.existsSync(binding.file))
      requireCondition(
        hash(fs.readFileSync(binding.file)) === binding.hash,
        "Node configuration changed during removal. Restore the reviewed configuration before retrying.",
      );
  // A saved plan is trusted only when it still describes the exact namespace.
  const allowed = new Set(current.files);
  for (const target of plan.files)
    requireCondition(
      !fs.existsSync(target) || allowed.has(target),
      "A removal path no longer belongs to this node.",
    );
  if (current.hasCompose && stopContainers)
    await runner(current.directory, plan.project, [
      "down",
      "--volumes",
      "--remove-orphans",
      "--timeout",
      "30",
    ]);
  for (const target of plan.files)
    fs.rmSync(target, { recursive: true, force: true });
  const result = {
    removed: true,
    nodeId,
    fingerprint,
    time: new Date().toISOString(),
  };
  write(path.join(root, id, "removed-nodes", nodeId + ".json"), result);
  return result;
}
if (process.argv[1] === "--node-removal") {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 16384) throw new Error("Invalid removal request.");
  }
  try {
    const body = JSON.parse(input),
      root = path.join(os.homedir(), ".graphene", "participants"),
      nodeId = body.nodeId || body.role;
    validate(root, body.id, body.role, nodeId);
    const journal = path.join(
      root,
      "removal-journals",
      body.id + "-" + nodeId + ".json",
    );
    let result;
    if (body.action === "preview")
      result = planNodeFiles(root, body.id, body.role, nodeId);
    else {
      requireCondition(body.action === "remove", "Invalid removal action.");
      const receipt = removedNodeReceipt(
        root,
        body.id,
        body.role,
        nodeId,
        body.fingerprint,
      );
      if (receipt) result = receipt;
      else {
        const plan = fs.existsSync(journal)
          ? JSON.parse(fs.readFileSync(journal, "utf8"))
          : planNodeFiles(root, body.id, body.role, nodeId);
        requireCondition(
          plan.fingerprint === body.fingerprint,
          "Remote configuration changed. Review removal again.",
        );
        write(journal, plan);
        result = await deleteNodeFiles(
          root,
          body.id,
          body.role,
          nodeId,
          body.fingerprint,
          { resumePlan: plan },
        );
        fs.unlinkSync(journal);
      }
    }
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.message }));
  }
}

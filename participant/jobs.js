import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, createHash } from "node:crypto";

const execution = new AsyncLocalStorage();
export const withJobContext = (context, operation) =>
  execution.run(context, operation);
export const jobContext = () => execution.getStore();
export const logOutput = (text) => execution.getStore()?.append(String(text));
const privateWrite = (file, value) => {
  const temp = file + "." + randomBytes(6).toString("hex");
  fs.writeFileSync(temp, JSON.stringify(value) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(temp, file);
};
export function environmentSecrets(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
      return match &&
        /PASSWORD|PASSPHRASE|TOKEN|SECRET|PRIVATE_KEY/.test(match[1])
        ? [match[2].replace(/^['"]|['"]$/g, "")]
        : [];
    });
}
export function secretValues(value, key = "") {
  if (!value || typeof value !== "object")
    return typeof value === "string" &&
      /password|passphrase|secret|token|private.?key|serviceAccountJson/i.test(
        key,
      )
      ? [value]
      : [];
  return Object.entries(value).flatMap(([name, item]) =>
    secretValues(item, name),
  );
}
export function redact(text, secrets = []) {
  for (const secret of secrets
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    text = text.split(secret).join("[REDACTED]");
  return text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(
      /((?:password|passphrase|secret|token|private_key|accessKeyId|secretAccessKey)[\w-]*["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      "$1[REDACTED]",
    );
}
const safeResult = (value, secrets) => {
  if (value === undefined) return { ok: true };
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value))
    return value.map((item) => safeResult(item, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /password|passphrase|secret|token|private.?key|seed|keystore/i.test(key)
          ? "[REDACTED]"
          : safeResult(item, secrets),
      ]),
    );
  return value;
};
export class Jobs {
  constructor(root) {
    this.directory = path.join(root, "jobs");
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.rows = new Map();
    this.active = new Map();
    for (const name of fs
      .readdirSync(this.directory)
      .filter((name) => /^[a-f0-9]{24}\.json$/.test(name))) {
      const file = path.join(this.directory, name);
      try {
        if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
          continue;
        const job = JSON.parse(fs.readFileSync(file, "utf8"));
        if (name !== job.id + ".json") continue;
        if (job.status === "running") {
          job.status = "interrupted";
          job.endedAt = new Date().toISOString();
          job.message =
            "The console restarted before this run completed. Inspect the server before retrying.";
          privateWrite(file, job);
        }
        this.rows.set(job.id, job);
      } catch {
        /* Ignore incomplete unrelated files; never execute persisted input. */
      }
    }
    const legacy = path.join(root, "activity.jsonl");
    const migrated = path.join(this.directory, ".legacy-imported");
    if (!fs.existsSync(migrated) && fs.existsSync(legacy))
      for (const line of fs
        .readFileSync(legacy, "utf8")
        .split("\n")
        .filter(Boolean)) {
        try {
          const old = JSON.parse(line),
            id = /^[a-f0-9]{24}$/.test(old.runId || "")
              ? old.runId
              : createHash("sha256").update(line).digest("hex").slice(0, 24);
          if (
            this.rows.has(id) ||
            [...this.rows.values()].some(
              (job) =>
                job.legacy &&
                job.action === old.action &&
                job.networkId === old.id &&
                job.endedAt === old.time &&
                job.nodeId === old.nodeId,
            )
          )
            continue;
          const endedAt = old.time,
            startedAt = new Date(
              Date.parse(endedAt) - (old.durationMs || 0),
            ).toISOString();
          const row = {
            id,
            networkId: old.id,
            role: old.role,
            nodeId: old.nodeId,
            action: old.action,
            status: old.ok ? "succeeded" : "failed",
            startedAt,
            endedAt,
            exitCode: old.ok ? 0 : 1,
            legacy: true,
            message:
              "Imported activity record. Command output was not recorded for this run.",
          };
          this.rows.set(id, row);
          privateWrite(this.file(id), row);
        } catch {
          /* A malformed legacy record must not prevent startup. */
        }
      }
    if (!fs.existsSync(migrated)) privateWrite(migrated, { completed: true });
  }
  file(id, suffix = ".json") {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Invalid run ID.");
    return path.join(this.directory, id + suffix);
  }
  get(id) {
    const job = this.rows.get(id);
    if (!job) throw new Error("Run not found.");
    return { ...job };
  }
  list(networkId) {
    return [...this.rows.values()]
      .filter(
        (job) => !networkId || job.networkId === networkId || !job.networkId,
      )
      .sort(
        (a, b) =>
          Date.parse(b.startedAt) - Date.parse(a.startedAt) ||
          b.id.localeCompare(a.id),
      )
      .map((job) => ({ ...job, result: undefined }));
  }
  logs(id) {
    this.get(id);
    const file = this.file(id, ".log");
    if (!fs.existsSync(file)) return { text: "", truncated: false };
    const size = fs.statSync(file).size,
      start = Math.max(0, size - 262144),
      bytes = Buffer.alloc(size - start),
      fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, bytes, 0, bytes.length, start);
    } finally {
      fs.closeSync(fd);
    }
    return {
      text: bytes.toString("utf8"),
      truncated: start > 0 || !!this.get(id).truncated,
      cursor: size,
    };
  }
  start(metadata, operation, { secrets = [] } = {}) {
    const job = {
      ...metadata,
      id: randomBytes(12).toString("hex"),
      status: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
    };
    const controller = new AbortController();
    let pending = "",
      closed = false;
    const logFile = this.file(job.id, ".log");
    fs.writeFileSync(logFile, "", { mode: 0o600, flag: "wx" });
    const write = (text) => {
      fs.appendFileSync(logFile, redact(text, secrets));
      if (fs.statSync(logFile).size > 4 * 1024 * 1024) {
        const tail = this.logs(job.id).text;
        fs.writeFileSync(logFile, tail, { mode: 0o600 });
        job.truncated = true;
      }
    };
    const append = (text) => {
      if (closed) return;
      pending += text;
      let last = pending.lastIndexOf("\n");
      const keyStart = pending.search(/-----BEGIN [^-]*PRIVATE KEY-----/);
      if (
        keyStart >= 0 &&
        !/-----END [^-]*PRIVATE KEY-----/.test(pending.slice(keyStart))
      )
        last = pending.lastIndexOf("\n", keyStart - 1);
      if (last >= 0) {
        write(pending.slice(0, last + 1));
        pending = pending.slice(last + 1);
      }
      const keep = Math.max(4096, ...secrets.map((s) => s.length));
      if (keyStart < 0 && pending.length > keep * 2) {
        write(pending.slice(0, -keep));
        pending = pending.slice(-keep);
      }
    };
    this.rows.set(job.id, job);
    this.active.set(job.id, controller);
    privateWrite(this.file(job.id), job);
    const promise = execution.run(
      {
        id: job.id,
        signal: controller.signal,
        append,
        updateTarget: (target) => Object.assign(job, target),
      },
      async () => {
        write(
          `[${job.startedAt}] ${job.action}${job.nodeName ? " · " + job.nodeName : ""}\n`,
        );
        try {
          const result = await operation();
          job.result = safeResult(result, secrets);
          if (!job.networkId && /^[a-f0-9]{64}$/.test(result?.id || ""))
            job.networkId = result.id;
          if (result?.nodeId && /^node-[a-f0-9]{12}$/.test(result.nodeId)) {
            job.nodeId = result.nodeId;
            job.nodeName = result.name || job.nodeName;
          }
          if (
            [
              "status",
              "health",
              "inspect",
              "network-health",
              "review",
            ].includes(job.action)
          )
            append(
              typeof job.result.text === "string"
                ? job.result.text + "\n"
                : JSON.stringify(job.result, null, 2) + "\n",
            );
          job.status = controller.signal.aborted
            ? "cancelled"
            : job.action === "inspect" &&
                Object.values(result?.checks || {}).some((check) => !check.ok)
              ? "needs-attention"
              : "succeeded";
          job.exitCode = controller.signal.aborted ? null : 0;
          return result;
        } catch (error) {
          job.status = controller.signal.aborted ? "cancelled" : "failed";
          job.exitCode = controller.signal.aborted ? null : 1;
          job.message = redact(error.message, secrets);
          append(job.message + "\n");
          throw error;
        } finally {
          if (controller.signal.aborted)
            job.message =
              "Cancellation requested. Inspect the server before retrying; completed changes may remain.";
          job.endedAt = new Date().toISOString();
          append(`[${job.endedAt}] ${job.status}\n`);
          write(pending);
          pending = "";
          closed = true;
          privateWrite(this.file(job.id), job);
          this.active.delete(job.id);
        }
      },
    );
    // Background callers do not need to hold an HTTP connection open.
    promise.catch(() => {});
    return { job: this.get(job.id), promise };
  }
  cancel(id) {
    this.get(id);
    const controller = this.active.get(id);
    if (!controller) throw new Error("Only running jobs can be cancelled.");
    controller.abort();
    return { ok: true };
  }
  remove(id) {
    const job = this.get(id);
    if (job.status === "running")
      throw new Error("Running jobs cannot be deleted.");
    for (const suffix of [".json", ".log"])
      fs.rmSync(this.file(id, suffix), { force: true });
    this.rows.delete(id);
  }
}

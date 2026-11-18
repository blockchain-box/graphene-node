// No listening port on cloud hosts. Only authenticated SSH stdin can invoke this worker.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  withJobContext,
  jobContext,
  redact,
  environmentSecrets,
} from "./jobs.js";
import { inspectNode } from "./inspection.js";
import { Participants } from "./runtime.js";
console.log = console.error; // Reserve stdout for the bounded JSON response.
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 16 * 1024 * 1024)
    throw new Error("Host request is too large.");
}
let nodes = new Participants(
  path.join(os.homedir(), ".graphene", "participants"),
);
let pendingOutput = "",
  remoteSecrets = [];
const emitOutput = (text) => {
  pendingOutput += text;
  const last = pendingOutput.lastIndexOf("\n");
  if (last >= 0) {
    process.stderr.write(
      redact(pendingOutput.slice(0, last + 1), remoteSecrets),
    );
    pendingOutput = pendingOutput.slice(last + 1);
  }
};
try {
  await withJobContext({ append: emitOutput }, async () => {
    const { action, body: b } = JSON.parse(input);
    if (action === "remove-node") {
      const receipt = nodes.removedReceipt(
        b.id,
        b.role,
        b.nodeId || b.role,
        b.fingerprint,
      );
      if (receipt) {
        process.stdout.write(JSON.stringify(receipt));
        process.exit(0);
      }
    }
    if (action !== "import") nodes = nodes.selectNode(b.id, b.role, b.nodeId);
    if (action !== "import")
      remoteSecrets = environmentSecrets(
        path.join(nodes.dir(b.id, b.role), ".env"),
      );
    let result;
    if (action === "inspect") result = await inspectNode(nodes, b.id, b.role);
    else if (action === "inventory") result = nodes.inventory();
    else if (action === "remove-preview")
      result = nodes.removalPlan(b.id, b.role);
    else if (action === "remove-node")
      result = await nodes.removeNode(b.id, b.role, b.fingerprint);
    else if (action === "import") {
      let id;
      try {
        id = nodes.import(b.raw, b.fingerprint);
      } catch (error) {
        if (!b.updateInvitation || !/different invitation/.test(error.message))
          throw error;
        const { createHash } = await import("node:crypto");
        const fingerprint = createHash("sha256")
          .update(fs.readFileSync(nodes.invitationFile(b.id)))
          .digest("hex");
        id = nodes.updateInvitation(b.raw, b.fingerprint, fingerprint);
      }
      if (b.nodeId) nodes.createNode(id, b.role, b.name, b.nodeId);
      result = { id };
    } else if (action === "identity")
      result = nodes.identity(b.id, b.operator, b.password);
    else if (action === "prepare-validator-public")
      result = nodes.prepareInvitedValidator(b.id);
    else if (action === "prepare-sentry")
      result = nodes.prepareSentry(b.id, b.address, b.peer, b);
    else if (action === "connection")
      result = nodes.configureConnection(b.id, b.role, b.peer);
    else if (action === "sentry-invitation")
      result = nodes.sentryInvitation(b.id);
    else if (action === "review") result = nodes.reviewDeployment(b.id, b.role);
    else if (action === "checkpoint-select")
      result = nodes.selectCheckpoint(
        b.id,
        b.role,
        b.raw,
        b.fingerprint,
        b.baseUrl,
      );
    else if (action === "checkpoint-restore")
      result = await nodes.restore(b.id, b.role);
    else if (action === "prepare-validator") {
      const temporary = fs.mkdtempSync(
        path.join(os.tmpdir(), "graphene-admission-"),
      );
      try {
        const allowed = [
          "validator-admission.json",
          "compose.json",
          "network.json",
          "tunnel-policy.json",
          "identity/tendermint/config/config.toml",
          "identity/tendermint/config/genesis.json",
        ];
        for (const name of allowed) {
          if (typeof b.files?.[name] !== "string")
            throw new Error("Incomplete admission bundle.");
          const file = path.join(temporary, name);
          fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
          fs.writeFileSync(file, b.files[name], { mode: 0o600 });
        }
        result = nodes.prepareValidator(b.id, temporary);
      } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    } else result = await nodes.operate(b.id, b.role, action);
    if (action === "logs")
      result = { ...result, outputStreamed: !!jobContext()?.outputCaptured };
    process.stderr.write(redact(pendingOutput, remoteSecrets));
    process.stdout.write(JSON.stringify(result ?? { ok: true }));
  });
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error.message }));
}

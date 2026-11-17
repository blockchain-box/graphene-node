import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { invitationFromUrl } from "./invitation-api.js";
import { check, validateInvitation } from "./runtime.js";
import { isDeepStrictEqual } from "node:util";

export const publicNetworks = [
  { id: "dev", label: "Development", stage: "dev", api: "https://api.dev.zlinkchain.io" },
  { id: "test", label: "Staging", stage: "staging", api: "https://api.test.zlinkchain.io" },
  { id: "prod", label: "Production", stage: "production", api: "https://api.zlinkchain.io" },
];

// These application-owned HTTPS origins are the trust anchors. The caller does
// not supply network data or a checksum; frozen-network checks still apply.
export class PublicWorkspaces {
  constructor(nodes, fetchInvitation = invitationFromUrl, now = Date.now) {
    this.nodes = nodes;
    this.fetchInvitation = fetchInvitation;
    this.now = now;
    this.file = path.join(nodes.root, "public-workspaces.json");
    this.pending = new Map();
    this.candidates = new Map();
    let saved = {};
    if (fs.existsSync(this.file)) {
      try { saved = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { /* Rediscover from the public APIs. */ }
    }
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) saved = {};
    this.rows = publicNetworks.map((spec) => {
      const row = { ...spec, invitationUrl: spec.api + "/api/invitation", networkId: null, checkedAt: null, error: null, update: null };
      const id = saved[spec.id] || nodes.inventory().find((network) => network.stage === spec.stage && new URL(network.rpc).origin === spec.api)?.id;
      if (typeof id === "string" && /^[a-f0-9]{64}$/.test(id)) {
        try {
          const invite = nodes.network(id);
          if (invite.network.stage === spec.stage && new URL(invite.rpc).origin === spec.api) row.networkId = id;
        } catch { /* A missing cache never blocks discovery. */ }
      }
      return row;
    });
  }
  snapshot() {
    return this.rows.map((row) => ({ ...row }));
  }
  save() {
    const temporary = this.file + "." + randomBytes(6).toString("hex");
    fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.rows.filter((row) => row.networkId).map((row) => [row.id, row.networkId]))) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, this.file);
  }
  async refresh(id, force = false) {
    check(id === undefined || this.rows.some((row) => row.id === id), "Choose Dev, Test or Prod.");
    await Promise.all(this.rows.filter((row) => id === undefined || row.id === id).map((row) => {
      if (this.pending.has(row.id)) return this.pending.get(row.id);
      if (!force && row.checkedAt !== null && this.now() - row.checkedAt < 60000) return;
      const task = Promise.resolve().then(async () => {
        try {
          const raw = await this.fetchInvitation(row.invitationUrl);
          const fingerprint = createHash("sha256").update(raw).digest("hex");
          const invitation = validateInvitation(raw, fingerprint);
          check(invitation.network.stage === row.stage, "The public API returned an invitation for another stage.");
          check(new URL(invitation.rpc).origin === row.api, "The invitation's wallet RPC does not match this workspace API.");
          const installedId = row.networkId || invitation.network.network_id;
          const file = path.join(this.nodes.root, installedId, "invitation.json");
          if (fs.existsSync(file)) {
            const previous = fs.readFileSync(file, "utf8");
            const installed = JSON.parse(previous);
            if (!isDeepStrictEqual(installed, invitation)) {
              row.networkId = installedId;
              row.update = { fingerprint, currentRelease: installed.release, release: invitation.release,
                networkChanged: installedId !== invitation.network.network_id };
              this.candidates.set(row.id, { raw, fingerprint, previousFingerprint: createHash("sha256").update(previous).digest("hex"), installedId });
              row.error = null;
              this.save();
              return;
            }
          }
          row.networkId = this.nodes.import(raw, fingerprint);
          row.error = null;
          row.update = null;
          this.candidates.delete(row.id);
          this.save();
        } catch (error) {
          row.error = error.message;
        } finally {
          row.checkedAt = this.now();
          this.pending.delete(row.id);
        }
      });
      this.pending.set(row.id, task);
      return task;
    }));
    return this.snapshot();
  }
  async update(id, fingerprint) {
    check(typeof fingerprint === "string" && /^[a-f0-9]{64}$/.test(fingerprint), "Review the available network update first.");
    await this.refresh(id, true);
    const row = this.rows.find((row) => row.id === id);
    check(!row.error, row.error);
    const candidate = this.candidates.get(id);
    check(candidate && candidate.fingerprint === fingerprint, "The API invitation changed. Review the latest update before continuing.");
    check(!row.update.networkChanged, "The API advertises a different frozen network. Existing nodes cannot be moved by an invitation update.");
    row.networkId = this.nodes.updateInvitation(candidate.raw, fingerprint, candidate.previousFingerprint);
    row.error = null;
    row.update = null;
    this.candidates.delete(id);
    this.save();
    return { networkId: row.networkId };
  }
}

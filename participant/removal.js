import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { check, Participants } from "./runtime.js";
import { Hosts } from "./hosts.js";
import { CloudAccounts } from "./cloud-accounts.js";
import { CloudRemoval } from "./cloud-removal.js";
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class NodeRemoval {
  constructor(
    nodes,
    {
      accounts = new CloudAccounts(nodes.root),
      makeHosts = (scope) => new Hosts(scope),
      makeCloud = (account, identity) => new CloudRemoval(account, identity),
    } = {},
  ) {
    this.nodes = nodes;
    this.accounts = accounts;
    this.makeHosts = makeHosts;
    this.makeCloud = makeCloud;
  }
  file(id, role, nodeId) {
    check(
      /^[a-f0-9]{64}$/.test(id) &&
        ["validator", "sentry"].includes(role) &&
        (nodeId === role || /^node-[a-f0-9]{12}$/.test(nodeId)),
      "Select a valid node.",
    );
    return path.join(this.nodes.root, "removals", id + "-" + nodeId + ".json");
  }
  save(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const next = file + "." + randomBytes(6).toString("hex");
    fs.writeFileSync(next, JSON.stringify(value) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(next, file);
  }
  public(plan) {
    return {
      token: plan.token,
      nodeId: plan.nodeId,
      name: plan.name,
      role: plan.role,
      project: plan.local.project,
      accountName: plan.accountName || null,
      cloud: plan.host.kind === "cloud" ? plan.host.provider : null,
      cloudHost: plan.cloud?.identity.id || null,
      files: plan.local.files,
      remoteFiles: plan.remote?.files || [],
      resources: (plan.cloud?.resources || []).map(({ type, id, name }) => ({
        type,
        id,
        name,
      })),
      retained: [...(plan.retained || []), ...(plan.cloud?.retained || [])],
      confirmation: plan.confirmation,
      resuming: !!plan.started,
      completed: plan.completed || [],
    };
  }
  progress() {
    const folder = path.join(this.nodes.root, "removals");
    if (!fs.existsSync(folder)) return [];
    return fs
      .readdirSync(folder)
      .filter((file) =>
        /^[a-f0-9]{64}-(node-[a-f0-9]{12}|validator|sentry)\.json$/.test(file),
      )
      .flatMap((file) => {
        try {
          const plan = JSON.parse(
            fs.readFileSync(path.join(folder, file), "utf8"),
          );
          return [
            {
              id: plan.id,
              nodeId: plan.nodeId,
              completed: plan.completed.length,
              total:
                (plan.cloud?.resources.length || 0) + (plan.remote ? 1 : 0) + 1,
              error: plan.error || null,
            },
          ];
        } catch {
          return [];
        }
      });
  }
  async preview(body) {
    const { id, role } = body,
      nodeId = body.nodeId || role,
      file = this.file(id, role, nodeId);
    const previous = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : null;
    const first = previous?.cloud?.resources?.[0];
    if (
      previous?.started &&
      (previous.localStarted ||
        !first ||
        previous.completed.includes(first.type + ":" + first.id) ||
        (previous.accepted || []).includes(first.type + ":" + first.id))
    )
      return this.public(previous);
    const scope = this.nodes.selectNode(id, role, nodeId),
      hosts = this.makeHosts(scope),
      host = hosts.get(id, role),
      local = scope.removalPlan(id, role);
    const record = this.nodes
      .deployments(id)
      .find((row) => row.nodeId === nodeId);
    check(record, "Node no longer exists.");
    const plan = {
      id,
      role,
      nodeId,
      name: record.name,
      selection: scope.selection,
      local,
      host,
      credentialId: body.credentialId || null,
      token: randomBytes(32).toString("hex"),
      created: Date.now(),
      confirmation: "REMOVE " + record.name,
      completed: [],
      accepted: [],
    };
    // Generated SSH material can be borrowed by other nodes; refuse to destroy
    // their remaining access path while removing its original owner.
    for (const network of this.nodes.inventory())
      for (const node of this.nodes.deployments(network.id)) {
        if (network.id === id && node.nodeId === nodeId) continue;
        const other = this.makeHosts(
          this.nodes.selectNode(network.id, node.role, node.nodeId),
        ).get(network.id, node.role);
        for (const key of [other.key, other.knownHosts].filter(Boolean))
          check(
            !local.files.some(
              (file) => key === file || key.startsWith(file + path.sep),
            ),
            "Another node uses SSH files owned by this node. Give that node independent SSH material before removal.",
          );
      }
    if (host.kind === "cloud") {
      check(
        body.deleteCloud === true || body.sharedHost === true,
        "Choose whether this VM is dedicated to the node or shared.",
      );
      if (body.deleteCloud === true) {
        check(
          body.dedicated === true,
          "Confirm that this cloud VM is dedicated to this node.",
        );
        const account = this.accounts.get(body.credentialId, host.provider);
        plan.accountName = account.name;
        const identity = await hosts.cloudIdentity(id, role);
        check(
          identity.provider === host.provider &&
            identity.otherNodes === 0 &&
            identity.otherContainers === 0,
          "This cloud host contains other nodes or containers. It cannot be deleted as a dedicated node VM.",
        );
        for (const network of this.nodes.inventory())
          for (const other of this.nodes.deployments(network.id)) {
            if (network.id === id && other.nodeId === nodeId) continue;
            const selected = this.makeHosts(
              this.nodes.selectNode(network.id, other.role, other.nodeId),
            ).get(network.id, other.role);
            check(
              !(
                selected.kind === "cloud" &&
                selected.address === host.address &&
                selected.port === host.port
              ),
              "Another node is configured on this cloud host.",
            );
          }
        const cloud = this.makeCloud(account, identity);
        plan.cloud = await cloud.plan(nodeId);
        plan.credentialFingerprint = this.accounts.fingerprint(account);
      } else
        plan.retained = [
          "Shared cloud VM " +
            host.address +
            " and its shared provider resources",
        ];
      if (previous?.completed.includes("remote data")) {
        plan.remote = previous.remote;
        plan.completed.push("remote data");
      } else plan.remote = await hosts.removalRequest(id, role, "preview");
    }
    this.save(file, plan);
    return this.public(plan);
  }
  async remove(body) {
    const id = body.id,
      role = body.role,
      nodeId = body.nodeId || role,
      file = this.file(id, role, nodeId);
    check(fs.existsSync(file), "Review this node's removal first.");
    const plan = JSON.parse(fs.readFileSync(file, "utf8"));
    check(
      body.token === plan.token && body.confirmation === plan.confirmation,
      "Enter the exact node removal confirmation.",
    );
    check(
      plan.started || Date.now() - plan.created < 15 * 60 * 1000,
      "The removal review expired. Review it again.",
    );
    const scope = plan.localStarted
        ? new Participants(this.nodes.root, this.nodes.runner, plan.selection)
        : this.nodes.selectNode(id, role, nodeId),
      hosts = this.makeHosts(scope);
    if (!plan.localStarted) {
      check(
        digest(scope.removalPlan(id, role)) === digest(plan.local),
        "Node configuration changed. Review removal again.",
      );
      check(
        digest(hosts.get(id, role)) === digest(plan.host),
        "The node host changed. Review removal again.",
      );
    }
    let cloud;
    if (plan.cloud) {
      const account = this.accounts.get(plan.credentialId, plan.cloud.provider);
      check(
        this.accounts.fingerprint(account) === plan.credentialFingerprint,
        "Cloud credentials changed. Restore the reviewed credential before retrying this removal.",
      );
      cloud = this.makeCloud(account, plan.cloud.identity);
      if (
        !plan.localStarted &&
        !plan.completed.includes(
          plan.cloud.resources[0].type + ":" + plan.cloud.resources[0].id,
        ) &&
        !(plan.accepted || []).includes(
          plan.cloud.resources[0].type + ":" + plan.cloud.resources[0].id,
        )
      ) {
        const proof = await hosts.cloudIdentity(id, role);
        check(
          digest(proof) === digest(plan.cloud.identity),
          "Cloud host identity or sharing changed. Review removal again.",
        );
        const current = await cloud.plan(nodeId);
        check(
          digest(current) === digest(plan.cloud),
          "Cloud resources changed. Review removal again.",
        );
      }
    }
    plan.started = true;
    this.save(file, plan);
    const finish = (name) => {
      if (!plan.completed.includes(name)) plan.completed.push(name);
      this.save(file, plan);
    };
    try {
      if (plan.remote && !plan.completed.includes("remote data")) {
        await hosts.removalRequest(id, role, "remove", plan.remote.fingerprint);
        finish("remote data");
      }
      if (cloud)
        for (const resource of plan.cloud.resources) {
          const key = resource.type + ":" + resource.id;
          if (!plan.completed.includes(key)) {
            await cloud.destroy(
              resource,
              () => {
                plan.accepted ||= [];
                if (!plan.accepted.includes(key)) plan.accepted.push(key);
                this.save(file, plan);
              },
              (plan.accepted || []).includes(key),
            );
            finish(key);
          }
        }
      plan.localStarted = true;
      this.save(file, plan);
      await scope.removeNode(id, role, plan.local.fingerprint, {
        stopContainers: plan.host.kind !== "cloud",
        resumePlan: plan.local,
      });
      fs.unlinkSync(file);
      return { removed: true, nodeId };
    } catch (error) {
      plan.error =
        "Removal was not completed. Completed steps are saved; review this node again to resume.";
      this.save(file, plan);
      throw new Error(plan.error + " " + error.message);
    }
  }
}

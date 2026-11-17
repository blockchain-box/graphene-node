import { createHash, createHmac, sign } from "node:crypto";
import { check } from "./runtime.js";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const list = (value) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
const enc = (value) => encodeURIComponent(String(value));
export class CloudError extends Error {
  constructor(status, code) {
    super(
      `Cloud API request failed (${status}${code ? ": " + code : ""}). Check the selected account's permissions.`,
    );
    this.status = status;
    this.code = code;
  }
}
export function parseXml(text) {
  check(!/<!DOCTYPE|<!ENTITY/i.test(text), "Invalid cloud XML response.");
  const root = { children: Object.create(null), text: "" },
    stack = [root];
  for (const token of text.match(/<[^>]*>|[^<]+/g) || []) {
    if (token.startsWith("<?") || token.startsWith("<!--")) continue;
    if (token.startsWith("</")) {
      check(stack.length > 1, "Invalid cloud XML.");
      const node = stack.pop();
      const value = Object.keys(node.children).length
        ? node.children
        : node.text
            .trim()
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, "&");
      const parent = stack.at(-1).children;
      if (parent[node.name] === undefined) parent[node.name] = value;
      else parent[node.name] = [...list(parent[node.name]), value];
    } else if (token.startsWith("<")) {
      const name = /^<([\w:-]+)/.exec(token)?.[1];
      check(
        name && !["__proto__", "constructor", "prototype"].includes(name),
        "Invalid cloud XML tag.",
      );
      const node = { name, children: Object.create(null), text: "" };
      if (token.endsWith("/>")) stack.at(-1).children[name] = "";
      else stack.push(node);
    } else stack.at(-1).text += token;
  }
  check(stack.length === 1, "Incomplete cloud XML response.");
  return root.children;
}
export function awsSignature(values, region, body, now = new Date()) {
  check(/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region), "Invalid AWS region.");
  const host = `ec2.${region}.amazonaws.${region.startsWith("cn-") ? "com.cn" : "com"}`;
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, ""),
    day = date.slice(0, 8);
  const signed = {
    host,
    "x-amz-date": date,
    ...(values.sessionToken
      ? { "x-amz-security-token": values.sessionToken }
      : {}),
  };
  const names = Object.keys(signed).sort();
  const canonical = [
    "POST",
    "/",
    "",
    names.map((key) => key + ":" + signed[key].trim() + "\n").join(""),
    names.join(";"),
    hash(body),
  ].join("\n");
  const scope = `${day}/${region}/ec2/aws4_request`;
  let key = Buffer.from("AWS4" + values.secretAccessKey);
  for (const part of [day, region, "ec2", "aws4_request"])
    key = createHmac("sha256", key).update(part).digest();
  const signature = createHmac("sha256", key)
    .update(["AWS4-HMAC-SHA256", date, scope, hash(canonical)].join("\n"))
    .digest("hex");
  return {
    url: "https://" + host + "/",
    headers: {
      ...signed,
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      authorization: `AWS4-HMAC-SHA256 Credential=${values.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
    },
  };
}
export class CloudRemoval {
  constructor(
    account,
    identity,
    {
      fetchImpl = fetch,
      sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    } = {},
  ) {
    this.account = account;
    this.identity = identity;
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.token = null;
    check(
      account.provider === identity.provider,
      "The cloud credential and host provider differ.",
    );
  }
  async transport(url, options) {
    const response = await this.fetch(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(25000),
    });
    const text = await response.text();
    check(text.length < 16 * 1024 * 1024, "Cloud response is too large.");
    return { response, text };
  }
  async accessToken() {
    if (this.token) return this.token;
    const values = this.account.values;
    let url, body;
    if (this.account.provider === "gcp") {
      const key = JSON.parse(values.serviceAccountJson),
        now = Math.floor(Date.now() / 1000);
      check(
        key.type === "service_account" &&
          (!key.token_uri ||
            key.token_uri === "https://oauth2.googleapis.com/token"),
        "The Google account does not own this VM's project.",
      );
      const encode = (value) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
      const jwt =
        encode({ alg: "RS256", typ: "JWT" }) +
        "." +
        encode({
          iss: key.client_email,
          scope: "https://www.googleapis.com/auth/compute",
          aud: "https://oauth2.googleapis.com/token",
          iat: now,
          exp: now + 300,
        });
      body = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion:
          jwt +
          "." +
          sign("RSA-SHA256", Buffer.from(jwt), key.private_key).toString(
            "base64url",
          ),
      }).toString();
      url = "https://oauth2.googleapis.com/token";
    } else {
      check(
        this.identity.subscription?.toLowerCase() ===
          values.subscriptionId.toLowerCase(),
        "The Azure subscription does not match this VM.",
      );
      url = `https://login.microsoftonline.com/${enc(values.tenantId)}/oauth2/v2.0/token`;
      body = new URLSearchParams({
        client_id: values.clientId,
        client_secret: values.clientSecret,
        scope: "https://management.azure.com/.default",
        grant_type: "client_credentials",
      }).toString();
    }
    const { response, text } = await this.transport(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok)
      throw new CloudError(response.status, "authentication_failed");
    const data = JSON.parse(text);
    check(
      typeof data.access_token === "string",
      "Cloud authentication did not return an access token.",
    );
    return (this.token = data.access_token);
  }
  async json(method, route, body) {
    const provider = this.account.provider;
    const bases = {
      hetzner: "https://api.hetzner.cloud/v1",
      digitalocean: "https://api.digitalocean.com/v2",
      gcp: "https://compute.googleapis.com/compute/v1",
      azure: "https://management.azure.com",
    };
    check(
      typeof route === "string" &&
        route.startsWith("/") &&
        !route.startsWith("//") &&
        !route.includes(".."),
      "Invalid cloud resource path.",
    );
    if (provider === "gcp")
      check(
        route.startsWith("/projects/" + enc(this.identity.project) + "/"),
        "Resource is outside the VM's project.",
      );
    if (provider === "azure")
      check(
        route
          .toLowerCase()
          .startsWith(
            "/subscriptions/" +
              this.account.values.subscriptionId.toLowerCase() +
              "/",
          ),
        "Resource is outside the VM's subscription.",
      );
    const token = ["gcp", "azure"].includes(provider)
      ? await this.accessToken()
      : this.account.values.token;
    const { response, text } = await this.transport(bases[provider] + route, {
      method,
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      let code;
      try {
        code = JSON.parse(text).error?.code;
      } catch {}
      throw new CloudError(
        response.status,
        typeof code === "string" && /^[\w.]+$/.test(code) ? code : undefined,
      );
    }
    const value = text ? JSON.parse(text) : {};
    check(!value.error, "Cloud operation returned an error.");
    return value;
  }
  async aws(action, params = {}) {
    const body = new URLSearchParams({
      Action: action,
      Version: "2016-11-15",
      ...params,
    }).toString();
    const signed = awsSignature(
      this.account.values,
      this.identity.region,
      body,
    );
    const { response, text } = await this.transport(signed.url, {
      method: "POST",
      headers: signed.headers,
      body,
    });
    const parsed = parseXml(text);
    if (!response.ok)
      throw new CloudError(
        response.status,
        parsed.Response?.Errors?.Error?.Code || parsed.Errors?.Error?.Code,
      );
    return parsed[action + "Response"] || parsed;
  }
  async pages(route, key) {
    const result = [];
    let current = route;
    for (let page = 0; current; page++) {
      check(page < 1000, "Too many cloud resource pages.");
      const data = await this.json("GET", current);
      result.push(...(data[key] || []));
      if (data.meta?.pagination?.next_page) {
        const url = new URL(current, "https://pagination.invalid");
        url.searchParams.set("page", data.meta.pagination.next_page);
        current = url.pathname + url.search;
      } else if (data.nextPageToken) {
        const url = new URL(route, "https://pagination.invalid");
        url.searchParams.set("pageToken", data.nextPageToken);
        current = url.pathname + url.search;
      } else if (data.links?.pages?.next || data.nextLink) {
        const next = new URL(data.links?.pages?.next || data.nextLink);
        const expected =
          this.account.provider === "azure"
            ? "https://management.azure.com"
            : "https://api.digitalocean.com";
        check(next.origin === expected, "Invalid cloud pagination origin.");
        current = next.pathname + next.search;
        if (this.account.provider === "digitalocean")
          current = current.replace(/^\/v2/, "");
      } else current = null;
    }
    return result;
  }
  resource(type, id, route, extra = {}) {
    return {
      type,
      id: String(id),
      delete: { method: "DELETE", route },
      verify: route,
      ...extra,
    };
  }
  async plan(nodeId) {
    const p = this.account.provider,
      i = this.identity,
      resources = [],
      retained = [];
    const owned = (tags) =>
      tags?.["graphene-node-id"] === nodeId ||
      tags?.graphene_node_id === nodeId;
    if (p === "hetzner") {
      check(/^\d+$/.test(String(i.id)), "Invalid Hetzner server identity.");
      const server = (await this.json("GET", "/servers/" + i.id)).server;
      check(String(server.id) === String(i.id), "Server identity mismatch.");
      resources.push(
        this.resource("server", server.id, "/servers/" + server.id, {
          guard: { volumes: (server.volumes || []).map(String).sort() },
        }),
      );
      for (const id of server.volumes || []) {
        const volume = (await this.json("GET", "/volumes/" + id)).volume;
        check(
          Number(volume.server) === Number(i.id),
          "A volume is no longer attached to this VM.",
        );
        resources.push(this.resource("volume", id, "/volumes/" + id));
      }
      for (const image of await this.pages(
        "/images?type=snapshot&per_page=50",
        "images",
      ))
        if (
          String(image.created_from?.id) === String(i.id) ||
          owned(image.labels)
        )
          resources.push(
            this.resource("snapshot", image.id, "/images/" + image.id),
          );
      for (const ip of await this.pages(
        "/floating_ips?per_page=50",
        "floating_ips",
      ))
        if (String(ip.server) === String(i.id))
          resources.push(
            this.resource("floating IP", ip.id, "/floating_ips/" + ip.id),
          );
      for (const key of ["ipv4", "ipv6"]) {
        const ip = server.public_net?.[key];
        if (ip?.id)
          resources.push(
            this.resource("primary IP", ip.id, "/primary_ips/" + ip.id),
          );
      }
      for (const firewall of await this.pages(
        "/firewalls?per_page=50",
        "firewalls",
      )) {
        const applies = firewall.applied_to || [];
        if (
          owned(firewall.labels) &&
          applies.every(
            (item) =>
              item.type === "server" &&
              String(item.server?.id) === String(i.id),
          )
        )
          resources.push(
            this.resource("firewall", firewall.id, "/firewalls/" + firewall.id),
          );
        else if (
          applies.some((item) => String(item.server?.id) === String(i.id))
        )
          retained.push("Shared/unowned firewall " + firewall.id);
      }
      for (const attachment of server.private_net || []) {
        const network = (
          await this.json("GET", "/networks/" + attachment.network)
        ).network;
        if (
          owned(network.labels) &&
          (network.servers || []).every((id) => String(id) === String(i.id))
        )
          resources.push(
            this.resource(
              "private network",
              network.id,
              "/networks/" + network.id,
            ),
          );
        else
          retained.push("Shared/unowned private network " + attachment.network);
      }
      return { provider: p, identity: i, resources, retained };
    }
    if (p === "digitalocean") {
      check(/^\d+$/.test(String(i.id)), "Invalid Droplet identity.");
      const droplet = (await this.json("GET", "/droplets/" + i.id)).droplet;
      check(String(droplet.id) === String(i.id), "Droplet identity mismatch.");
      const associated = await this.json(
        "GET",
        "/droplets/" + i.id + "/destroy_with_associated_resources",
      );
      const body = {};
      for (const key of [
        "reserved_ips",
        "snapshots",
        "volume_snapshots",
        "volumes",
      ]) {
        body[key] = (associated[key] || []).map((item) => String(item.id));
        for (const item of associated[key] || [])
          resources.push({
            type: key,
            id: String(item.id),
            name: item.name,
            associated: true,
          });
      }
      // Reject a volume that has acquired another attachment since association discovery.
      for (const id of body.volumes) {
        const volume = (await this.json("GET", "/volumes/" + enc(id))).volume;
        check(
          (volume.droplet_ids || []).every((id) => String(id) === String(i.id)),
          "This volume is shared by another Droplet.",
        );
      }
      resources.unshift(
        this.resource(
          "Droplet",
          i.id,
          "/droplets/" + i.id + "/destroy_with_associated_resources/selective",
          {
            delete: {
              method: "DELETE",
              route:
                "/droplets/" +
                i.id +
                "/destroy_with_associated_resources/selective",
              body,
            },
            verify: "/droplets/" + i.id,
            operationStatus:
              "/droplets/" + i.id + "/destroy_with_associated_resources/status",
          },
        ),
      );
      for (const firewall of await this.pages(
        "/firewalls?per_page=200",
        "firewalls",
      ))
        if (
          (firewall.tags || []).includes("graphene-node-" + nodeId) &&
          (firewall.droplet_ids || []).every(
            (id) => String(id) === String(i.id),
          ) &&
          (firewall.tags || []).every(
            (tag) => tag === "graphene-node-" + nodeId,
          )
        )
          resources.push(
            this.resource("firewall", firewall.id, "/firewalls/" + firewall.id),
          );
      if (droplet.vpc_uuid)
        retained.push("Shared/unowned VPC " + droplet.vpc_uuid);
      return { provider: p, identity: i, resources, retained };
    }
    if (p === "gcp") {
      check(
        /^[a-z][a-z0-9-]{4,62}$/.test(i.project) &&
          /^[a-z][a-z0-9-]+$/.test(i.zone) &&
          /^[a-z][a-z0-9-]*$/.test(i.name),
        "Invalid Google VM identity.",
      );
      const base = `/projects/${enc(i.project)}`,
        route = `${base}/zones/${enc(i.zone)}/instances/${enc(i.name)}`;
      const vm = await this.json("GET", route);
      check(String(vm.id) === String(i.id), "The Google VM was replaced.");
      check(
        !vm.deletionProtection,
        "Disable this VM's deletion protection before reviewing removal.",
      );
      resources.push(
        this.resource("instance", vm.id, route, {
          guard: {
            disks: (vm.disks || [])
              .map((disk) => disk.source)
              .filter(Boolean)
              .sort(),
          },
        }),
      );
      const diskPaths = new Set();
      const relative = (url) => {
        const parsed = new URL(url);
        check(
          [
            "https://www.googleapis.com",
            "https://compute.googleapis.com",
          ].includes(parsed.origin),
          "Invalid Google resource origin.",
        );
        return parsed.pathname.replace(/^\/compute\/v1/, "");
      };
      for (const attached of vm.disks || [])
        if (attached.source) {
          const diskPath = relative(attached.source);
          const disk = await this.json("GET", diskPath);
          check(
            (disk.users || []).every((user) => relative(user) === route),
            "This Google disk is attached to another VM.",
          );
          diskPaths.add(diskPath);
          resources.push(this.resource("disk", disk.id, diskPath));
        }
      for (const snapshot of await this.pages(
        base + "/global/snapshots",
        "items",
      ))
        if (snapshot.sourceDisk && diskPaths.has(relative(snapshot.sourceDisk)))
          resources.push(
            this.resource(
              "snapshot",
              snapshot.id,
              base + "/global/snapshots/" + enc(snapshot.name),
            ),
          );
      const region = i.zone.replace(/-[a-z]$/, "");
      for (const address of await this.pages(
        base + "/regions/" + enc(region) + "/addresses",
        "items",
      ))
        if ((address.users || []).some((user) => relative(user) === route)) {
          check(
            (address.users || []).every((user) => relative(user) === route),
            "This Google IP is shared.",
          );
          resources.push(
            this.resource(
              "reserved address",
              address.id,
              base +
                "/regions/" +
                enc(region) +
                "/addresses/" +
                enc(address.name),
            ),
          );
        }
      for (const nic of vm.networkInterfaces || [])
        if (nic.network)
          retained.push("Shared/unowned network " + relative(nic.network));
      return { provider: p, identity: i, resources, retained };
    }
    if (p === "azure") {
      check(
        typeof i.id === "string" &&
          /^\/subscriptions\/[a-f0-9-]+\/resourceGroups\/[^/]+\/providers\/Microsoft.Compute\/virtualMachines\/[^/]+$/i.test(
            i.id,
          ),
        "Invalid Azure VM identity.",
      );
      const version = (id) =>
        id.toLowerCase().includes("microsoft.network")
          ? "2024-05-01"
          : "2024-03-02";
      const route = (id) => id + "?api-version=" + version(id);
      const vm = await this.json("GET", route(i.id));
      check(vm.properties.vmId === i.vmId, "The Azure VM was replaced.");
      resources.push(
        this.resource("virtual machine", vm.id, route(vm.id), {
          incarnation: { key: "vmId", value: vm.properties.vmId },
          guard: {
            disks: [
              vm.properties.storageProfile?.osDisk?.managedDisk?.id,
              ...(vm.properties.storageProfile?.dataDisks || []).map(
                (disk) => disk.managedDisk?.id,
              ),
            ]
              .filter(Boolean)
              .sort(),
            interfaces: (vm.properties.networkProfile?.networkInterfaces || [])
              .map((nic) => nic.id)
              .sort(),
          },
        }),
      );
      const disks = [
        vm.properties.storageProfile?.osDisk?.managedDisk?.id,
        ...(vm.properties.storageProfile?.dataDisks || []).map(
          (disk) => disk.managedDisk?.id,
        ),
      ].filter(Boolean);
      for (const diskId of disks) {
        const disk = await this.json("GET", route(diskId));
        check(
          !disk.managedBy ||
            disk.managedBy.toLowerCase() === i.id.toLowerCase(),
          "This Azure disk belongs to another VM.",
        );
        check(
          !(disk.managedByExtended || []).some(
            (id) => id.toLowerCase() !== i.id.toLowerCase(),
          ),
          "This Azure disk is shared.",
        );
        resources.push(
          this.resource("managed disk", disk.id, route(disk.id), {
            incarnation: disk.properties?.uniqueId
              ? { key: "uniqueId", value: disk.properties.uniqueId }
              : undefined,
          }),
        );
      }
      const ipIds = [],
        groupIds = new Set();
      for (const nicRef of vm.properties.networkProfile?.networkInterfaces ||
        []) {
        const nic = await this.json("GET", route(nicRef.id));
        check(
          nic.properties.virtualMachine?.id?.toLowerCase() ===
            i.id.toLowerCase(),
          "This Azure interface belongs to another VM.",
        );
        resources.push(
          this.resource("network interface", nic.id, route(nic.id), {
            incarnation: nic.properties?.resourceGuid
              ? { key: "resourceGuid", value: nic.properties.resourceGuid }
              : undefined,
          }),
        );
        if (nic.properties.networkSecurityGroup?.id)
          groupIds.add(nic.properties.networkSecurityGroup.id);
        for (const cfg of nic.properties.ipConfigurations || []) {
          if (cfg.properties.publicIPAddress?.id)
            ipIds.push(cfg.properties.publicIPAddress.id);
          if (cfg.properties.subnet?.id)
            retained.push("Shared/unowned subnet " + cfg.properties.subnet.id);
        }
      }
      for (const ipId of ipIds) {
        const ip = await this.json("GET", route(ipId));
        check(
          resources.some(
            (resource) =>
              resource.type === "network interface" &&
              ip.properties.ipConfiguration?.id
                ?.toLowerCase()
                .startsWith(resource.id.toLowerCase() + "/ipconfigurations/"),
          ),
          "This public IP belongs to another interface.",
        );
        resources.push(
          this.resource("public IP", ip.id, route(ip.id), {
            incarnation: ip.properties?.resourceGuid
              ? { key: "resourceGuid", value: ip.properties.resourceGuid }
              : undefined,
          }),
        );
      }
      for (const groupId of groupIds) {
        const group = await this.json("GET", route(groupId));
        if (
          !(group.properties.subnets || []).length &&
          (group.properties.networkInterfaces || []).every((nic) =>
            resources.some(
              (resource) =>
                resource.type === "network interface" &&
                resource.id.toLowerCase() === nic.id.toLowerCase(),
            ),
          )
        )
          resources.push(
            this.resource("network security group", group.id, route(group.id), {
              incarnation: group.properties.resourceGuid
                ? { key: "resourceGuid", value: group.properties.resourceGuid }
                : undefined,
            }),
          );
        else retained.push("Shared network security group " + groupId);
      }
      const snapshots = await this.pages(
        `/subscriptions/${enc(this.account.values.subscriptionId)}/providers/Microsoft.Compute/snapshots?api-version=2024-03-02`,
        "value",
      );
      for (const snapshot of snapshots)
        if (
          disks.some(
            (id) =>
              id.toLowerCase() ===
              snapshot.properties.creationData?.sourceResourceId?.toLowerCase(),
          )
        )
          resources.push(
            this.resource("snapshot", snapshot.id, route(snapshot.id)),
          );
      return { provider: p, identity: i, resources, retained };
    }
    if (p === "aws") {
      const response = await this.aws("DescribeInstances", {
        "InstanceId.1": i.id,
      });
      const vm = list(response.reservationSet?.item).flatMap((r) =>
        list(r.instancesSet?.item),
      )[0];
      check(
        vm?.instanceId === i.id &&
          list(response.reservationSet?.item)[0].ownerId ===
            String(i.accountId),
        "The AWS account or instance does not match this host.",
      );
      check(
        vm.instanceState?.name !== "terminated",
        "This AWS instance is already terminated.",
      );
      resources.push({
        type: "instance",
        id: i.id,
        delete: {
          action: "TerminateInstances",
          params: { "InstanceId.1": i.id },
        },
        verify: {
          action: "DescribeInstances",
          params: { "InstanceId.1": i.id },
          type: "instance",
        },
        guard: {
          volumes: list(vm.blockDeviceMapping?.item)
            .map((disk) => disk.ebs?.volumeId)
            .filter(Boolean)
            .sort(),
        },
      });
      const diskIds = list(vm.blockDeviceMapping?.item)
        .map((disk) => disk.ebs?.volumeId)
        .filter(Boolean);
      for (const id of diskIds) {
        const data = await this.aws("DescribeVolumes", { "VolumeId.1": id });
        const volume = list(data.volumeSet?.item)[0];
        check(
          list(volume?.attachmentSet?.item).every((a) => a.instanceId === i.id),
          "This AWS volume is shared.",
        );
        resources.push({
          type: "EBS volume",
          id,
          delete: { action: "DeleteVolume", params: { VolumeId: id } },
          verify: {
            action: "DescribeVolumes",
            params: { "VolumeId.1": id },
            type: "volume",
          },
        });
      }
      if (diskIds.length) {
        const params = { "Owner.1": i.accountId, "Filter.1.Name": "volume-id" };
        diskIds.forEach(
          (id, index) => (params["Filter.1.Value." + (index + 1)] = id),
        );
        let token;
        do {
          const data = await this.aws("DescribeSnapshots", {
            ...params,
            ...(token ? { NextToken: token } : {}),
          });
          for (const snap of list(data.snapshotSet?.item))
            resources.push({
              type: "snapshot",
              id: snap.snapshotId,
              delete: {
                action: "DeleteSnapshot",
                params: { SnapshotId: snap.snapshotId },
              },
              verify: {
                action: "DescribeSnapshots",
                params: { "SnapshotId.1": snap.snapshotId },
                type: "snapshot",
              },
            });
          token = data.nextToken;
        } while (token);
      }
      const addresses = await this.aws("DescribeAddresses", {
        "Filter.1.Name": "instance-id",
        "Filter.1.Value.1": i.id,
      });
      for (const ip of list(addresses.addressesSet?.item))
        if (ip.allocationId)
          resources.push({
            type: "Elastic IP",
            id: ip.allocationId,
            delete: {
              action: "ReleaseAddress",
              params: { AllocationId: ip.allocationId },
            },
            verify: {
              action: "DescribeAddresses",
              params: { "AllocationId.1": ip.allocationId },
              type: "address",
            },
            ...(ip.associationId
              ? {
                  preDelete: {
                    action: "DisassociateAddress",
                    params: { AssociationId: ip.associationId },
                  },
                }
              : {}),
          });
      for (const nic of list(vm.networkInterfaceSet?.item)) {
        const data = await this.aws("DescribeNetworkInterfaces", {
          "NetworkInterfaceId.1": nic.networkInterfaceId,
        });
        const selected = list(data.networkInterfaceSet?.item)[0];
        check(
          selected?.attachment?.instanceId === i.id,
          "This AWS network interface is attached to another VM.",
        );
        resources.push({
          type: "network interface",
          id: nic.networkInterfaceId,
          delete: {
            action: "DeleteNetworkInterface",
            params: { NetworkInterfaceId: nic.networkInterfaceId },
          },
          verify: {
            action: "DescribeNetworkInterfaces",
            params: { "NetworkInterfaceId.1": nic.networkInterfaceId },
            type: "interface",
          },
        });
      }
      for (const ref of list(vm.groupSet?.item)) {
        const data = await this.aws("DescribeSecurityGroups", {
          "GroupId.1": ref.groupId,
        });
        const group = list(data.securityGroupInfo?.item)[0];
        const references = await this.aws("DescribeNetworkInterfaces", {
          "Filter.1.Name": "group-id",
          "Filter.1.Value.1": ref.groupId,
        });
        if (
          group?.groupName !== "default" &&
          list(references.networkInterfaceSet?.item).every(
            (nic) => nic.attachment?.instanceId === i.id,
          )
        )
          resources.push({
            type: "security group",
            id: ref.groupId,
            delete: {
              action: "DeleteSecurityGroup",
              params: { GroupId: ref.groupId },
            },
            verify: {
              action: "DescribeSecurityGroups",
              params: { "GroupId.1": ref.groupId },
              type: "securityGroup",
            },
          });
        else retained.push("Shared/default security group " + ref.groupId);
      }
      if (vm.vpcId) retained.push("Shared/unowned VPC " + vm.vpcId);
      return { provider: p, identity: i, resources, retained };
    }
    throw new Error("Unsupported cloud provider.");
  }
  async exists(resource, validateAttachments = true) {
    try {
      if (this.account.provider !== "aws") {
        const data = await this.json("GET", resource.verify);
        if (this.account.provider === "gcp")
          check(
            String(data.id) === resource.id,
            "A reviewed cloud resource was replaced. Do not delete its replacement.",
          );
        if (resource.guard && validateAttachments) {
          let guard;
          if (this.account.provider === "hetzner")
            guard = { volumes: (data.server.volumes || []).map(String).sort() };
          if (this.account.provider === "gcp")
            guard = {
              disks: (data.disks || [])
                .map((disk) => disk.source)
                .filter(Boolean)
                .sort(),
            };
          if (this.account.provider === "azure")
            guard = {
              disks: [
                data.properties.storageProfile?.osDisk?.managedDisk?.id,
                ...(data.properties.storageProfile?.dataDisks || []).map(
                  (disk) => disk.managedDisk?.id,
                ),
              ]
                .filter(Boolean)
                .sort(),
              interfaces: (
                data.properties.networkProfile?.networkInterfaces || []
              )
                .map((nic) => nic.id)
                .sort(),
            };
          check(
            JSON.stringify(guard) === JSON.stringify(resource.guard),
            "VM attachments changed since review. Do not delete newly attached resources.",
          );
        }
        if (resource.incarnation)
          check(
            data.properties?.[resource.incarnation.key] ===
              resource.incarnation.value,
            "A reviewed cloud resource was replaced. Do not delete its replacement.",
          );
        return true;
      }
      const data = await this.aws(
        resource.verify.action,
        resource.verify.params,
      );
      if (resource.verify.type === "instance") {
        const vm = list(data.reservationSet?.item).flatMap((r) =>
          list(r.instancesSet?.item),
        )[0];
        if (!vm || vm.instanceState?.name === "terminated") return false;
        check(
          !validateAttachments ||
            JSON.stringify({
              volumes: list(vm.blockDeviceMapping?.item)
                .map((disk) => disk.ebs?.volumeId)
                .filter(Boolean)
                .sort(),
            }) === JSON.stringify(resource.guard),
          "AWS VM attachments changed since review.",
        );
        return true;
      }
      const sets = {
        volume: "volumeSet",
        snapshot: "snapshotSet",
        address: "addressesSet",
        interface: "networkInterfaceSet",
        securityGroup: "securityGroupInfo",
      };
      return list(data[sets[resource.verify.type]]?.item).length > 0;
    } catch (error) {
      if (error.status === 404 || /\.NotFound$/.test(error.code || ""))
        return false;
      throw error;
    }
  }
  async destroy(resource, onAccepted = () => {}, alreadyAccepted = false) {
    if (resource.associated) return;
    if (resource.operationStatus) {
      let status;
      try {
        status = await this.json("GET", resource.operationStatus);
      } catch (error) {
        if (error.status !== 404) throw error;
      }
      if (status?.failures) {
        await this.json(
          "POST",
          resource.operationStatus.replace(/\/status$/, "/retry"),
        );
        onAccepted();
      } else if (!status?.droplet) {
        await this.json(
          resource.delete.method,
          resource.delete.route,
          resource.delete.body,
        );
        onAccepted();
      }
      for (let attempt = 0; attempt < 120; attempt++) {
        const result = await this.json("GET", resource.operationStatus);
        if (result.failures)
          throw new Error(
            "DigitalOcean reported a partial deletion. Retry removal to resume it.",
          );
        if (result.completed_at) return;
        await this.sleep(2000);
      }
      throw new Error(
        "DigitalOcean deletion is still running. Retry removal to check completion.",
      );
    }
    if (!(await this.exists(resource, !alreadyAccepted))) return;
    if (!alreadyAccepted) {
      if (resource.preDelete) {
        try {
          await this.aws(resource.preDelete.action, resource.preDelete.params);
        } catch (error) {
          if (!/\.NotFound$/.test(error.code || "")) throw error;
        }
      }
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          if (this.account.provider === "aws")
            await this.aws(resource.delete.action, resource.delete.params);
          else
            await this.json(
              resource.delete.method,
              resource.delete.route,
              resource.delete.body,
            );
          onAccepted();
          break;
        } catch (error) {
          if (error.status === 404 || /\.NotFound$/.test(error.code || ""))
            return;
          if (
            ![409, 429].includes(error.status) &&
            ![
              "VolumeInUse",
              "DependencyViolation",
              "InvalidIPAddress.InUse",
            ].includes(error.code)
          )
            throw error;
          if (attempt === 59) throw error;
          await this.sleep(2000);
        }
      }
    }
    for (let attempt = 0; attempt < 120; attempt++) {
      if (!(await this.exists(resource, false))) return;
      await this.sleep(2000);
    }
    throw new Error(
      "Cloud deletion is still running. Retry removal to continue checking it.",
    );
  }
}

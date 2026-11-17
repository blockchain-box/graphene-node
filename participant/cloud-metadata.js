import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
export async function cloudMetadata(provider, request = fetch) {
  const base = "http://169.254.169.254";
  const get = async (route, headers = {}, method = "GET") => {
    const response = await request(base + route, {
      method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok)
      throw new Error("Cloud instance metadata could not be verified.");
    const text = await response.text();
    if (text.length > 65536)
      throw new Error("Invalid cloud instance metadata.");
    return text.trim();
  };
  if (provider === "aws") {
    const token = await get(
      "/latest/api/token",
      { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
      "PUT",
    );
    const identity = JSON.parse(
      await get("/latest/dynamic/instance-identity/document", {
        "X-aws-ec2-metadata-token": token,
      }),
    );
    if (
      !/^i-[a-f0-9]+$/.test(identity.instanceId) ||
      !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(identity.region)
    )
      throw new Error("Invalid AWS instance identity.");
    return {
      provider,
      id: identity.instanceId,
      region: identity.region,
      accountId: identity.accountId,
    };
  }
  if (provider === "gcp") {
    const headers = { "Metadata-Flavor": "Google" };
    return {
      provider,
      id: await get("/computeMetadata/v1/instance/id", headers),
      name: await get("/computeMetadata/v1/instance/name", headers),
      project: await get("/computeMetadata/v1/project/project-id", headers),
      zone: (await get("/computeMetadata/v1/instance/zone", headers))
        .split("/")
        .at(-1),
    };
  }
  if (provider === "azure") {
    const identity = JSON.parse(
      await get("/metadata/instance/compute?api-version=2021-02-01", {
        Metadata: "true",
      }),
    );
    return {
      provider,
      id: identity.resourceId,
      vmId: identity.vmId,
      subscription: identity.subscriptionId,
    };
  }
  if (provider === "hetzner")
    return { provider, id: await get("/hetzner/v1/metadata/instance-id") };
  if (provider === "digitalocean")
    return { provider, id: await get("/metadata/v1/id") };
  throw new Error("This cloud provider does not support VM removal.");
}
if (process.argv[1] === "--cloud-metadata") {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  try {
    const body = JSON.parse(input);
    const identity = await cloudMetadata(body.provider);
    const root = path.join(os.homedir(), ".graphene", "participants");
    let otherNodes = 0;
    if (fs.existsSync(root))
      for (const network of fs
        .readdirSync(root)
        .filter((name) => /^[a-f0-9]{64}$/.test(name))) {
        for (const role of ["validator", "sentry"])
          if (
            fs.existsSync(path.join(root, network, role)) &&
            !(network === body.id && body.nodeId === role && body.role === role)
          )
            otherNodes++;
        const records = path.join(root, network, "node-records");
        if (fs.existsSync(records))
          for (const file of fs
            .readdirSync(records)
            .filter((name) => /^node-[a-f0-9]{12}\.json$/.test(name)))
            if (!(network === body.id && file === body.nodeId + ".json"))
              otherNodes++;
      }
    const directory = path.join(
      root,
      body.id,
      ...(body.nodeId === body.role ? [] : ["instances", body.nodeId]),
      body.role,
    );
    const project =
      "graphene-join-" +
      createHash("sha256").update(directory).digest("hex").slice(0, 16) +
      "-" +
      body.role;
    let containers = [];
    let allIds = [];
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (key.startsWith("COMPOSE_")) delete env[key];
    try {
      const endpoint =
        (!env.DOCKER_CONTEXT && env.DOCKER_HOST) ||
        execFileSync(
          "docker",
          ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
          { env, encoding: "utf8", timeout: 15000 },
        ).trim();
      if (!/^(unix:\/\/\/|npipe:\/\/\/)/.test(endpoint))
        throw new Error("Use this VM's local Docker engine.");
      delete env.DOCKER_CONTEXT;
      env.DOCKER_HOST = endpoint;
      containers = execFileSync(
        "docker",
        ["ps", "-a", "--format", '{{.Label "com.docker.compose.project"}}'],
        { env, encoding: "utf8", timeout: 15000 },
      )
        .trim()
        .split("\n")
        .filter(Boolean);
      allIds = execFileSync("docker", ["ps", "-aq"], {
        env,
        encoding: "utf8",
        timeout: 15000,
      })
        .trim()
        .split("\n")
        .filter(Boolean);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    process.stdout.write(
      JSON.stringify({
        ...identity,
        otherNodes,
        otherContainers:
          containers.filter((name) => name !== project).length +
          allIds.length -
          containers.length,
      }),
    );
  } catch {
    process.stdout.write(
      JSON.stringify({
        error:
          "Cannot verify this VM's identity and exclusive node ownership. Check SSH, metadata access and Docker permissions.",
      }),
    );
  }
}

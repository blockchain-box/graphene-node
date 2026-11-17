import { createServer } from "node:http";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { sha256 as sha2562 } from "viem";

import { hexToString, createPublicClient, erc20Abi, http, parseAbiItem, zeroAddress, concat, keccak256, sha256, toBytes, toHex } from "viem";
var TOKEN_CLAIM_DOMAIN = keccak256(
  toBytes("graphene.zrc2.token-migration.v1.claim")
);
var MIGRATION_LEAF_DOMAIN = keccak256(toBytes("graphene.zrc2.migration.v1.leaf"));
var TOKEN_MIGRATION_DOMAIN = "token-migration";
function address(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value.toLowerCase();
}
function decimals(value, label) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 18) {
    throw new Error(`${label} must be an integer between 0 and 18.`);
  }
  return value;
}
function integer(value, label) {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new Error(`${label} must be a decimal base-unit string.`);
  }
  return BigInt(value);
}
function tokenAddress(chainId, sourceContract, sourceChainId) {
  if (sourceChainId !== void 0 && (!Number.isSafeInteger(sourceChainId) || sourceChainId <= 0)) throw new Error("Invalid source chain id.");
  const source = sourceChainId === void 0 ? sourceContract.toLowerCase() : `evm:${sourceChainId}:${sourceContract.toLowerCase()}`;
  const hash = keccak256(toBytes(`${TOKEN_MIGRATION_DOMAIN}:${chainId}:${source}`));
  return `0x${hash.slice(-40)}`;
}
function leafHash(source, amount) {
  return keccak256(concat([MIGRATION_LEAF_DOMAIN, source.toLowerCase(), toHex(amount, { size: 32 })]));
}
function merkleRoot(leaves) {
  if (leaves.length === 0) throw new Error("Cannot build a root without leaves.");
  let level = [...leaves];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 >= level.length) {
        next.push(level[i]);
      } else {
        const [a, b] = [level[i].toLowerCase(), level[i + 1].toLowerCase()];
        next.push(keccak256(concat(a <= b ? [a, b] : [b, a])));
      }
    }
    level = next;
  }
  return level[0];
}
function verifyTokenMigration(manifest, bytes, expectedHash) {
  if (!manifest || manifest.version !== 1) throw new Error("Unsupported manifest version.");
  if (!Number.isSafeInteger(manifest.chainId) || manifest.chainId <= 0) throw new Error("Invalid destination chain id.");
  address(manifest.source.contract, "source contract");
  decimals(manifest.source.decimals, "Source decimals");
  decimals(manifest.destination.decimals, "Destination decimals");
  if (!Number.isSafeInteger(manifest.source.snapshotBlock) || manifest.source.snapshotBlock < 0) throw new Error("Invalid snapshot block.");
  if (!manifest.destination.name?.trim() || !/^[A-Za-z0-9]{1,12}$/.test(manifest.destination.symbol)) throw new Error("Invalid mirror token metadata.");
  const actualHash = sha256(bytes);
  if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) throw new Error("Manifest hash mismatch.");
  if (!Array.isArray(manifest.leaves) || manifest.leaves.length === 0) throw new Error("Manifest has no leaves.");
  let total = 0n;
  const seen = /* @__PURE__ */ new Set();
  for (const leaf of manifest.leaves) {
    const source = address(leaf.zil, "manifest source");
    if (seen.has(source)) throw new Error("Manifest contains a duplicate source.");
    seen.add(source);
    const amount = integer(leaf.amount, "manifest amount");
    if (amount <= 0n || amount >= 1n << 256n) throw new Error("Invalid manifest amount.");
    total += amount;
  }
  if (total.toString() !== manifest.destination.totalBaseUnits) throw new Error("Manifest total mismatch.");
  const root = merkleRoot(
    manifest.leaves.map((leaf) => leafHash(leaf.zil, BigInt(leaf.amount)))
  );
  if (root !== manifest.root) throw new Error("Manifest root mismatch.");
  if (tokenAddress(manifest.chainId, manifest.source.contract, manifest.source.chainId) !== manifest.destination.token) {
    throw new Error("Manifest token address mismatch.");
  }
}

var MAX_BYTES = 10 * 1024 * 1024;
var CID = /^bafy[a-z2-7]{20,100}$/;
var HttpError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
};
async function readBody(request) {
  if (Number(request.headers["content-length"]) > MAX_BYTES) throw new HttpError(413, "Manifest exceeds 10 MiB.");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new HttpError(413, "Manifest exceeds 10 MiB.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function createManifestServer({
  kuboUrl = process.env.IPFS_API_URL ?? "http://127.0.0.1:5001",
  origins = (process.env.MANIFEST_ALLOWED_ORIGINS ?? "http://localhost:5177,http://127.0.0.1:5177").split(",").map((x) => x.trim()),
  trustProxy = process.env.MANIFEST_TRUST_PROXY === "true",
  fetchImpl = fetch
} = {}) {
  const clients = /* @__PURE__ */ new Map();
  let active = 0;
  const rpc = async (method, query, body) => {
    const response = await fetchImpl(`${kuboUrl}/api/v0/${method}?${query}`, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(6e4)
    });
    if (!response.ok) throw new HttpError(502, "IPFS storage is unavailable. Please retry.");
    return response;
  };
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const json = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    let acquired = false;
    try {
      const origin = request.headers.origin;
      if (origin && !origins.includes(origin)) throw new HttpError(403, "Origin is not allowed.");
      if (origin) {
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Vary", "Origin");
      }
      if (request.method === "OPTIONS") {
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Manifest-SHA256");
        response.writeHead(204).end();
        return;
      }
      const pathname = new URL(request.url ?? "/", "http://runtime").pathname;
      if (pathname === "/health" && request.method === "GET") {
        await rpc("id", "");
        json(200, { status: "ok" });
        return;
      }
      const match = /^\/api\/manifests\/ipfs\/([^/]+)$/.exec(pathname);
      if (match && request.method === "GET") {
        const cid = match[1];
        if (!CID.test(cid)) throw new HttpError(400, "Invalid manifest CID.");
        try {
          await rpc("pin/ls", `arg=${cid}&type=recursive`);
        } catch {
          throw new HttpError(404, "Manifest is not pinned on this runtime.");
        }
        const upstream = await rpc("cat", `arg=${cid}&length=${MAX_BYTES + 1}`);
        const bytes2 = new Uint8Array(await upstream.arrayBuffer());
        if (bytes2.length > MAX_BYTES) throw new HttpError(413, "Manifest exceeds 10 MiB.");
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=31536000, immutable" });
        response.end(bytes2);
        return;
      }
      if (pathname !== "/api/manifests" || request.method !== "POST") throw new HttpError(404, "Not found.");
      if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw new HttpError(415, "Send a JSON manifest.");
      const now = Date.now();
      for (const [key2, value] of clients) if (value.until <= now) clients.delete(key2);
      const forwarded = request.headers["x-real-ip"];
      const key = trustProxy && typeof forwarded === "string" && isIP(forwarded) ? forwarded : request.socket.remoteAddress ?? "unknown";
      const client = clients.get(key) ?? { count: 0, until: now + 6e4 };
      if (client.count >= 5 || clients.size >= 1e4 || active >= 2) throw new HttpError(429, "Publishing is busy. Wait a minute and retry.");
      client.count += 1;
      clients.set(key, client);
      active += 1;
      acquired = true;
      const bytes = await readBody(request);
      const hash = sha2562(bytes);
      if (request.headers["x-manifest-sha256"] !== hash) throw new HttpError(400, "Manifest hash mismatch.");
      try {
        const manifest = JSON.parse(bytes.toString("utf8"));
        verifyTokenMigration(manifest, bytes, hash);
      } catch (error) {
        const reason = error instanceof SyntaxError ? "The file must contain valid JSON." : error instanceof TypeError ? "Check the source, destination, and holder allocation fields." : error instanceof Error ? error.message : "Check the manifest fields.";
        throw new HttpError(400, `Invalid token migration manifest: ${reason}`);
      }
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(bytes)]), "migration.json");
      const result = await rpc("add", "pin=true&cid-version=1&raw-leaves=false&wrap-with-directory=false", form);
      const added = JSON.parse((await result.text()).trim());
      if (!added.Hash || !CID.test(added.Hash)) throw new HttpError(502, "IPFS returned an invalid CID.");
      json(201, { uri: `ipfs://${added.Hash}`, hash });
    } catch (error) {
      json(error instanceof HttpError ? error.status : 503, {
        error: error instanceof HttpError ? error.message : "Manifest publishing is unavailable. Please retry."
      });
    } finally {
      if (acquired) active -= 1;
    }
  });
  server.requestTimeout = 7e4;
  server.headersTimeout = 1e4;
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MANIFEST_PORT ?? 8098);
  createManifestServer().listen(port, process.env.MANIFEST_HOST ?? "127.0.0.1", () => {
    console.log(`Manifest publisher listening on port ${port}`);
  });
}
export {
  createManifestServer
};

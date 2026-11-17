import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";
import { hostname } from "./connections.js";

// Fetch only the public invitation route. Pin the resolved address for the
// request, bound the response, and leave signature/checksum trust to the importer.
export async function invitationFromUrl(value) {
  return publicJsonFromUrl(value, "/api/invitation");
}

export async function publicJsonFromUrl(value, allowedPath) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== allowedPath ||
    !["", "26657", "443"].includes(url.port)
  )
    throw new Error(
      "Use the sentry invitation API URL, ending in /api/invitation.",
    );
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (!local) hostname(url.hostname);
  const addresses = await dns.lookup(url.hostname, { all: true, family: 4 });
  if (!addresses.length)
    throw new Error("The sentry hostname has no IPv4 address.");
  for (const { address } of addresses) if (!local) hostname(address);
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).get(
      url,
      {
        lookup: (_name, options, callback) =>
          options.all
            ? callback(null, addresses)
            : callback(null, addresses[0].address, 4),
        headers: { Accept: "application/json" },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(
            new Error(
              "Sentry invitation API returned HTTP " +
                response.statusCode +
                ". Redirects are not followed.",
            ),
          );
          return;
        }
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024)
            request.destroy(new Error("Invitation exceeds 8 MiB."));
          else chunks.push(chunk);
        });
        response.on("end", () =>
          resolve(Buffer.concat(chunks).toString("utf8")),
        );
        response.on("error", reject);
      },
    );
    const timer = setTimeout(
      () => request.destroy(new Error("Sentry invitation API timed out.")),
      15000,
    );
    request.once("close", () => clearTimeout(timer));
    request.once("error", reject);
  });
}

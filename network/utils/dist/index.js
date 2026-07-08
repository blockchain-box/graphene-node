// src/index.ts
import hcrypto from "hypercore-crypto";
import b4a from "b4a";
import sodium from "sodium-universal";
import z32 from "z32";
function generate(seed) {
  if (!seed) {
    seed = hcrypto.randomBytes(32);
  }
  if (typeof seed === "string") {
    if (!/^[0-9a-fA-F]{64}$/.test(seed)) {
      throw new Error("Seed must be 64 hex chars");
    }
    seed = b4a.from(seed, "hex");
  }
  if (seed.byteLength !== 32) {
    throw new Error("Seed must be 32 bytes");
  }
  const [NS_HMAC_KEY, NS_CAPABILITY] = hcrypto.namespace("grph", 2);
  const keyPair = hcrypto.keyPair(seed);
  const hmac = hcrypto.hash([NS_HMAC_KEY, seed]);
  const capability = b4a.alloc(32);
  sodium.crypto_generichash(
    capability,
    b4a.concat([NS_CAPABILITY, keyPair.publicKey]),
    hmac
  );
  const VERSION = b4a.from([1]);
  const base = b4a.concat([VERSION, keyPair.publicKey, capability]);
  const checksum = hcrypto.hash(base).subarray(0, 4);
  const inviteBuf = b4a.concat([base, checksum]);
  const invite = "grph_" + z32.encode(inviteBuf);
  return { seed, keyPair, hmac, capability, invite };
}
function parse(invite) {
  if (typeof invite !== "string" || !invite.startsWith("grph_")) {
    throw new Error("Invalid invite format");
  }
  const encoded = invite.slice(3);
  let buf;
  try {
    buf = z32.decode(encoded);
  } catch {
    throw new Error("Invalid encoding");
  }
  if (buf.byteLength !== 69) throw new Error("Invalid v1 invite length");
  const version = buf[0];
  if (version !== 1) throw new Error("Unsupported invite version");
  const publicKey = buf.subarray(1, 33);
  const capability = buf.subarray(33, 65);
  const checksum = buf.subarray(65, 69);
  const expected = hcrypto.hash(buf.subarray(0, 65)).subarray(0, 4);
  if (!b4a.equals(checksum, expected)) {
    throw new Error("Checksum mismatch");
  }
  return {
    version,
    publicKey,
    capability
  };
}
function randomSeed() {
  const seed = hcrypto.randomBytes(32);
  return b4a.toString(seed, "hex");
}
export {
  generate,
  parse,
  randomSeed
};
//# sourceMappingURL=index.js.map
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  generate: () => generate,
  parse: () => parse,
  randomSeed: () => randomSeed
});
module.exports = __toCommonJS(index_exports);
var import_hypercore_crypto = __toESM(require("hypercore-crypto"), 1);
var import_b4a = __toESM(require("b4a"), 1);
var import_sodium_universal = __toESM(require("sodium-universal"), 1);
var import_z32 = __toESM(require("z32"), 1);
function generate(seed) {
  if (!seed) {
    seed = import_hypercore_crypto.default.randomBytes(32);
  }
  if (typeof seed === "string") {
    if (!/^[0-9a-fA-F]{64}$/.test(seed)) {
      throw new Error("Seed must be 64 hex chars");
    }
    seed = import_b4a.default.from(seed, "hex");
  }
  if (seed.byteLength !== 32) {
    throw new Error("Seed must be 32 bytes");
  }
  const [NS_HMAC_KEY, NS_CAPABILITY] = import_hypercore_crypto.default.namespace("grph", 2);
  const keyPair = import_hypercore_crypto.default.keyPair(seed);
  const hmac = import_hypercore_crypto.default.hash([NS_HMAC_KEY, seed]);
  const capability = import_b4a.default.alloc(32);
  import_sodium_universal.default.crypto_generichash(
    capability,
    import_b4a.default.concat([NS_CAPABILITY, keyPair.publicKey]),
    hmac
  );
  const VERSION = import_b4a.default.from([1]);
  const base = import_b4a.default.concat([VERSION, keyPair.publicKey, capability]);
  const checksum = import_hypercore_crypto.default.hash(base).subarray(0, 4);
  const inviteBuf = import_b4a.default.concat([base, checksum]);
  const invite = "grph_" + import_z32.default.encode(inviteBuf);
  return { seed, keyPair, hmac, capability, invite };
}
function parse(invite) {
  if (typeof invite !== "string" || !invite.startsWith("grph_")) {
    throw new Error("Invalid invite format");
  }
  const encoded = invite.slice(3);
  let buf;
  try {
    buf = import_z32.default.decode(encoded);
  } catch {
    throw new Error("Invalid encoding");
  }
  if (buf.byteLength !== 69) throw new Error("Invalid v1 invite length");
  const version = buf[0];
  if (version !== 1) throw new Error("Unsupported invite version");
  const publicKey = buf.subarray(1, 33);
  const capability = buf.subarray(33, 65);
  const checksum = buf.subarray(65, 69);
  const expected = import_hypercore_crypto.default.hash(buf.subarray(0, 65)).subarray(0, 4);
  if (!import_b4a.default.equals(checksum, expected)) {
    throw new Error("Checksum mismatch");
  }
  return {
    version,
    publicKey,
    capability
  };
}
function randomSeed() {
  const seed = import_hypercore_crypto.default.randomBytes(32);
  return import_b4a.default.toString(seed, "hex");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  generate,
  parse,
  randomSeed
});
//# sourceMappingURL=index.cjs.map
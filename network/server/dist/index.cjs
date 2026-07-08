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
  GrphServer: () => GrphServer,
  default: () => index_default
});
module.exports = __toCommonJS(index_exports);
var import_crypto = __toESM(require("crypto"), 1);
var import_hyperdht = __toESM(require("hyperdht"), 1);
var import_b4a = __toESM(require("b4a"), 1);
var import_z32 = __toESM(require("z32"), 1);
var import_net = require("@grph-net/net");
var GrphServer = class {
  logger;
  dht;
  stats;
  server;
  keyPair;
  seed;
  state;
  connection;
  refreshInterval;
  activeConnections;
  args;
  secure;
  constructor(opts = {}) {
    this.logger = opts.silent ? { log: () => {
    } } : opts.logger || { log: () => {
    } };
    this.dht = new import_hyperdht.default();
    this.stats = {};
    this.server = null;
    this.keyPair = null;
    this.seed = null;
    this.state = null;
    this.connection = null;
    this.refreshInterval = null;
    this.activeConnections = /* @__PURE__ */ new Map();
    this.args = opts;
    this.secure = false;
  }
  generateKeyPair(seed = import_crypto.default.randomBytes(32).toString("hex")) {
    this.seed = Buffer.from(seed, "hex");
    this.keyPair = import_hyperdht.default.keyPair(this.seed);
    this.logger.log({ type: 0, msg: `Generated key pair from seed: ${seed}` });
    return this.keyPair;
  }
  async start(args, callback) {
    this.logger.log({ type: 1, msg: "Starting server" });
    this.args = args;
    this.secure = args.secure === true;
    this.generateKeyPair(args.seed);
    let privateFirewall = false;
    if (this.secure) {
      privateFirewall = (remotePublicKey) => {
        return !import_b4a.default.equals(remotePublicKey, this.keyPair.publicKey);
      };
      this.logger.log({ type: 1, msg: "Using Private Mode" });
    } else {
      this.logger.log({ type: 1, msg: "Using Public Mode" });
    }
    this.server = this.dht.createServer(
      {
        firewall: privateFirewall,
        reusableSocket: true
      },
      (c) => {
        const encodedKey = import_z32.default.encode(c.remotePublicKey);
        this.logger.log({
          type: 0,
          msg: `Incoming connection received from ${encodedKey}`
        });
        const count = this.activeConnections.get(encodedKey) || 0;
        this.activeConnections.set(encodedKey, count + 1);
        if (!args.udp) {
          this.handleTCP(c, args);
        } else {
          this.handleUDP(c, args);
        }
      }
    );
    this.logger.log({ type: 0, msg: "Server created, awaiting listen" });
    await this.server.listen(this.keyPair);
    this.state = "listening";
    this.logger.log({ type: 1, msg: `Server listening on key: ${this.key}` });
    if (typeof callback === "function") {
      callback();
    }
    const interval = 50 * 60 * 1e3;
    const data = JSON.stringify({
      host: this.args.host,
      udp: this.args.udp,
      port: this.args.port
    });
    this.logger.log({
      type: 0,
      msg: `Initializing DHT with host info: ${data}`
    });
    await this.put(data);
    this.refreshInterval = setInterval(async () => {
      this.logger.log({ type: 0, msg: `Refreshing DHT record: ${data}` });
      await this.put(data);
    }, interval);
  }
  handleTCP(c, args) {
    this.logger.log({ type: 0, msg: "Handling TCP connection" });
    const encodedKey = import_z32.default.encode(c.remotePublicKey);
    c.on("close", () => {
      let count = this.activeConnections.get(encodedKey) || 1;
      count--;
      if (count <= 0) {
        this.logger.log({ type: 0, msg: `Disconnected from ${encodedKey}` });
        this.activeConnections.delete(encodedKey);
      } else {
        this.activeConnections.set(encodedKey, count);
      }
    });
    this.connection = (0, import_net.pipeTcpServer)(
      c,
      { port: args.port, host: args.host },
      { isServer: true, compress: false, logger: this.logger },
      this.stats
    );
    this.logger.log({ type: 0, msg: "TCP connection piped" });
  }
  handleUDP(c, args) {
    this.logger.log({ type: 0, msg: "Handling UDP connection" });
    const encodedKey = import_z32.default.encode(c.remotePublicKey);
    c.on("close", () => {
      let count = this.activeConnections.get(encodedKey) || 1;
      count--;
      if (count <= 0) {
        this.logger.log({ type: 0, msg: `Disconnected from ${encodedKey}` });
        this.activeConnections.delete(encodedKey);
      } else {
        this.activeConnections.set(encodedKey, count);
      }
    });
    (0, import_net.pipeUdpFramedServer)(
      c,
      { port: args.port, host: args.host },
      this.logger,
      this.stats
    );
    this.logger.log({ type: 0, msg: "UDP connection framed and piped" });
  }
  get key() {
    if (this.secure) {
      return import_z32.default.encode(this.seed);
    }
    return import_z32.default.encode(this.keyPair.publicKey);
  }
  async resume() {
    this.logger.log({ type: 1, msg: "Resuming server" });
    await this.dht.resume();
    this.state = "listening";
    this.logger.log({ type: 1, msg: "Server resumed" });
  }
  async pause() {
    this.logger.log({ type: 1, msg: "Pausing server" });
    await this.dht.suspend();
    this.state = "paused";
    this.logger.log({ type: 1, msg: "Server paused" });
  }
  async destroy() {
    this.logger.log({ type: 1, msg: "Destroying server" });
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
      this.logger.log({ type: 1, msg: "Cleared DHT refresh interval" });
    }
    if (this.dht) await this.dht.destroy();
    this.dht = null;
    this.server = null;
    this.connection = null;
    this.state = "destroyed";
    this.logger.log({ type: 1, msg: "Server destroyed" });
  }
  async put(data, opts = {}) {
    if (data == null) {
      throw new Error("data cannot be undefined");
    }
    this.logger.log({ type: 0, msg: `Putting DHT record: ${data}` });
    this.logger.log({
      type: 0,
      msg: `Incoming data type: ${typeof data}, value: ${data}`
    });
    data = import_b4a.default.isBuffer(data) ? data : Buffer.from(data);
    this.logger.log({ type: 0, msg: "Checking for existing DHT record" });
    const oldRecord = await this.get({ latest: true });
    const putOpts = { ...opts };
    if (oldRecord) {
      if (oldRecord.value == null) {
        this.logger.log({
          type: 0,
          msg: "oldRecord.value is null or undefined"
        });
        putOpts.seq = oldRecord.seq + 1;
      } else {
        const same = import_b4a.default.equals(import_b4a.default.from(oldRecord.value), data);
        putOpts.seq = same ? oldRecord.seq : oldRecord.seq + 1;
        this.logger.log({
          type: 0,
          msg: `Existing record found, putting with seq: ${putOpts.seq} (same: ${same})`
        });
      }
    } else {
      this.logger.log({
        type: 0,
        msg: "No existing DHT record found, creating new"
      });
    }
    const { seq } = await this.dht.mutablePut(this.keyPair, data, putOpts);
    this.logger.log({ type: 0, msg: `DHT put completed with seq: ${seq}` });
    return seq;
  }
  async get(opts = {}) {
    const record = await this.dht.mutableGet(this.keyPair.publicKey, opts);
    if (record) {
      const value = import_b4a.default.toString(record.value);
      this.logger.log({
        type: 0,
        msg: `Existing DHT record found: seq=${record.seq}, value=${value}`
      });
      return { seq: record.seq, value };
    }
    return null;
  }
  get info() {
    return {
      type: "server",
      state: this.state,
      secure: this.secure,
      port: this.args.port,
      host: this.args.host,
      protocol: this.args.udp ? "udp" : "tcp",
      seed: this.args.seed,
      key: this.key,
      publicKey: import_z32.default.encode(this.keyPair.publicKey)
    };
  }
};
var index_default = GrphServer;
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GrphServer
});
//# sourceMappingURL=index.cjs.map
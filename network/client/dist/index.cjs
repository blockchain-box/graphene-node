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
  GrphClient: () => GrphClient,
  default: () => index_default
});
module.exports = __toCommonJS(index_exports);
var import_hyperdht = __toESM(require("hyperdht"), 1);
var import_b4a = __toESM(require("b4a"), 1);
var import_z32 = __toESM(require("z32"), 1);
var import_net = require("@grph-net/net");
var GrphClient = class {
  logger;
  seed;
  secure;
  keyPair;
  publicKey;
  dht;
  stats;
  proxy;
  clients;
  state;
  args;
  constructor(opts) {
    this.logger = opts.silent ? { log: () => {
    } } : opts.logger || { log: () => {
    } };
    this.seed = opts.key;
    this.secure = opts.secure || false;
    if (this.secure) {
      this.keyPair = import_hyperdht.default.keyPair(import_z32.default.decode(this.seed));
      this.publicKey = this.keyPair.publicKey;
    } else {
      this.publicKey = import_z32.default.decode(this.seed);
    }
    this.dht = new import_hyperdht.default({ keyPair: this.keyPair });
    this.stats = {};
    this.proxy = null;
    this.clients = null;
    this.args = {};
  }
  async connect(options = {}, callback) {
    this.logger.log({
      type: 1,
      msg: `Connecting to key: ${this.seed}, secure: ${this.secure}`
    });
    let dhtData = {};
    const dhtValue = await this.get();
    if (dhtValue) {
      dhtData = JSON.parse(dhtValue.value);
      this.logger.log({
        type: 0,
        msg: `Retrieved DHT data: ${JSON.stringify(dhtData)}`
      });
    } else {
      this.logger.log({ type: 2, msg: "No DHT data retrieved" });
    }
    options.port = options.port ?? dhtData.port ?? 8989;
    options.host = options.host ?? dhtData.host ?? "127.0.0.1";
    options.udp = options.udp ?? dhtData.udp ?? false;
    this.args = options;
    this.state = "waiting";
    if (!options.udp) {
      this.handleTCP(options, callback);
    } else {
      this.handleUDP(options, callback);
    }
  }
  handleTCP(options, callback) {
    this.logger.log({ type: 0, msg: "Handling TCP connection" });
    this.proxy = (0, import_net.createTcpProxy)(
      { port: options.port, host: options.host },
      () => this.dht.connect(this.publicKey, { reusableSocket: true }),
      { compress: false, logger: this.logger },
      this.stats,
      () => {
        this.state = "listening";
        this.logger.log({
          type: 1,
          msg: `Proxy listening on ${options.host}:${options.port}`
        });
        callback?.();
      }
    );
  }
  handleUDP(options, callback) {
    this.logger.log({ type: 0, msg: "Handling UDP connection" });
    const result = (0, import_net.createUdpFramedProxy)(
      { port: options.port, host: options.host },
      () => this.dht.connect(this.publicKey),
      this.logger,
      () => {
        this.state = "listening";
        this.logger.log({
          type: 1,
          msg: `Proxy listening on ${options.host}:${options.port} for UDP`
        });
        callback?.();
      }
    );
    this.proxy = result.proxySocket;
    this.clients = result.clients;
  }
  async resume() {
    this.logger.log({ type: 1, msg: "Resuming client" });
    await this.dht.resume();
    this.state = "listening";
    this.logger.log({ type: 1, msg: "Client resumed" });
  }
  async pause() {
    this.logger.log({ type: 1, msg: "Pausing client" });
    await this.dht.suspend();
    this.state = "paused";
    this.logger.log({ type: 1, msg: "Client paused" });
  }
  async destroy() {
    this.logger.log({ type: 1, msg: "Destroying client" });
    await this.dht.destroy();
    if (this.proxy && "close" in this.proxy) {
      this.proxy.close();
    }
    if (this.clients) {
      for (const client of this.clients.values()) {
        client.remoteStream?.destroy();
      }
      this.clients.clear();
    }
    this.proxy = null;
    this.clients = null;
    this.state = "destroyed";
    this.logger.log({ type: 1, msg: "Client destroyed" });
  }
  async get(opts = {}) {
    this.logger.log({ type: 0, msg: "Getting DHT record" });
    const record = await this.dht.mutableGet(this.publicKey, opts);
    if (record) {
      const value = import_b4a.default.toString(record.value);
      this.logger.log({
        type: 0,
        msg: `DHT get completed: seq=${record.seq}, value=${value}`
      });
      return { seq: record.seq, value };
    }
    this.logger.log({ type: 2, msg: "DHT get: no record found" });
    return null;
  }
  get info() {
    return {
      type: "client",
      state: this.state,
      secure: this.secure,
      port: this.args.port,
      host: this.args.host,
      protocol: this.args.udp ? "udp" : "tcp",
      key: this.seed,
      publicKey: import_z32.default.encode(this.publicKey)
    };
  }
  static async ping(key, dht) {
    let ownDht = false;
    if (!dht) {
      dht = new import_hyperdht.default();
      ownDht = true;
    }
    let result = null;
    const keyBuffer = import_z32.default.decode(key);
    let publicKey = import_hyperdht.default.keyPair(keyBuffer).publicKey;
    let record = await dht.mutableGet(publicKey, { latest: true });
    if (record) {
      const value = import_b4a.default.toString(record.value);
      try {
        result = JSON.parse(value);
        result.protocol = result.udp ? "udp" : "tcp";
      } catch {
      }
    }
    if (!result) {
      publicKey = keyBuffer;
      record = await dht.mutableGet(publicKey, { latest: true });
      if (record) {
        const value = import_b4a.default.toString(record.value);
        try {
          result = JSON.parse(value);
          result.protocol = result.udp ? "udp" : "tcp";
        } catch {
        }
      }
    }
    if (ownDht) {
      await dht.destroy();
    }
    return result;
  }
};
var index_default = GrphClient;
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GrphClient
});
//# sourceMappingURL=index.cjs.map
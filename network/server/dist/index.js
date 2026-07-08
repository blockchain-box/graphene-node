// src/index.ts
import crypto from "crypto";
import HyperDHT from "hyperdht";
import b4a from "b4a";
import z32 from "z32";
import { pipeTcpServer, pipeUdpFramedServer } from "@grph-net/net";
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
    this.dht = new HyperDHT();
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
  generateKeyPair(seed = crypto.randomBytes(32).toString("hex")) {
    this.seed = Buffer.from(seed, "hex");
    this.keyPair = HyperDHT.keyPair(this.seed);
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
        return !b4a.equals(remotePublicKey, this.keyPair.publicKey);
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
        const encodedKey = z32.encode(c.remotePublicKey);
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
    const encodedKey = z32.encode(c.remotePublicKey);
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
    this.connection = pipeTcpServer(
      c,
      { port: args.port, host: args.host },
      { isServer: true, compress: false, logger: this.logger },
      this.stats
    );
    this.logger.log({ type: 0, msg: "TCP connection piped" });
  }
  handleUDP(c, args) {
    this.logger.log({ type: 0, msg: "Handling UDP connection" });
    const encodedKey = z32.encode(c.remotePublicKey);
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
    pipeUdpFramedServer(
      c,
      { port: args.port, host: args.host },
      this.logger,
      this.stats
    );
    this.logger.log({ type: 0, msg: "UDP connection framed and piped" });
  }
  get key() {
    if (this.secure) {
      return z32.encode(this.seed);
    }
    return z32.encode(this.keyPair.publicKey);
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
    data = b4a.isBuffer(data) ? data : Buffer.from(data);
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
        const same = b4a.equals(b4a.from(oldRecord.value), data);
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
      const value = b4a.toString(record.value);
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
      publicKey: z32.encode(this.keyPair.publicKey)
    };
  }
};
var index_default = GrphServer;
export {
  GrphServer,
  index_default as default
};
//# sourceMappingURL=index.js.map
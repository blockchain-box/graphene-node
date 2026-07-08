// src/index.ts
import HyperDHT from "hyperdht";
import b4a from "b4a";
import z32 from "z32";
import { createTcpProxy, createUdpFramedProxy } from "@grph-net/net";
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
      this.keyPair = HyperDHT.keyPair(z32.decode(this.seed));
      this.publicKey = this.keyPair.publicKey;
    } else {
      this.publicKey = z32.decode(this.seed);
    }
    this.dht = new HyperDHT({ keyPair: this.keyPair });
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
    this.proxy = createTcpProxy(
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
    const result = createUdpFramedProxy(
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
      const value = b4a.toString(record.value);
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
      publicKey: z32.encode(this.publicKey)
    };
  }
  static async ping(key, dht) {
    let ownDht = false;
    if (!dht) {
      dht = new HyperDHT();
      ownDht = true;
    }
    let result = null;
    const keyBuffer = z32.decode(key);
    let publicKey = HyperDHT.keyPair(keyBuffer).publicKey;
    let record = await dht.mutableGet(publicKey, { latest: true });
    if (record) {
      const value = b4a.toString(record.value);
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
        const value = b4a.toString(record.value);
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
export {
  GrphClient,
  index_default as default
};
//# sourceMappingURL=index.js.map
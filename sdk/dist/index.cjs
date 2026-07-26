"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  GrphClient: () => GrphClient,
  GrphClientBuilder: () => GrphClientBuilder,
  GrphRestClient: () => GrphRestClient,
  GrphRpcClient: () => GrphRpcClient,
  GrphWsClient: () => GrphWsClient,
  defaultConfig: () => defaultConfig
});
module.exports = __toCommonJS(index_exports);

// src/GrphRestClient.ts
var GrphRestClient = class {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }
  baseUrl;
  async get(path, params) {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== void 0 && v !== null && v !== "") url.searchParams.set(k, v);
      });
    }
    const response = await fetch(url.toString());
    if (response.status === 204) return null;
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`REST ${path} failed (${response.status}): ${body}`);
    }
    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text);
  }
  async getAccount(address) {
    return this.get("/graphene/state/account", { address });
  }
  async getSyncStatus() {
    return this.get("/graphene/state/sync-status");
  }
  async getStakePot(chainId) {
    return this.get("/graphene/state/stake/pot", { chainId });
  }
  async getValidators(chainId) {
    return this.get("/graphene/state/stake/validators", { chainId });
  }
  async getDelegations(params) {
    return this.get("/graphene/state/stake/delegators", {
      chainId: params.chainId,
      address: params.address,
      page: params.page?.toString(),
      size: params.size?.toString()
    });
  }
  async getDelegation(chainId, validatorAddress, delegatorAddress) {
    return this.get("/graphene/state/stake/delegator", { chainId, validatorAddress, delegatorAddress });
  }
  async getValidatorReward(chainId, validatorAddress) {
    return this.get("/graphene/state/stake/validator/reward", { chainId, validatorAddress });
  }
  async getDelegatorReward(chainId, validatorAddress, delegatorAddress) {
    return this.get("/graphene/state/stake/delegator/reward", { chainId, validatorAddress, delegatorAddress });
  }
  async getMyDelegations(chainId, delegatorAddress) {
    return this.get("/graphene/state/stake/my-delegations", { chainId, delegatorAddress });
  }
  async getTokens() {
    return this.get("/graphene/state/tokens");
  }
  async getVaultBalances(address) {
    return this.get("/graphene/state/vault-balances", { address });
  }
  async getTenants() {
    return this.get("/graphene/state/tenants");
  }
  async getTenant(owner) {
    return this.get("/graphene/state/tenant", { owner });
  }
  async getChainConfig(chainId) {
    return this.get("/graphene/state/chain-config", { chainId });
  }
  async getAttestSchemas(page, size) {
    return this.get("/graphene/state/attest/schemas", {
      page: page?.toString(),
      size: size?.toString()
    });
  }
  async getAttestSchema(uid) {
    return this.get("/graphene/state/attest/schema", { uid });
  }
  async getAttestations(params) {
    return this.get("/graphene/state/attest/attestations", {
      attester: params.attester,
      recipient: params.recipient,
      schemaUID: params.schemaUID,
      revoked: params.revoked?.toString(),
      page: params.page?.toString(),
      size: params.size?.toString()
    });
  }
  async getAttestation(uid) {
    return this.get("/graphene/state/attest/attestation", { uid });
  }
  async verifyAttestation(uid) {
    return this.get("/graphene/state/attest/verify", { uid });
  }
  async decodeAttestation(uid) {
    return this.get("/graphene/state/attest/decode", { uid });
  }
  async getSentries() {
    return this.get("/graphene/state/platform/sentries");
  }
  async getValidatorPlatform(address) {
    return this.get(`/graphene/state/platform/validators/${address}`);
  }
  async getSentryApplications(params) {
    return this.get("/graphene/state/platform/applications", {
      validator: params.validator,
      sentryId: params.sentryId
    });
  }
  async getAssignments(params) {
    return this.get("/graphene/state/platform/assignments", {
      sentryId: params.sentryId,
      validator: params.validator
    });
  }
};

// src/GrphRpcClient.ts
var GrphRpcClient = class {
  constructor(rpcUrl) {
    this.rpcUrl = rpcUrl;
  }
  rpcUrl;
  idCounter = 1;
  async call(method, params = []) {
    const request = {
      jsonrpc: "2.0",
      method,
      params,
      id: this.idCounter++
    };
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request)
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`RPC ${method} failed (${response.status}): ${body}`);
    }
    const text = await response.text();
    if (!text) {
      throw new Error(`RPC ${method} returned empty response (status ${response.status})`);
    }
    const json = JSON.parse(text);
    if (json.error) {
      throw new Error(`RPC ${method} error (${json.error.code}): ${json.error.message}`);
    }
    return json.result;
  }
  async web3_clientVersion() {
    return this.call("web3_clientVersion");
  }
  async eth_sha3(data) {
    return this.call("eth_sha3", [data]);
  }
  async net_version() {
    return this.call("net_version");
  }
  async net_peerCount() {
    return this.call("net_peerCount");
  }
  async net_listening() {
    return this.call("net_listening");
  }
  async eth_syncing() {
    return this.call("eth_syncing");
  }
  async eth_mining() {
    return this.call("eth_mining");
  }
  async eth_chainId() {
    return this.call("eth_chainId");
  }
  async eth_blockNumber() {
    return this.call("eth_blockNumber");
  }
  async eth_getBlockByNumber(blockNumber, fullTx = false) {
    return this.call("eth_getBlockByNumber", [blockNumber, fullTx]);
  }
  async eth_getBlockByHash(blockHash, fullTx = false) {
    return this.call("eth_getBlockByHash", [blockHash, fullTx]);
  }
  async eth_sendRawTransaction(data) {
    return this.call("eth_sendRawTransaction", [data]);
  }
  async eth_sendRawTransactionBatch(data) {
    return this.call("eth_sendRawTransactionBatch", [data]);
  }
  async eth_call(tx, blockTag = "latest") {
    return this.call("eth_call", [tx, blockTag]);
  }
  async eth_estimateGas(tx) {
    return this.call("eth_estimateGas", [tx]);
  }
  async eth_getTransactionByHash(hash) {
    return this.call("eth_getTransactionByHash", [hash]);
  }
  async eth_getTransactionReceipt(hash) {
    return this.call("eth_getTransactionReceipt", [hash]);
  }
  async txpool_content() {
    return this.call("txpool_content");
  }
  async eth_getCode(address, blockTag = "latest") {
    return this.call("eth_getCode", [address, blockTag]);
  }
  async eth_getTransactionCount(address, blockTag = "latest") {
    return this.call("eth_getTransactionCount", [address, blockTag]);
  }
  async eth_getBalance(address, blockTag = "latest") {
    return this.call("eth_getBalance", [address, blockTag]);
  }
  async eth_gasPrice() {
    return this.call("eth_gasPrice");
  }
  async eth_maxPriorityFeePerGas() {
    return this.call("eth_maxPriorityFeePerGas");
  }
  async eth_feeHistory(blockCount, newestBlock, rewardPercentiles) {
    return this.call("eth_feeHistory", [blockCount, newestBlock, rewardPercentiles]);
  }
  async eth_getToken(address) {
    return this.call("eth_getToken", [address]);
  }
  async eth_getTokens() {
    return this.call("eth_getTokens");
  }
};

// src/GrphWsClient.ts
var import_rxjs = require("rxjs");
var WsConnection = class {
  constructor(url, onMessage, onStatus, reconnectConfig) {
    this.url = url;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.reconnectConfig = reconnectConfig;
  }
  url;
  onMessage;
  onStatus;
  reconnectConfig;
  ws = null;
  reconnectAttempts = 0;
  reconnectTimer = null;
  destroyed = false;
  connect() {
    if (this.destroyed) return;
    try {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.onStatus("connected");
      };
      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.onMessage(data);
        } catch {
          this.onMessage(event.data);
        }
      };
      this.ws.onclose = () => {
        this.onStatus("disconnected");
        this.scheduleReconnect();
      };
      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch {
      this.scheduleReconnect();
    }
  }
  send(data) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }
  scheduleReconnect() {
    if (this.destroyed || !this.reconnectConfig.enabled) return;
    if (this.reconnectAttempts >= this.reconnectConfig.maxRetries) {
      this.onStatus("disconnected");
      return;
    }
    this.reconnectAttempts++;
    this.onStatus("reconnecting");
    const delay = Math.min(
      this.reconnectConfig.baseDelayMs * Math.pow(2, this.reconnectAttempts - 1),
      this.reconnectConfig.maxDelayMs
    );
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
  close() {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
  }
};
function wsUrl(baseUrl, path) {
  return baseUrl.replace(/^http/, "ws") + path;
}
var GrphWsClient = class {
  constructor(baseUrl, config) {
    this.baseUrl = baseUrl;
    this.config = config;
  }
  baseUrl;
  config;
  connections = [];
  txWatch(req) {
    const path = "/graphene/tx-watch";
    const url = wsUrl(this.baseUrl, path);
    return new import_rxjs.Observable((subscriber) => {
      const conn = new WsConnection(
        url,
        (data) => {
          const msg = data;
          subscriber.next(msg);
          if (msg.type === "ready" || msg.type === "timeout" || msg.type === "error") {
            subscriber.complete();
            conn.close();
          }
        },
        (status) => {
          if (status === "disconnected") subscriber.error(new Error("WebSocket disconnected"));
        },
        this.config.reconnect
      );
      this.connections.push(conn);
      conn.connect();
      conn.send({ txHash: req.txHash, domain: req.domain });
      return () => {
        conn.close();
        this.connections = this.connections.filter((c) => c !== conn);
      };
    });
  }
  blocks() {
    const path = "/graphene/ws/blocks";
    const url = wsUrl(this.baseUrl, path);
    return new import_rxjs.Observable((subscriber) => {
      const conn = new WsConnection(
        url,
        (data) => subscriber.next(data),
        (status) => {
          if (status === "disconnected") subscriber.error(new Error("WebSocket disconnected"));
        },
        this.config.reconnect
      );
      this.connections.push(conn);
      conn.connect();
      return () => {
        conn.close();
        this.connections = this.connections.filter((c) => c !== conn);
      };
    });
  }
  close() {
    for (const conn of this.connections) {
      conn.close();
    }
    this.connections = [];
  }
};

// src/GrphClient.ts
var GrphClient = class {
  constructor(config) {
    this.config = config;
    this.rest = new GrphRestClient(config.baseUrl);
    this.rpc = new GrphRpcClient(`${config.baseUrl}/rpc`);
    this.ws = new GrphWsClient(config.baseUrl, config);
  }
  config;
  rest;
  rpc;
  ws;
  getConfig() {
    return { ...this.config };
  }
};

// src/types.ts
var DEFAULT_CONFIG = {
  baseUrl: "http://localhost:3003/graphene-evm",
  rpc: true,
  ws: {
    txWatch: true,
    blocks: true
  },
  reconnect: {
    enabled: true,
    maxRetries: 10,
    baseDelayMs: 1e3,
    maxDelayMs: 3e4
  }
};
function defaultConfig() {
  return { ...DEFAULT_CONFIG };
}

// src/GrphClientBuilder.ts
var GrphClientBuilder = class _GrphClientBuilder {
  config;
  constructor() {
    this.config = defaultConfig();
  }
  baseUrl(url) {
    this.config.baseUrl = url.replace(/\/$/, "");
    return this;
  }
  rpc(enable) {
    this.config.rpc = enable;
    return this;
  }
  ws(options) {
    if (options.txWatch !== void 0) this.config.ws.txWatch = options.txWatch;
    if (options.blocks !== void 0) this.config.ws.blocks = options.blocks;
    return this;
  }
  reconnect(options) {
    if (options.enabled !== void 0) this.config.reconnect.enabled = options.enabled;
    if (options.maxRetries !== void 0) this.config.reconnect.maxRetries = options.maxRetries;
    if (options.baseDelayMs !== void 0) this.config.reconnect.baseDelayMs = options.baseDelayMs;
    if (options.maxDelayMs !== void 0) this.config.reconnect.maxDelayMs = options.maxDelayMs;
    return this;
  }
  build() {
    return new GrphClient({ ...this.config });
  }
  static configure() {
    return new _GrphClientBuilder();
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GrphClient,
  GrphClientBuilder,
  GrphRestClient,
  GrphRpcClient,
  GrphWsClient,
  defaultConfig
});
//# sourceMappingURL=index.cjs.map
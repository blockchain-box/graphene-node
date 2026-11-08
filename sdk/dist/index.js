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
  async getGovernanceConfig(chainId) {
    return this.get(`/graphene/state/governance/${encodeURIComponent(chainId)}/config`);
  }
  async getActiveProposals(chainId) {
    return this.get(`/graphene/state/governance/${encodeURIComponent(chainId)}/active`);
  }
  async getGovernanceProposal(chainId, id) {
    return this.get(`/graphene/state/governance/${encodeURIComponent(chainId)}/proposals/${encodeURIComponent(id)}`);
  }
  async getMintRequest(chainId, id) {
    return this.get(`/graphene/state/governance/${encodeURIComponent(chainId)}/mints/${encodeURIComponent(id)}`);
  }
  async getGovernanceEvent(chainId, reference, type, actor) {
    return this.get(`/graphene/state/governance/${encodeURIComponent(chainId)}/events/${encodeURIComponent(reference)}/${encodeURIComponent(type)}/${encodeURIComponent(actor)}`);
  }
  async getControlledToken(chainId, address) {
    return this.get(`/graphene/state/governance/${encodeURIComponent(chainId)}/tokens/${encodeURIComponent(address)}`);
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
  async getTokens(chainId, page = 0, size = 20) {
    return this.get("/graphene/state/tokens", { chainId, page: String(page), size: String(size) });
  }
  async getTokenHolders(chainId, token, page = 0, size = 20) {
    return this.get("/graphene/state/tokens/holders", {
      chainId,
      token,
      page: String(page),
      size: String(size)
    });
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
import { Observable, Subject } from "rxjs";
import { filter, share } from "rxjs/operators";
var CursorPaginatedObservable = class {
  constructor(observable, domain, send) {
    this.observable = observable;
    this.domain = domain;
    this.send = send;
  }
  observable;
  domain;
  send;
  subscribe(observerOrNext, error, complete) {
    return this.observable.subscribe(observerOrNext, error, complete);
  }
  requestNextPage(cursor) {
    this.send({ type: "nextPage", domain: this.domain, cursor });
  }
  pipe() {
    return this.observable.pipe();
  }
};
var WsConnection = class {
  constructor(url, onMessage, onStatus, reconnectConfig, onReconnected) {
    this.url = url;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.reconnectConfig = reconnectConfig;
    this.onReconnected = onReconnected;
  }
  url;
  onMessage;
  onStatus;
  reconnectConfig;
  onReconnected;
  ws = null;
  reconnectAttempts = 0;
  reconnectTimer = null;
  destroyed = false;
  previouslyConnected = false;
  pendingMessages = [];
  connect() {
    if (this.destroyed) return;
    try {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.onStatus("connected");
        this.flushPending();
        if (this.previouslyConnected && this.onReconnected) {
          this.onReconnected();
        }
        this.previouslyConnected = true;
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
    } else {
      this.pendingMessages.push(data);
    }
  }
  flushPending() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    while (this.pendingMessages.length > 0) {
      this.ws.send(JSON.stringify(this.pendingMessages.shift()));
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
    this.pendingMessages = [];
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
  stateWatchConn = null;
  txWatch(req) {
    const path = "/graphene/tx-watch";
    const url = wsUrl(this.baseUrl, path);
    return new Observable((subscriber) => {
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
    return new Observable((subscriber) => {
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
    if (this.stateWatchConn) {
      this.stateWatchConn.destroy();
      this.stateWatchConn = null;
    }
  }
  stateWatch() {
    if (!this.stateWatchConn) {
      const path = "/graphene/ws/state-watch";
      const url = wsUrl(this.baseUrl, path);
      this.stateWatchConn = new StateWatchConnection(url, this.config.reconnect);
      this.connections.push(this.stateWatchConn.connection);
    }
    return {
      account: (addresses) => this.stateWatchConn.observe("account", addresses ? { addresses } : void 0),
      stake: () => this.stateWatchConn.observe("stake"),
      token: () => this.stateWatchConn.observe("token"),
      vault: () => this.stateWatchConn.observe("vault"),
      config: () => this.stateWatchConn.observe("config"),
      tenant: () => this.stateWatchConn.observe("tenant"),
      platform: () => this.stateWatchConn.observe("platform"),
      attest: () => this.stateWatchConn.observe("attest")
    };
  }
};
var StateWatchConnection = class {
  subject = new Subject();
  subscriptions = /* @__PURE__ */ new Map();
  refCount = 0;
  connection;
  constructor(url, reconnectConfig) {
    this.connection = new WsConnection(
      url,
      (data) => this.subject.next(data),
      () => {
      },
      reconnectConfig,
      () => this.resubscribeAll()
    );
  }
  observe(domain, scope, lastBlock) {
    const observable = new Observable((subscriber) => {
      if (this.refCount === 0) {
        this.connection.connect();
      }
      this.refCount++;
      this.subscribe(domain, scope, lastBlock);
      const sub = this.subject.pipe(
        filter((msg) => {
          if (msg.type === "error") {
            subscriber.error(new Error(msg.message));
            return false;
          }
          if ("domain" in msg && msg.domain === domain) return true;
          return false;
        }),
        share()
      ).subscribe({
        next: (msg) => {
          const key = this.subscriptionKey(domain, scope);
          const existing = this.subscriptions.get(key);
          if (existing && msg.blockNumber > (existing.lastBlock ?? -1)) {
            existing.lastBlock = msg.blockNumber;
          }
          if (msg.type === "snapshot") {
            subscriber.next({ domain: msg.domain, blockNumber: msg.blockNumber, entities: msg.entities });
          } else if (msg.type === "snapshotPage") {
            subscriber.next({
              domain: msg.domain,
              blockNumber: msg.blockNumber,
              entities: msg.entities,
              nextCursor: msg.nextCursor,
              hasMore: msg.hasMore
            });
          } else if (msg.type === "snapshotComplete") {
            subscriber.next({ domain: msg.domain, blockNumber: msg.blockNumber });
          } else if (msg.type === "stateChange") {
            subscriber.next({ domain: msg.domain, blockNumber: msg.blockNumber, changes: msg.changes });
          }
        },
        error: (err) => subscriber.error(err)
      });
      return () => {
        sub.unsubscribe();
        this.unsubscribe(domain, scope);
        this.refCount--;
        if (this.refCount <= 0) {
          this.refCount = 0;
          this.connection.close();
        }
      };
    });
    if (!scope && domain === "account") {
      return new CursorPaginatedObservable(
        observable,
        domain,
        (data) => this.connection.send(data)
      );
    }
    return observable;
  }
  subscriptionKey(domain, scope) {
    if (scope) {
      return `${domain}:scoped:${JSON.stringify([...scope.addresses].sort())}`;
    }
    return domain;
  }
  subscribe(domain, scope, lastBlock) {
    const key = this.subscriptionKey(domain, scope);
    if (this.subscriptions.has(key)) return;
    const msg = { type: "subscribe", domain };
    if (scope) msg.scope = scope;
    if (lastBlock !== void 0) msg.lastBlock = lastBlock;
    this.subscriptions.set(key, { domain, scope, lastBlock });
    this.connection.send(msg);
  }
  unsubscribe(domain, scope) {
    const key = this.subscriptionKey(domain, scope);
    if (!this.subscriptions.has(key)) return;
    this.subscriptions.delete(key);
    this.connection.send({ type: "unsubscribe", domain });
  }
  resubscribeAll() {
    for (const [, sub] of this.subscriptions) {
      const msg = { type: "subscribe", domain: sub.domain };
      if (sub.scope) msg.scope = sub.scope;
      if (sub.lastBlock !== void 0) msg.lastBlock = sub.lastBlock;
      this.connection.send(msg);
    }
  }
  destroy() {
    this.subject.complete();
    this.subscriptions.clear();
    this.refCount = 0;
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
    blocks: true,
    stateWatch: true
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
    if (options.stateWatch !== void 0) this.config.ws.stateWatch = options.stateWatch;
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

// src/governance.ts
var GOVERNANCE_CONTRACT = "0x0000000000000000000000000000000000000004";
var GOVERNANCE_ABI = ["function governance(string operation, string payload)"];
function governanceArguments(operation, command) {
  return [operation, JSON.stringify(command)];
}
export {
  GOVERNANCE_ABI,
  GOVERNANCE_CONTRACT,
  GrphClient,
  GrphClientBuilder,
  GrphRestClient,
  GrphRpcClient,
  GrphWsClient,
  defaultConfig,
  governanceArguments
};
//# sourceMappingURL=index.js.map
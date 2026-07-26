# graphene-node

Node.js deployment monorepo for Graphene network nodes. Docker Compose-based, with the `@grph/evm-client` SDK for typed access to app-evm's REST, JSON-RPC, and WebSocket endpoints.

## Language

### grph-client

**GrphClient**:
The single entry-point class of the `@grph/evm-client` SDK. Configured via a builder pattern, exposes `.rest`, `.rpc`, and `.ws` sub-objects for interacting with an app-evm instance.
_Avoid_: evmClient, grapheneClient, appEvmClient

**app-evm**:
The Quarkus blockchain relay and indexer service (port 3003, root `/graphene-evm`). The remote service that `GrphClient` connects to. Exposes REST state queries, Ethereum JSON-RPC, and WebSocket endpoints.
_Avoid_: evm node, rpc node, indexer

### WebSocket Endpoints

**Tx Watch WebSocket**:
Server endpoint at `/graphene/tx-watch`. Clients send a `{ txHash, domain }` message to watch a transaction's on-chain finality. The server responds with `ready`, `timeout`, or `error` message types.
_Avoid_: transaction watcher, tx monitor

**Block Event WebSocket**:
Server endpoint at `/graphene/ws/blocks`. Broadcasts `{ type: "newBlock", block: {...} }` messages to all connected clients on each new Tendermint block. Newly added as part of the SDK project.
_Avoid_: block stream, new block socket

**State Watch WebSocket**:
Server endpoint at `/graphene/ws/state-watch`. Supports dynamic `subscribe`/`unsubscribe` messages per sync domain. For Bounded Sync Domains (Stake, Token, Config, etc.), subscribe sends a full atomic `snapshot` then streams per-block `stateChange` events. For the Unbounded Sync Domain (Account), subscribe supports an optional `scope` (address list) to filter entities, or cursor-paginated `snapshotPage`/`snapshotComplete` messages when unscoped. The SDK exposes this via `GrphWsClient.stateWatch()` with domain-scoped methods that return typed RxJS Observables, all multiplexed over a single shared WebSocket connection.
_Avoid_: state change socket, domain watcher

**State Watch Scope**:
An optional filter on a State Watch subscription that restricts delivery to a specific set of entity addresses. Passed to the domain factory in the SDK (`sw.account(['0xAAA', '0xBBB']).subscribe(...)`). When a scope is present, both the snapshot and subsequent `stateChange` events are filtered to matching entities. Scoped subscriptions receive atomic `snapshot` messages (no pagination needed since result sets are small).
_Avoid_: domain filter, address filter

### SDK Architecture

**REST Layer** (`GrphRestClient`):
Typed HTTP client wrapping all `/graphene/state/*`, `/graphene/state/platform/*`, `/blockchain/*`, and `/graphene/state/sync-status` endpoints. Uses `fetch` internally. One method per endpoint.
_Avoid_: http client, api client

**RPC Layer** (`GrphRpcClient`):
Typed JSON-RPC 2.0 client wrapping `POST /graphene-evm/rpc`. Implements all 21 `eth_*` methods with typed request/response pairs.
_Avoid_: jsonrpc client, web3 client

**WebSocket Layer** (`GrphWsClient`):
Observable-based WebSocket client for tx-watch and block subscriptions. Supports configurable auto-reconnect with exponential backoff.
_Avoid_: ws client, socket client

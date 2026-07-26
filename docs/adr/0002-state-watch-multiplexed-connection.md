# ADR 0002: State Watch Multiplexed Connection

**Status:** accepted

## Context

The `@grph/evm-client` SDK needs a "State Watch" feature — subscribing to per-domain blockchain state changes via WebSocket. The existing WebSocket subscription pattern (used by `txWatch()` and `blocks()`) creates one WebSocket connection per subscription call. For State Watch, a client may subscribe to multiple domains (up to 8) simultaneously. Creating 8 independent connections is wasteful and creates unnecessary load on the server.

## Decision

Use a **single shared WebSocket connection with in-connection subscription multiplexing** for all domain state watch subscriptions. The client opens one connection to `/graphene/ws/state-watch` and sends `subscribe`/`unsubscribe` JSON messages to manage domain subscriptions dynamically over that single connection.

### Alternatives considered

1. **One connection per domain** — Matches existing `txWatch()`/`blocks()` pattern. Simpler to implement but wasteful for multi-domain clients. Rejected because the server-side protocol already supports dynamic subscription multiplexing.

2. **Single connection with query parameters** — Client specifies domains at connection time. Cannot change subscriptions without reconnecting. Rejected for lack of flexibility.

3. **Reuse existing `txWatch()` pattern per domain** — Each `stateWatch().stake()` creates an independent connection. Diverges from the chosen dynamic messaging protocol on the server side. Rejected for inconsistency between client and server design.

## Consequences

- **Shared connection requires reference counting** — Connection opens on first subscribe, closes when last domain unsubscribed. Adds complexity to the internal `StateWatchConnection` class.
- **Reconnection requires resubscription** — After a connection drop and successful reconnect, all active domain subscriptions must be replayed to the server. The `StateWatchConnection` tracks subscribed domains and replays them via the `onReconnected` callback.
- **Single error affects all subscriptions** — If the shared connection fails irrecoverably, all domain subscriptions error out. This is acceptable because the underlying WebSocket connection is the failure scope; reconnection handles transient failures.
- **The existing `WsConnection` class gained a `previouslyConnected` flag and `onReconnected` callback** — backwards-compatible additions that benefit future multiplexed subscribers.

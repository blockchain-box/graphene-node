# ADR 0003: Scoped subscriptions for Unbounded Sync Domains

Account is the only Unbounded Sync Domain — its entity population has no practical upper limit. The existing State Watch protocol delivers a full atomic snapshot on subscribe, which is safe for bounded domains (Stake, Config, Token) but breaks down with millions of accounts. We add scoping and cursor pagination to the protocol so clients can subscribe to a subset of accounts or paginate through all accounts, while leaving bounded domains untouched.

## Decisions

1. **Bounded vs Unbounded Sync Domain** — the glossary now distinguishes domains by whether their entity count has a known finite upper bound. Bounded domains keep the existing atomic `snapshot` behavior. The Account domain is the only Unbounded domain.

2. **Scoped subscriptions via address list** — the `subscribe` message gains an optional `scope: { addresses: string[] }` field. When present, both the initial `snapshot` and subsequent `stateChange` messages are filtered to only the scoped addresses. Scoped subscriptions receive atomic `snapshot` messages (result sets are assumed small enough that pagination is unnecessary).

3. **Cursor pagination for unscoped subscriptions** — when subscribing to an Unbounded domain without a scope, the snapshot is delivered as multiple `snapshotPage` messages, each carrying an opaque `nextCursor` string. The client requests each page explicitly via a `nextPage` message. A `snapshotComplete` message marks the end. Cursors are client-managed — the server is stateless between pages.

4. **Scope and cursor are separate modes** — a subscription is either scoped (atomic snapshot, filtered results) or unscoped (cursor-paginated snapshot, unfiltered results). They do not compose.

5. **New protocol messages**: `snapshotPage`, `snapshotComplete`, `nextPage`.

6. **Edge cases**:
   - **Invalid addresses in scope**: silently ignored. The subscription proceeds for valid addresses only. No error is sent.
   - **Scope size cap**: server-enforced maximum (the exact cap is a configuration detail, not a protocol concern). Exceeding it returns an error.
   - **Reconnection resumes from last known block**: on reconnect, subscriptions are replayed with a `lastBlock` field containing the highest block number the client received before disconnect. The server skips the snapshot and resumes `stateChange` from that block. This is a refinement of ADR 0002's connection lifecycle to avoid re-sending known state.

## Considered alternatives

- **Server-managed cursors** — server tracks page state per subscriber. Rejected because it adds session state to the server and complicates reconnection.
- **Hybrid cursor** — server encodes position in the cursor for stateless behavior. Rejected as premature optimization; explicit `nextPage` is simpler to debug and reason about.
- **Dynamic filter updates** — allow changing scope on an existing subscription without unsubscribing. Rejected; the `unsubscribe` + `subscribe` round-trip is cheap enough and keeps the protocol to two verbs plus cursor pagination.
- **Top-N by balance** — subscribe to top N accounts sorted by balance. Rejected; requires the server to maintain a sorted materialized view. Address-based scoping covers explicit interest; cursor pagination covers enumeration. Ranking is a UI concern.
- **Scope applies only to snapshot, not stateChange** — rejected for inconsistency. Scope filters all messages uniformly.

## Consequences

- The SDK's `sw.account()` factory method gains an optional `addresses` parameter. Without it, behavior is cursor-paginated. With it, behavior is scoped.
- The server-side `StateWatchSocket` must filter `DomainSyncEvent` dispatches when a session has a scoped subscription.
- The server must implement cursor generation and cursor-to-offset decoding for paginated snapshots.
- The protocol message union grows from 5 types (snapshot, stateChange, error, subscribe, unsubscribe) to 8 (adds snapshotPage, snapshotComplete, nextPage).
- Existing bounded-domain subscriptions and all `stateChange` handling are unchanged.

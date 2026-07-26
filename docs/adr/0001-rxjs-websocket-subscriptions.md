# ADR 0001: RxJS for WebSocket subscriptions in grph-client

The `@grph/evm-client` SDK uses RxJS Observables for WebSocket subscriptions instead of Node.js EventEmitter or a custom observable interface. We evaluated three options and chose RxJS for its compositional power — it gives consumers a full reactive pipeline (`.pipe()`, `map`, `filter`, `takeUntil`, etc.) without the SDK needing to build that infrastructure. The trade-off is a ~30KB dependency, which is acceptable given that this SDK is consumed in Node.js server contexts where bundle size is not the primary concern.

**Status**: accepted

**Considered Options**:
- Node.js built-in `EventEmitter` — zero dependencies but no composition, no declarative cleanup, no operator pipeline
- Custom minimal observable — zero dependencies with `.subscribe(handler)` pattern, but no operators or ecosystem
- RxJS — full reactive streams, `pipe`, operators, `unsubscribe` cleanup; adds ~30KB

**Consequences**: Consumers get a first-class reactive API. The SDK itself uses RxJS internally for WebSocket reconnection observables. Swapping out RxJS later would break the public API signature.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { firstValueFrom, take, timeout } from 'rxjs';
import { GrphWsClient, CursorPaginatedObservable } from './GrphWsClient.js';

interface MockWebSocket extends WebSocket {
  sentMessages: unknown[];
  triggerMessage(data: unknown): void;
  triggerOpen(): void;
  triggerClose(): void;
}

function createMockWebSocket(): MockWebSocket {
  let onopen: (() => void) | null = null;
  let onclose: (() => void) | null = null;
  let onmessage: ((event: MessageEvent) => void) | null = null;

  const sentMessages: unknown[] = [];

  const mock: MockWebSocket = {
    sentMessages,
    readyState: 0,
    url: '',
    protocol: '',
    extensions: '',
    bufferedAmount: 0,
    binaryType: 'blob',
    onopen: null,
    onclose: null,
    onmessage: null,
    onerror: null,
    OPEN: 1,
    CONNECTING: 0,
    CLOSING: 2,
    CLOSED: 3,

    send(data: string) {
      sentMessages.push(JSON.parse(data));
    },

    close() {
      if (onclose) onclose();
    },

    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },

    triggerMessage(data: unknown) {
      if (onmessage) {
        onmessage(new MessageEvent('message', { data: JSON.stringify(data) }));
      }
    },

    triggerOpen() {
      (this as { readyState: number }).readyState = 1;
      if (onopen) onopen();
    },

    triggerClose() {
      if (onclose) onclose();
    },
  };

  Object.defineProperty(mock, 'onopen', {
    get() { return onopen; },
    set(fn) { onopen = fn; },
  });
  Object.defineProperty(mock, 'onclose', {
    get() { return onclose; },
    set(fn) { onclose = fn; },
  });
  Object.defineProperty(mock, 'onmessage', {
    get() { return onmessage; },
    set(fn) { onmessage = fn; },
  });

  return mock;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('GrphWsClient scoped state watch', () => {
  let wsClient: GrphWsClient;
  let mockWs: MockWebSocket;
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket;
    mockWs = createMockWebSocket();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    g.WebSocket = function () {
      return mockWs;
    };
    g.WebSocket.OPEN = 1;
    g.WebSocket.CONNECTING = 0;
    g.WebSocket.CLOSING = 2;
    g.WebSocket.CLOSED = 3;

    wsClient = new GrphWsClient('http://localhost:3003/graphene-evm', {
      baseUrl: 'http://localhost:3003/graphene-evm',
      rpc: true,
      ws: { txWatch: false, blocks: false, stateWatch: true },
      reconnect: { enabled: false, maxRetries: 0, baseDelayMs: 100, maxDelayMs: 1000 },
    });
  });

  afterEach(() => {
    wsClient.close();
    globalThis.WebSocket = originalWebSocket;
  });

  describe('scoped account subscription', () => {
    it('sends subscribe with scope when addresses provided', async () => {
      const sw = wsClient.stateWatch();
      const obs = sw.account(['0xAAA', '0xBBB']);

      const sub = obs.subscribe({ next: () => {} });
      mockWs.triggerOpen();

      assert.equal(mockWs.sentMessages.length, 1);
      assert.deepStrictEqual(mockWs.sentMessages[0], {
        type: 'subscribe',
        domain: 'account',
        scope: { addresses: ['0xAAA', '0xBBB'] },
      });

      sub.unsubscribe();
    });

    it('sends subscribe without scope when no addresses provided', async () => {
      const sw = wsClient.stateWatch();
      const obs = sw.account();

      const sub = obs.subscribe({ next: () => {} });
      mockWs.triggerOpen();

      assert.equal(mockWs.sentMessages.length, 1);
      assert.deepStrictEqual(mockWs.sentMessages[0], {
        type: 'subscribe',
        domain: 'account',
      });
      assert.equal((mockWs.sentMessages[0] as Record<string, unknown>).scope, undefined);

      sub.unsubscribe();
    });

    it('sends subscribe with single address in scope', async () => {
      const sw = wsClient.stateWatch();
      const obs = sw.account(['0xCCC']);

      const sub = obs.subscribe({ next: () => {} });
      mockWs.triggerOpen();

      assert.deepStrictEqual(mockWs.sentMessages[0], {
        type: 'subscribe',
        domain: 'account',
        scope: { addresses: ['0xCCC'] },
      });

      sub.unsubscribe();
    });

    it('deduplicates scoped subscriptions with same addresses', async () => {
      const sw = wsClient.stateWatch();

      const sub1 = sw.account(['0xAAA', '0xBBB']).subscribe({ next: () => {} });
      mockWs.triggerOpen();
      assert.equal(mockWs.sentMessages.length, 1);

      const sub2 = sw.account(['0xAAA', '0xBBB']).subscribe({ next: () => {} });
      assert.equal(mockWs.sentMessages.length, 1);

      sub1.unsubscribe();
      sub2.unsubscribe();
    });
  });

  describe('unscoped / bounded domain subscription', () => {
    it('stake subscription sends unchanged subscribe without scope', async () => {
      const sw = wsClient.stateWatch();
      const obs = sw.stake();

      const sub = obs.subscribe({ next: () => {} });
      mockWs.triggerOpen();

      assert.equal(mockWs.sentMessages.length, 1);
      assert.deepStrictEqual(mockWs.sentMessages[0], {
        type: 'subscribe',
        domain: 'stake',
      });
      assert.equal((mockWs.sentMessages[0] as Record<string, unknown>).scope, undefined);

      sub.unsubscribe();
    });

    it('token subscription sends unchanged subscribe', async () => {
      const sw = wsClient.stateWatch();
      const obs = sw.token();

      const sub = obs.subscribe({ next: () => {} });
      mockWs.triggerOpen();

      assert.deepStrictEqual(mockWs.sentMessages[0], {
        type: 'subscribe',
        domain: 'token',
      });

      sub.unsubscribe();
    });
  });

  describe('unsubscribe', () => {
    it('sends unsubscribe after scoped subscription teardown', async () => {
      const sw = wsClient.stateWatch();
      const obs = sw.account(['0xAAA']);

      const sub = obs.subscribe({ next: () => {} });
      mockWs.triggerOpen();

      assert.equal(mockWs.sentMessages.length, 1);
      assert.deepStrictEqual((mockWs.sentMessages[0] as { type: string }).type, 'subscribe');

      sub.unsubscribe();
      await wait(10);

      const unsubMsg = mockWs.sentMessages[mockWs.sentMessages.length - 1];
      assert.deepStrictEqual(unsubMsg, {
        type: 'unsubscribe',
        domain: 'account',
      });
    });

    it('sends unsubscribe after unscoped subscription teardown', async () => {
      const sw = wsClient.stateWatch();
      const obs = sw.account();

      const sub = obs.subscribe({ next: () => {} });
      mockWs.triggerOpen();
      assert.equal(mockWs.sentMessages.length, 1);

      sub.unsubscribe();
      await wait(10);

      const last = mockWs.sentMessages[mockWs.sentMessages.length - 1];
      assert.deepStrictEqual(last, { type: 'unsubscribe', domain: 'account' });
    });
  });

  describe('message delivery', () => {
    it('delivers scoped snapshot to subscriber', async () => {
      const sw = wsClient.stateWatch();
      const obs = sw.account(['0xAAA']);

      const received: unknown[] = [];
      const sub = obs.subscribe({ next: (msg) => received.push(msg) });
      mockWs.triggerOpen();

      mockWs.triggerMessage({
        type: 'snapshot',
        domain: 'account',
        blockNumber: 42,
        entities: [{ kind: 'account', uid: '0xAAA', entity: { balance: '100' } }],
      });

      assert.equal(received.length, 1);
      assert.deepStrictEqual(received[0], {
        domain: 'account',
        blockNumber: 42,
        entities: [{ kind: 'account', uid: '0xAAA', entity: { balance: '100' } }],
      });

      sub.unsubscribe();
    });

    it('delivers scoped stateChange to subscriber', async () => {
      const sw = wsClient.stateWatch();
      const obs = sw.account(['0xBBB']);

      const received: unknown[] = [];
      const sub = obs.subscribe({ next: (msg) => received.push(msg) });
      mockWs.triggerOpen();

      mockWs.triggerMessage({
        type: 'stateChange',
        domain: 'account',
        blockNumber: 43,
        changes: [{ kind: 'account', uid: '0xBBB', action: 'UPSERT', entity: { balance: '200' } }],
      });

      assert.equal(received.length, 1);
      assert.deepStrictEqual(received[0], {
        domain: 'account',
        blockNumber: 43,
        changes: [{ kind: 'account', uid: '0xBBB', action: 'UPSERT', entity: { balance: '200' } }],
      });

      sub.unsubscribe();
    });

    it('filters messages by domain', async () => {
      const sw = wsClient.stateWatch();

      const receivedStake: unknown[] = [];
      const receivedAccount: unknown[] = [];

      const sub1 = sw.stake().subscribe({ next: (msg) => receivedStake.push(msg) });
      const sub2 = sw.account(['0xAAA']).subscribe({ next: (msg) => receivedAccount.push(msg) });
      mockWs.triggerOpen();

      mockWs.triggerMessage({
        type: 'snapshot',
        domain: 'stake',
        blockNumber: 1,
        entities: [{ kind: 'validator', uid: '0xV', entity: {} }],
      });

      mockWs.triggerMessage({
        type: 'snapshot',
        domain: 'account',
        blockNumber: 2,
        entities: [{ kind: 'account', uid: '0xAAA', entity: {} }],
      });

      assert.equal(receivedStake.length, 1);
      assert.equal(receivedAccount.length, 1);
      assert.deepStrictEqual((receivedStake[0] as Record<string, unknown>).domain, 'stake');
      assert.deepStrictEqual((receivedAccount[0] as Record<string, unknown>).domain, 'account');

      sub1.unsubscribe();
      sub2.unsubscribe();
    });
  });

  describe('cursor pagination for unscoped account', () => {
    it('returns CursorPaginatedObservable for unscoped account()', () => {
      const sw = wsClient.stateWatch();
      const result = sw.account();
      assert.ok(result instanceof CursorPaginatedObservable);
    });

    it('returns Observable for scoped account()', () => {
      const sw = wsClient.stateWatch();
      const result = sw.account(['0xAAA']);
      assert.ok(!(result instanceof CursorPaginatedObservable));
    });

    it('delivers snapshotPage as Observable emission', () => {
      const sw = wsClient.stateWatch();
      const account$ = sw.account() as CursorPaginatedObservable<Record<string, unknown>>;

      const received: unknown[] = [];
      const sub = account$.subscribe({ next: (msg) => received.push(msg) });
      mockWs.triggerOpen();

      mockWs.triggerMessage({
        type: 'snapshotPage',
        domain: 'account',
        blockNumber: 100,
        entities: [
          { kind: 'account', uid: '0x111', entity: { balance: '100' } },
          { kind: 'account', uid: '0x222', entity: { balance: '200' } },
        ],
        nextCursor: 'cursor-abc',
        hasMore: true,
      });

      assert.equal(received.length, 1);
      const msg = received[0] as Record<string, unknown>;
      assert.equal(msg.domain, 'account');
      assert.equal(msg.blockNumber, 100);
      assert.equal((msg.entities as unknown[]).length, 2);
      assert.equal(msg.nextCursor, 'cursor-abc');
      assert.equal(msg.hasMore, true);

      sub.unsubscribe();
    });

    it('requestNextPage sends correct wire message', () => {
      const sw = wsClient.stateWatch();
      const account$ = sw.account() as CursorPaginatedObservable<Record<string, unknown>>;
      const sub = account$.subscribe({ next: () => {} });
      mockWs.triggerOpen();

      account$.requestNextPage('cursor-42');

      // First message is subscribe, second is nextPage
      assert.equal(mockWs.sentMessages.length, 2);
      const nextPageMsg = mockWs.sentMessages[1] as Record<string, unknown>;
      assert.deepStrictEqual(nextPageMsg, {
        type: 'nextPage',
        domain: 'account',
        cursor: 'cursor-42',
      });

      sub.unsubscribe();
    });

    it('snapshotComplete is delivered and stateChange still works after', () => {
      const sw = wsClient.stateWatch();
      const account$ = sw.account() as CursorPaginatedObservable<Record<string, unknown>>;

      const received: unknown[] = [];
      const sub = account$.subscribe({ next: (msg) => received.push(msg) });
      mockWs.triggerOpen();

      mockWs.triggerMessage({
        type: 'snapshotPage',
        domain: 'account',
        blockNumber: 50,
        entities: [{ kind: 'account', uid: '0xAAA', entity: {} }],
        nextCursor: 'last',
        hasMore: false,
      });

      mockWs.triggerMessage({
        type: 'snapshotComplete',
        domain: 'account',
        blockNumber: 50,
      });

      mockWs.triggerMessage({
        type: 'stateChange',
        domain: 'account',
        blockNumber: 51,
        changes: [{ kind: 'account', uid: '0xAAA', action: 'UPSERT', entity: { balance: '500' } }],
      });

      assert.equal(received.length, 3);

      const pageMsg = received[0] as Record<string, unknown>;
      assert.ok('entities' in pageMsg);
      assert.ok('nextCursor' in pageMsg);

      const completeMsg = received[1] as Record<string, unknown>;
      assert.equal(completeMsg.domain, 'account');
      assert.equal(completeMsg.blockNumber, 50);

      const changeMsg = received[2] as Record<string, unknown>;
      assert.equal(changeMsg.domain, 'account');
      assert.equal(changeMsg.blockNumber, 51);
      assert.ok('changes' in changeMsg);

      sub.unsubscribe();
    });

    it('multi-page flow end-to-end', () => {
      const sw = wsClient.stateWatch();
      const account$ = sw.account() as CursorPaginatedObservable<Record<string, unknown>>;

      const received: unknown[] = [];
      const sub = account$.subscribe({ next: (msg) => received.push(msg) });
      mockWs.triggerOpen();

      // verify subscribe sent without scope
      const subMsg = mockWs.sentMessages[0] as Record<string, unknown>;
      assert.equal(subMsg.type, 'subscribe');
      assert.equal(subMsg.domain, 'account');
      assert.equal(subMsg.scope, undefined);

      // Page 1
      mockWs.triggerMessage({
        type: 'snapshotPage',
        domain: 'account',
        blockNumber: 100,
        entities: [{ kind: 'account', uid: '0xAAA', entity: { balance: '10' } }],
        nextCursor: 'page-1-cursor',
        hasMore: true,
      });

      assert.equal(received.length, 1);
      const page1 = received[0] as Record<string, unknown>;
      assert.equal(page1.nextCursor, 'page-1-cursor');
      assert.equal(page1.hasMore, true);

      // Request page 2
      account$.requestNextPage('page-1-cursor');
      assert.equal(mockWs.sentMessages.length, 2);
      assert.deepStrictEqual(mockWs.sentMessages[1], {
        type: 'nextPage',
        domain: 'account',
        cursor: 'page-1-cursor',
      });

      // Page 2
      mockWs.triggerMessage({
        type: 'snapshotPage',
        domain: 'account',
        blockNumber: 100,
        entities: [{ kind: 'account', uid: '0xBBB', entity: { balance: '20' } }],
        nextCursor: 'page-2-cursor',
        hasMore: true,
      });

      assert.equal(received.length, 2);

      // Request page 3
      account$.requestNextPage('page-2-cursor');
      assert.equal(mockWs.sentMessages.length, 3);

      // Page 3 (last)
      mockWs.triggerMessage({
        type: 'snapshotPage',
        domain: 'account',
        blockNumber: 100,
        entities: [{ kind: 'account', uid: '0xCCC', entity: { balance: '30' } }],
        nextCursor: 'final',
        hasMore: false,
      });

      assert.equal(received.length, 3);

      // Complete
      mockWs.triggerMessage({
        type: 'snapshotComplete',
        domain: 'account',
        blockNumber: 100,
      });

      assert.equal(received.length, 4);
      const complete = received[3] as Record<string, unknown>;
      assert.equal(complete.domain, 'account');
      assert.equal(complete.blockNumber, 100);

      // State change after snapshot
      mockWs.triggerMessage({
        type: 'stateChange',
        domain: 'account',
        blockNumber: 101,
        changes: [{ kind: 'account', uid: '0xAAA', action: 'UPSERT', entity: { balance: '15' } }],
      });

      assert.equal(received.length, 5);
      const change = received[4] as Record<string, unknown>;
      assert.ok('changes' in change);

      // Total: subscribe + 2 nextPage requests
      assert.equal(mockWs.sentMessages.length, 3);

      sub.unsubscribe();
    });

    it('sends unsubscribe when unsubscribing from cursor-paginated subscription', async () => {
      const sw = wsClient.stateWatch();
      const account$ = sw.account() as CursorPaginatedObservable<Record<string, unknown>>;

      const sub = account$.subscribe({ next: () => {} });
      mockWs.triggerOpen();
      assert.equal(mockWs.sentMessages.length, 1);

      sub.unsubscribe();
      await wait(10);

      const last = mockWs.sentMessages[mockWs.sentMessages.length - 1] as Record<string, unknown>;
      assert.deepStrictEqual(last, { type: 'unsubscribe', domain: 'account' });
    });
  });
});

describe('GrphWsClient reconnection resume', () => {
  let wsClient: GrphWsClient;
  let mockWs: MockWebSocket;
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket;
    mockWs = createMockWebSocket();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    g.WebSocket = function () {
      return mockWs;
    };
    g.WebSocket.OPEN = 1;
    g.WebSocket.CONNECTING = 0;
    g.WebSocket.CLOSING = 2;
    g.WebSocket.CLOSED = 3;

    wsClient = new GrphWsClient('http://localhost:3003/graphene-evm', {
      baseUrl: 'http://localhost:3003/graphene-evm',
      rpc: true,
      ws: { txWatch: false, blocks: false, stateWatch: true },
      reconnect: { enabled: true, maxRetries: 10, baseDelayMs: 10, maxDelayMs: 1000 },
    });
  });

  afterEach(() => {
    wsClient.close();
    globalThis.WebSocket = originalWebSocket;
  });

  it('includes lastBlock in resent subscribe after receiving stateChange', async () => {
    const sw = wsClient.stateWatch();
    const obs = sw.account(['0xAAA']);

    const received: unknown[] = [];
    const sub = obs.subscribe({ next: (msg) => received.push(msg) });
    mockWs.triggerOpen();

    assert.equal(mockWs.sentMessages.length, 1);
    assert.deepStrictEqual(mockWs.sentMessages[0], {
      type: 'subscribe',
      domain: 'account',
      scope: { addresses: ['0xAAA'] },
    });

    mockWs.triggerMessage({
      type: 'stateChange',
      domain: 'account',
      blockNumber: 42,
      changes: [{ kind: 'account', uid: '0xAAA', action: 'UPSERT', entity: { balance: '100' } }],
    });

    assert.equal(received.length, 1);

    mockWs.triggerClose();
    await wait(50);
    mockWs.triggerOpen();

    const resent = mockWs.sentMessages[mockWs.sentMessages.length - 1] as Record<string, unknown>;
    assert.deepStrictEqual(resent, {
      type: 'subscribe',
      domain: 'account',
      scope: { addresses: ['0xAAA'] },
      lastBlock: 42,
    });

    sub.unsubscribe();
  });

  it('tracks highest blockNumber across message types', async () => {
    const sw = wsClient.stateWatch();
    const obs = sw.account(['0xBBB']);

    const sub = obs.subscribe({ next: () => {} });
    mockWs.triggerOpen();

    mockWs.triggerMessage({
      type: 'snapshot',
      domain: 'account',
      blockNumber: 30,
      entities: [{ kind: 'account', uid: '0xBBB', entity: {} }],
    });

    mockWs.triggerMessage({
      type: 'stateChange',
      domain: 'account',
      blockNumber: 55,
      changes: [{ kind: 'account', uid: '0xBBB', action: 'UPSERT', entity: {} }],
    });

    mockWs.triggerClose();
    await wait(50);
    mockWs.triggerOpen();

    const resent = mockWs.sentMessages[mockWs.sentMessages.length - 1] as Record<string, unknown>;
    assert.equal(resent.type, 'subscribe');
    assert.equal(resent.domain, 'account');
    assert.equal(resent.lastBlock, 55);

    sub.unsubscribe();
  });

  it('includes lastBlock for unscoped subscription on reconnect', async () => {
    const sw = wsClient.stateWatch();
    const obs = sw.stake();

    const sub = obs.subscribe({ next: () => {} });
    mockWs.triggerOpen();

    mockWs.triggerMessage({
      type: 'stateChange',
      domain: 'stake',
      blockNumber: 88,
      changes: [{ kind: 'validator', uid: '0xV', action: 'UPSERT', entity: {} }],
    });

    mockWs.triggerClose();
    await wait(50);
    mockWs.triggerOpen();

    const resent = mockWs.sentMessages[mockWs.sentMessages.length - 1] as Record<string, unknown>;
    assert.deepStrictEqual(resent, {
      type: 'subscribe',
      domain: 'stake',
      lastBlock: 88,
    });

    sub.unsubscribe();
  });

  it('does not include lastBlock in reconnect if no messages received', async () => {
    const sw = wsClient.stateWatch();
    const obs = sw.account(['0xCCC']);

    const sub = obs.subscribe({ next: () => {} });
    mockWs.triggerOpen();

    mockWs.triggerClose();
    await wait(50);
    mockWs.triggerOpen();

    const resent = mockWs.sentMessages[mockWs.sentMessages.length - 1] as Record<string, unknown>;
    assert.equal(resent.type, 'subscribe');
    assert.equal(resent.lastBlock, undefined);

    sub.unsubscribe();
  });
});

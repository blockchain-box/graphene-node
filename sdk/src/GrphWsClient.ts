import { Observable, Subject, Subscription } from 'rxjs';
import { filter, share } from 'rxjs/operators';
import type { GrphClientConfig, TxWatchMessage, TxWatchRequest, NewBlockMessage, StateWatchServerMessage, StateWatchDomainMessage, StateWatchSubscribe, SyncDomain, StateWatchClientMessage } from './types.js';

export class CursorPaginatedObservable<T> {
  constructor(
    private observable: Observable<T>,
    private domain: SyncDomain,
    private send: (data: unknown) => void,
  ) {}

  subscribe(
    observerOrNext?: ((value: T) => void) | { next?: (value: T) => void; error?: (err: Error) => void; complete?: () => void } | null,
    error?: ((err: Error) => void) | null,
    complete?: (() => void) | null,
  ): Subscription {
    return this.observable.subscribe(observerOrNext as Parameters<Observable<T>['subscribe']>[0], error, complete);
  }

  requestNextPage(cursor: string): void {
    this.send({ type: 'nextPage', domain: this.domain, cursor });
  }

  pipe(): Observable<T> {
    return this.observable.pipe();
  }
}

class WsConnection {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private previouslyConnected = false;
  private pendingMessages: unknown[] = [];

  constructor(
    private url: string,
    private onMessage: (data: unknown) => void,
    private onStatus: (status: 'connected' | 'disconnected' | 'reconnecting') => void,
    private reconnectConfig: GrphClientConfig['reconnect'],
    private onReconnected?: () => void,
  ) {}

  connect(): void {
    if (this.destroyed) return;
    try {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.onStatus('connected');
        this.flushPending();
        if (this.previouslyConnected && this.onReconnected) {
          this.onReconnected();
        }
        this.previouslyConnected = true;
      };
      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data as string);
          this.onMessage(data);
        } catch {
          this.onMessage(event.data);
        }
      };
      this.ws.onclose = () => {
        this.onStatus('disconnected');
        this.scheduleReconnect();
      };
      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      this.pendingMessages.push(data);
    }
  }

  private flushPending(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    while (this.pendingMessages.length > 0) {
      this.ws.send(JSON.stringify(this.pendingMessages.shift()));
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || !this.reconnectConfig.enabled) return;
    if (this.reconnectAttempts >= this.reconnectConfig.maxRetries) {
      this.onStatus('disconnected');
      return;
    }
    this.reconnectAttempts++;
    this.onStatus('reconnecting');
    const delay = Math.min(
      this.reconnectConfig.baseDelayMs * Math.pow(2, this.reconnectAttempts - 1),
      this.reconnectConfig.maxDelayMs,
    );
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  close(): void {
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
}

function wsUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/^http/, 'ws') + path;
}

export class GrphWsClient {
  private connections: WsConnection[] = [];
  private stateWatchConn: StateWatchConnection | null = null;

  constructor(
    private baseUrl: string,
    private config: GrphClientConfig,
  ) {}

  txWatch(req: TxWatchRequest): Observable<TxWatchMessage> {
    const path = '/graphene/tx-watch';
    const url = wsUrl(this.baseUrl, path);

    return new Observable<TxWatchMessage>((subscriber) => {
      const conn = new WsConnection(
        url,
        (data) => {
          const msg = data as TxWatchMessage;
          subscriber.next(msg);
          if (msg.type === 'ready' || msg.type === 'timeout' || msg.type === 'error') {
            subscriber.complete();
            conn.close();
          }
        },
        (status) => {
          if (status === 'disconnected') subscriber.error(new Error('WebSocket disconnected'));
        },
        this.config.reconnect,
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

  blocks(): Observable<NewBlockMessage> {
    const path = '/graphene/ws/blocks';
    const url = wsUrl(this.baseUrl, path);

    return new Observable<NewBlockMessage>((subscriber) => {
      const conn = new WsConnection(
        url,
        (data) => subscriber.next(data as NewBlockMessage),
        (status) => {
          if (status === 'disconnected') subscriber.error(new Error('WebSocket disconnected'));
        },
        this.config.reconnect,
      );
      this.connections.push(conn);
      conn.connect();
      return () => {
        conn.close();
        this.connections = this.connections.filter((c) => c !== conn);
      };
    });
  }

  close(): void {
    for (const conn of this.connections) {
      conn.close();
    }
    this.connections = [];
    if (this.stateWatchConn) {
      this.stateWatchConn.destroy();
      this.stateWatchConn = null;
    }
  }

  stateWatch(): {
    account(addresses?: string[]): Observable<StateWatchDomainMessage> | CursorPaginatedObservable<StateWatchDomainMessage>;
    stake(): Observable<StateWatchDomainMessage>;
    token(): Observable<StateWatchDomainMessage>;
    vault(): Observable<StateWatchDomainMessage>;
    config(): Observable<StateWatchDomainMessage>;
    tenant(): Observable<StateWatchDomainMessage>;
    platform(): Observable<StateWatchDomainMessage>;
    attest(): Observable<StateWatchDomainMessage>;
  } {
    if (!this.stateWatchConn) {
      const path = '/graphene/ws/state-watch';
      const url = wsUrl(this.baseUrl, path);
      this.stateWatchConn = new StateWatchConnection(url, this.config.reconnect);
      this.connections.push(this.stateWatchConn.connection);
    }
    return {
      account: (addresses?: string[]) =>
        this.stateWatchConn!.observe('account', addresses ? { addresses } : undefined),
      stake: () => this.stateWatchConn!.observe('stake') as Observable<StateWatchDomainMessage>,
      token: () => this.stateWatchConn!.observe('token') as Observable<StateWatchDomainMessage>,
      vault: () => this.stateWatchConn!.observe('vault') as Observable<StateWatchDomainMessage>,
      config: () => this.stateWatchConn!.observe('config') as Observable<StateWatchDomainMessage>,
      tenant: () => this.stateWatchConn!.observe('tenant') as Observable<StateWatchDomainMessage>,
      platform: () => this.stateWatchConn!.observe('platform') as Observable<StateWatchDomainMessage>,
      attest: () => this.stateWatchConn!.observe('attest') as Observable<StateWatchDomainMessage>,
    };
  }
}

class StateWatchConnection {
  private subject = new Subject<StateWatchServerMessage>();
  private subscriptions = new Map<string, { domain: SyncDomain; scope?: { addresses: string[] }; lastBlock?: number }>();
  private refCount = 0;
  public connection: WsConnection;

  constructor(
    url: string,
    reconnectConfig: GrphClientConfig['reconnect'],
  ) {
    this.connection = new WsConnection(
      url,
      (data) => this.subject.next(data as StateWatchServerMessage),
      () => {},
      reconnectConfig,
      () => this.resubscribeAll(),
    );
  }

  observe(
    domain: SyncDomain,
    scope?: { addresses: string[] },
    lastBlock?: number,
  ): Observable<StateWatchDomainMessage> | CursorPaginatedObservable<StateWatchDomainMessage> {
    const observable = new Observable<StateWatchDomainMessage>((subscriber) => {
      if (this.refCount === 0) {
        this.connection.connect();
      }
      this.refCount++;
      this.subscribe(domain, scope, lastBlock);

      const sub = this.subject
        .pipe(
          filter((msg): msg is Exclude<StateWatchServerMessage, { type: 'error' }> => {
            if (msg.type === 'error') {
              subscriber.error(new Error(msg.message));
              return false;
            }
            if ('domain' in msg && msg.domain === domain) return true;
            return false;
          }),
          share(),
        )
        .subscribe({
          next: (msg) => {
            const key = this.subscriptionKey(domain, scope);
            const existing = this.subscriptions.get(key);
            if (existing && msg.blockNumber > (existing.lastBlock ?? -1)) {
              existing.lastBlock = msg.blockNumber;
            }
            if (msg.type === 'snapshot') {
              subscriber.next({ domain: msg.domain, blockNumber: msg.blockNumber, entities: msg.entities });
            } else if (msg.type === 'snapshotPage') {
              subscriber.next({
                domain: msg.domain,
                blockNumber: msg.blockNumber,
                entities: msg.entities,
                nextCursor: msg.nextCursor,
                hasMore: msg.hasMore,
              });
            } else if (msg.type === 'snapshotComplete') {
              subscriber.next({ domain: msg.domain, blockNumber: msg.blockNumber });
            } else if (msg.type === 'stateChange') {
              subscriber.next({ domain: msg.domain, blockNumber: msg.blockNumber, changes: msg.changes });
            }
          },
          error: (err) => subscriber.error(err),
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

    if (!scope && domain === 'account') {
      return new CursorPaginatedObservable(
        observable,
        domain,
        (data: unknown) => this.connection.send(data),
      );
    }

    return observable;
  }

  private subscriptionKey(domain: SyncDomain, scope?: { addresses: string[] }): string {
    if (scope) {
      return `${domain}:scoped:${JSON.stringify([...scope.addresses].sort())}`;
    }
    return domain;
  }

  private subscribe(domain: SyncDomain, scope?: { addresses: string[] }, lastBlock?: number): void {
    const key = this.subscriptionKey(domain, scope);
    if (this.subscriptions.has(key)) return;

    const msg: StateWatchClientMessage = { type: 'subscribe', domain };
    if (scope) (msg as StateWatchSubscribe).scope = scope;
    if (lastBlock !== undefined) (msg as StateWatchSubscribe).lastBlock = lastBlock;

    this.subscriptions.set(key, { domain, scope, lastBlock });
    this.connection.send(msg);
  }

  private unsubscribe(domain: SyncDomain, scope?: { addresses: string[] }): void {
    const key = this.subscriptionKey(domain, scope);
    if (!this.subscriptions.has(key)) return;
    this.subscriptions.delete(key);
    this.connection.send({ type: 'unsubscribe', domain });
  }

  private resubscribeAll(): void {
    for (const [, sub] of this.subscriptions) {
      const msg: StateWatchSubscribe = { type: 'subscribe', domain: sub.domain };
      if (sub.scope) msg.scope = sub.scope;
      if (sub.lastBlock !== undefined) msg.lastBlock = sub.lastBlock;
      this.connection.send(msg);
    }
  }

  destroy(): void {
    this.subject.complete();
    this.subscriptions.clear();
    this.refCount = 0;
  }
}

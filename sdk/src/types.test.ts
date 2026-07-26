import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type {
  StateWatchSubscribe,
  StateWatchNextPage,
  StateWatchSnapshotPage,
  StateWatchSnapshotComplete,
  StateWatchClientMessage,
  StateWatchServerMessage,
  StateWatchDomainMessage,
} from './types.js';

describe('StateWatch protocol types', () => {
  describe('StateWatchSubscribe', () => {
    it('serialises with scope field present', () => {
      const msg: StateWatchSubscribe = {
        type: 'subscribe',
        domain: 'stake',
        scope: { addresses: ['0xaaa', '0xbbb'] },
      };

      const json = JSON.stringify(msg);
      const parsed = JSON.parse(json);

      assert.equal(parsed.type, 'subscribe');
      assert.equal(parsed.domain, 'stake');
      assert.deepStrictEqual(parsed.scope, { addresses: ['0xaaa', '0xbbb'] });
      assert.equal(parsed.lastBlock, undefined);
    });

    it('serialises unscoped subscribe without scope field', () => {
      const msg: StateWatchSubscribe = {
        type: 'subscribe',
        domain: 'token',
      };

      const json = JSON.stringify(msg);
      const parsed = JSON.parse(json);

      assert.equal(parsed.type, 'subscribe');
      assert.equal(parsed.domain, 'token');
      assert.equal(parsed.scope, undefined);
      assert.equal(parsed.lastBlock, undefined);
    });

    it('serialises with lastBlock field', () => {
      const msg: StateWatchSubscribe = {
        type: 'subscribe',
        domain: 'account',
        lastBlock: 4200,
      };

      const json = JSON.stringify(msg);
      const parsed = JSON.parse(json);

      assert.equal(parsed.type, 'subscribe');
      assert.equal(parsed.domain, 'account');
      assert.equal(parsed.lastBlock, 4200);
      assert.equal(parsed.scope, undefined);
    });

    it('round-trips with both scope and lastBlock', () => {
      const msg: StateWatchSubscribe = {
        type: 'subscribe',
        domain: 'vault',
        scope: { addresses: ['0xccc'] },
        lastBlock: 99,
      };

      const json = JSON.stringify(msg);
      const parsed: StateWatchSubscribe = JSON.parse(json);

      assert.equal(parsed.type, 'subscribe');
      assert.equal(parsed.domain, 'vault');
      assert.deepStrictEqual(parsed.scope, { addresses: ['0xccc'] });
      assert.equal(parsed.lastBlock, 99);
    });
  });

  describe('StateWatchNextPage', () => {
    it('serialises correctly', () => {
      const msg: StateWatchNextPage = {
        type: 'nextPage',
        domain: 'stake',
        cursor: 'eyJvZmZzZXQiOjEwMH0=',
      };

      const json = JSON.stringify(msg);
      const parsed = JSON.parse(json);

      assert.equal(parsed.type, 'nextPage');
      assert.equal(parsed.domain, 'stake');
      assert.equal(parsed.cursor, 'eyJvZmZzZXQiOjEwMH0=');
    });

    it('round-trips through JSON', () => {
      const msg: StateWatchNextPage = {
        type: 'nextPage',
        domain: 'tenant',
        cursor: 'page-2',
      };

      const json = JSON.stringify(msg);
      const parsed: StateWatchNextPage = JSON.parse(json);

      assert.equal(parsed.type, 'nextPage');
      assert.equal(parsed.domain, 'tenant');
      assert.equal(parsed.cursor, 'page-2');
    });
  });

  describe('StateWatchSnapshotPage', () => {
    it('serialises with correct fields', () => {
      const msg: StateWatchSnapshotPage = {
        type: 'snapshotPage',
        domain: 'account',
        blockNumber: 5000,
        entities: [
          { kind: 'account', uid: '0xabc', entity: { balance: '100' } },
        ],
        nextCursor: 'cursor-42',
        hasMore: true,
      };

      const json = JSON.stringify(msg);
      const parsed = JSON.parse(json);

      assert.equal(parsed.type, 'snapshotPage');
      assert.equal(parsed.domain, 'account');
      assert.equal(parsed.blockNumber, 5000);
      assert.equal(parsed.entities.length, 1);
      assert.equal(parsed.entities[0].kind, 'account');
      assert.equal(parsed.entities[0].uid, '0xabc');
      assert.equal(parsed.nextCursor, 'cursor-42');
      assert.equal(parsed.hasMore, true);
    });

    it('round-trips with hasMore: false', () => {
      const msg: StateWatchSnapshotPage = {
        type: 'snapshotPage',
        domain: 'stake',
        blockNumber: 99,
        entities: [],
        nextCursor: 'final',
        hasMore: false,
      };

      const json = JSON.stringify(msg);
      const parsed: StateWatchSnapshotPage = JSON.parse(json);

      assert.equal(parsed.type, 'snapshotPage');
      assert.equal(parsed.domain, 'stake');
      assert.equal(parsed.blockNumber, 99);
      assert.deepStrictEqual(parsed.entities, []);
      assert.equal(parsed.nextCursor, 'final');
      assert.equal(parsed.hasMore, false);
    });
  });

  describe('StateWatchSnapshotComplete', () => {
    it('serialises with correct fields', () => {
      const msg: StateWatchSnapshotComplete = {
        type: 'snapshotComplete',
        domain: 'stake',
        blockNumber: 5000,
      };

      const json = JSON.stringify(msg);
      const parsed = JSON.parse(json);

      assert.equal(parsed.type, 'snapshotComplete');
      assert.equal(parsed.domain, 'stake');
      assert.equal(parsed.blockNumber, 5000);
    });

    it('round-trips through JSON', () => {
      const msg: StateWatchSnapshotComplete = {
        type: 'snapshotComplete',
        domain: 'config',
        blockNumber: 1,
      };

      const json = JSON.stringify(msg);
      const parsed: StateWatchSnapshotComplete = JSON.parse(json);

      assert.equal(parsed.type, 'snapshotComplete');
      assert.equal(parsed.domain, 'config');
      assert.equal(parsed.blockNumber, 1);
    });
  });

  describe('StateWatchClientMessage union', () => {
    it('accepts StateWatchNextPage', () => {
      const msg: StateWatchClientMessage = {
        type: 'nextPage',
        domain: 'stake',
        cursor: 'abc',
      };

      assert.equal(msg.type, 'nextPage');
    });

    it('accepts StateWatchSubscribe with scope', () => {
      const msg: StateWatchClientMessage = {
        type: 'subscribe',
        domain: 'account',
        scope: { addresses: ['0xddd'] },
        lastBlock: 10,
      };

      assert.equal(msg.type, 'subscribe');
      assert.deepStrictEqual(msg.scope, { addresses: ['0xddd'] });
      assert.equal(msg.lastBlock, 10);
    });
  });

  describe('StateWatchServerMessage union', () => {
    it('accepts StateWatchSnapshotPage', () => {
      const msg: StateWatchServerMessage = {
        type: 'snapshotPage',
        domain: 'token',
        blockNumber: 100,
        entities: [],
        nextCursor: 'c1',
        hasMore: true,
      };

      assert.equal(msg.type, 'snapshotPage');
    });

    it('accepts StateWatchSnapshotComplete', () => {
      const msg: StateWatchServerMessage = {
        type: 'snapshotComplete',
        domain: 'token',
        blockNumber: 100,
      };

      assert.equal(msg.type, 'snapshotComplete');
    });
  });

  describe('StateWatchDomainMessage union', () => {
    it('omits type from SnapshotPage in domain message', () => {
      const msg: StateWatchDomainMessage = {
        domain: 'stake' as const,
        blockNumber: 200,
        entities: [{ kind: 'validator', uid: '0x123', entity: {} }],
        nextCursor: 'c2',
        hasMore: false,
      };

      assert.equal(msg.domain, 'stake');
      assert.equal(msg.blockNumber, 200);
      assert.equal(msg.hasMore, false);
      assert.equal(msg.nextCursor, 'c2');
      assert.ok(!('type' in msg));
    });

    it('omits type from SnapshotComplete in domain message', () => {
      const msg: StateWatchDomainMessage = {
        domain: 'config' as const,
        blockNumber: 42,
      };

      assert.equal(msg.domain, 'config');
      assert.equal(msg.blockNumber, 42);
      assert.ok(!('type' in msg));
    });
  });
});

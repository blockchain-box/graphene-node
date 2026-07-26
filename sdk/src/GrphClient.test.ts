import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GrphClientBuilder } from './GrphClientBuilder.js';
import { defaultConfig } from './types.js';

describe('GrphClientBuilder', () => {
  it('creates a GrphClient with default configuration', () => {
    const client = GrphClientBuilder.configure().build();
    const config = client.getConfig();

    const defaults = defaultConfig();
    assert.equal(config.baseUrl, defaults.baseUrl);
    assert.equal(config.rpc, defaults.rpc);
    assert.deepStrictEqual(config.ws, defaults.ws);
    assert.deepStrictEqual(config.reconnect, defaults.reconnect);
  });

  it('propagates custom baseUrl', () => {
    const client = GrphClientBuilder.configure()
      .baseUrl('http://example.com:3003/graphene-evm')
      .build();

    assert.equal(client.getConfig().baseUrl, 'http://example.com:3003/graphene-evm');
  });

  it('strips trailing slash from baseUrl', () => {
    const client = GrphClientBuilder.configure()
      .baseUrl('http://example.com:3003/graphene-evm/')
      .build();

    assert.equal(client.getConfig().baseUrl, 'http://example.com:3003/graphene-evm');
  });

  it('propagates rpc flag', () => {
    const client = GrphClientBuilder.configure()
      .rpc(false)
      .build();

    assert.equal(client.getConfig().rpc, false);
  });

  it('propagates ws options', () => {
    const client = GrphClientBuilder.configure()
      .ws({ txWatch: false, blocks: false, stateWatch: true })
      .build();

    assert.deepStrictEqual(client.getConfig().ws, {
      txWatch: false,
      blocks: false,
      stateWatch: true,
    });
  });

  it('propagates reconnect options', () => {
    const client = GrphClientBuilder.configure()
      .reconnect({ enabled: false, maxRetries: 3, baseDelayMs: 500, maxDelayMs: 10000 })
      .build();

    assert.deepStrictEqual(client.getConfig().reconnect, {
      enabled: false,
      maxRetries: 3,
      baseDelayMs: 500,
      maxDelayMs: 10000,
    });
  });

  it('config returned by getConfig is immutable (snapshot)', () => {
    const client = GrphClientBuilder.configure()
      .baseUrl('http://immutable.test:3003')
      .build();

    const mutableConfig = { ...client.getConfig(), baseUrl: 'http://mutated.example.com' };

    assert.equal(mutableConfig.baseUrl, 'http://mutated.example.com');
    assert.equal(client.getConfig().baseUrl, 'http://immutable.test:3003');
  });

  it('builder config is independent across builds', () => {
    const builder = GrphClientBuilder.configure()
      .baseUrl('http://first.example.com');

    const first = builder.build();
    const second = builder.baseUrl('http://second.example.com').build();

    assert.equal(first.getConfig().baseUrl, 'http://first.example.com');
    assert.equal(second.getConfig().baseUrl, 'http://second.example.com');
  });
});

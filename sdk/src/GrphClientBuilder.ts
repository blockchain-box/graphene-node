import { GrphClientConfig, defaultConfig } from './types.js';
import { GrphClient } from './GrphClient.js';

export class GrphClientBuilder {
  private config: GrphClientConfig;

  constructor() {
    this.config = defaultConfig();
  }

  baseUrl(url: string): this {
    this.config.baseUrl = url.replace(/\/$/, '');
    return this;
  }

  rpc(enable: boolean): this {
    this.config.rpc = enable;
    return this;
  }

  ws(options: { txWatch?: boolean; blocks?: boolean; stateWatch?: boolean }): this {
    if (options.txWatch !== undefined) this.config.ws.txWatch = options.txWatch;
    if (options.blocks !== undefined) this.config.ws.blocks = options.blocks;
    if (options.stateWatch !== undefined) this.config.ws.stateWatch = options.stateWatch;
    return this;
  }

  reconnect(options: { enabled?: boolean; maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number }): this {
    if (options.enabled !== undefined) this.config.reconnect.enabled = options.enabled;
    if (options.maxRetries !== undefined) this.config.reconnect.maxRetries = options.maxRetries;
    if (options.baseDelayMs !== undefined) this.config.reconnect.baseDelayMs = options.baseDelayMs;
    if (options.maxDelayMs !== undefined) this.config.reconnect.maxDelayMs = options.maxDelayMs;
    return this;
  }

  build(): GrphClient {
    return new GrphClient({ ...this.config });
  }

  static configure(): GrphClientBuilder {
    return new GrphClientBuilder();
  }
}

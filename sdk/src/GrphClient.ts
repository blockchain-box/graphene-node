import { GrphClientConfig } from './types.js';
import { GrphRestClient } from './GrphRestClient.js';
import { GrphRpcClient } from './GrphRpcClient.js';
import { GrphWsClient } from './GrphWsClient.js';

export class GrphClient {
  readonly rest: GrphRestClient;
  readonly rpc: GrphRpcClient;
  readonly ws: GrphWsClient;

  constructor(private config: GrphClientConfig) {
    this.rest = new GrphRestClient(config.baseUrl);
    this.rpc = new GrphRpcClient(`${config.baseUrl}/rpc`);
    this.ws = new GrphWsClient(config.baseUrl, config);
  }

  getConfig(): Readonly<GrphClientConfig> {
    return { ...this.config };
  }
}

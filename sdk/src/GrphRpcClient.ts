import type { EthereumBlock, EthereumTransaction, EthereumTransactionReceipt, JsonRpcRequest, JsonRpcResponse } from './types.js';

export class GrphRpcClient {
  private idCounter = 1;

  constructor(private rpcUrl: string) {}

  private async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      params,
      id: this.idCounter++,
    };

    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`RPC ${method} failed (${response.status}): ${body}`);
    }

    const text = await response.text();
    if (!text) {
      throw new Error(`RPC ${method} returned empty response (status ${response.status})`);
    }
    const json = JSON.parse(text) as JsonRpcResponse<T>;
    if (json.error) {
      throw new Error(`RPC ${method} error (${json.error.code}): ${json.error.message}`);
    }

    return json.result as T;
  }

  async web3_clientVersion(): Promise<string> {
    return this.call<string>('web3_clientVersion');
  }

  async eth_sha3(data: string): Promise<string> {
    return this.call<string>('eth_sha3', [data]);
  }

  async net_version(): Promise<string> {
    return this.call<string>('net_version');
  }

  async net_peerCount(): Promise<string> {
    return this.call<string>('net_peerCount');
  }

  async net_listening(): Promise<boolean> {
    return this.call<boolean>('net_listening');
  }

  async eth_syncing(): Promise<boolean | object> {
    return this.call<boolean | object>('eth_syncing');
  }

  async eth_mining(): Promise<boolean> {
    return this.call<boolean>('eth_mining');
  }

  async eth_chainId(): Promise<string> {
    return this.call<string>('eth_chainId');
  }

  async eth_blockNumber(): Promise<string> {
    return this.call<string>('eth_blockNumber');
  }

  async eth_getBlockByNumber(blockNumber: string, fullTx: boolean = false): Promise<EthereumBlock | null> {
    return this.call<EthereumBlock | null>('eth_getBlockByNumber', [blockNumber, fullTx]);
  }

  async eth_getBlockByHash(blockHash: string, fullTx: boolean = false): Promise<EthereumBlock | null> {
    return this.call<EthereumBlock | null>('eth_getBlockByHash', [blockHash, fullTx]);
  }

  async eth_sendRawTransaction(data: string): Promise<string> {
    return this.call<string>('eth_sendRawTransaction', [data]);
  }

  async eth_sendRawTransactionBatch(data: string[]): Promise<string[]> {
    return this.call<string[]>('eth_sendRawTransactionBatch', [data]);
  }

  async eth_call(tx: { to?: string; data?: string; from?: string; gas?: string; gasPrice?: string; value?: string }, blockTag: string = 'latest'): Promise<string> {
    return this.call<string>('eth_call', [tx, blockTag]);
  }

  async eth_estimateGas(tx: { to?: string; data?: string; from?: string; value?: string }): Promise<string> {
    return this.call<string>('eth_estimateGas', [tx]);
  }

  async eth_getTransactionByHash(hash: string): Promise<EthereumTransaction | null> {
    return this.call<EthereumTransaction | null>('eth_getTransactionByHash', [hash]);
  }

  async eth_getTransactionReceipt(hash: string): Promise<EthereumTransactionReceipt | null> {
    return this.call<EthereumTransactionReceipt | null>('eth_getTransactionReceipt', [hash]);
  }

  async txpool_content(): Promise<object> {
    return this.call<object>('txpool_content');
  }

  async eth_getCode(address: string, blockTag: string = 'latest'): Promise<string> {
    return this.call<string>('eth_getCode', [address, blockTag]);
  }

  async eth_getTransactionCount(address: string, blockTag: string = 'latest'): Promise<string> {
    return this.call<string>('eth_getTransactionCount', [address, blockTag]);
  }

  async eth_getBalance(address: string, blockTag: string = 'latest'): Promise<string> {
    return this.call<string>('eth_getBalance', [address, blockTag]);
  }

  async eth_gasPrice(): Promise<string> {
    return this.call<string>('eth_gasPrice');
  }

  async eth_maxPriorityFeePerGas(): Promise<string> {
    return this.call<string>('eth_maxPriorityFeePerGas');
  }

  async eth_feeHistory(blockCount: string, newestBlock: string, rewardPercentiles?: number[]): Promise<object> {
    return this.call<object>('eth_feeHistory', [blockCount, newestBlock, rewardPercentiles]);
  }

  async eth_getToken(address: string): Promise<object> {
    return this.call<object>('eth_getToken', [address]);
  }

  async eth_getTokens(): Promise<object[]> {
    return this.call<object[]>('eth_getTokens');
  }
}

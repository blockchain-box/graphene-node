import { ethers } from 'ethers';

// The current native endpoint accepts one call per POST and serializes IDs as
// strings. Preserve ethers' numeric IDs internally without accepting mismatched IDs.
class NativeRpcProvider extends ethers.JsonRpcProvider {
  constructor(url) { super(url, undefined, { batchMaxCount: 1 }); }
  async _send(payload) {
    const responses = await super._send(payload);
    return responses.map((response) => String(response.id) === String(payload.id)
      ? { ...response, id: payload.id }
      : response);
  }
}
export function createRpcProvider(url) { return new NativeRpcProvider(url); }

export const RPC_ENDPOINT = import.meta.env.VITE_RPC_URL || "http://localhost:3003/graphene-evm/rpc";
export const STATE_API_ENDPOINT = import.meta.env.VITE_READ_API || "http://localhost:3003/graphene-evm/graphene/state";
export const TX_WATCH_WS_ENDPOINT = import.meta.env.VITE_WS_URL || "ws://localhost:3003/graphene-evm/graphene/tx-watch";
export const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS || "0x0000000000000000000000000000000000000004";
export const CHAIN_ID = 9876;
export const CHAIN_ID_HEX = "0x2694";
export const CURRENCY_SYMBOL = "GRPH";
export const GRPH_DECIMALS = 1_000_000_000_000_000_000;

function getRpcEndpoint(): string {
  if (typeof window !== "undefined") {
    return localStorage.getItem("validator_dapp_rpc") || RPC_ENDPOINT;
  }
  return RPC_ENDPOINT;
}

function deriveBaseUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "http://localhost:3003";
  }
}

export function getStateApiEndpoint(): string {
  if (typeof window !== "undefined") {
    const custom = localStorage.getItem("validator_dapp_state_api");
    if (custom) return custom;
  }
  return `${deriveBaseUrl(getRpcEndpoint())}/graphene-evm/graphene/state`;
}

export function getTxWatchWsEndpoint(): string {
  if (typeof window !== "undefined") {
    const custom = localStorage.getItem("validator_dapp_ws");
    if (custom) return custom;
  }
  const host = (() => {
    try { return new URL(getRpcEndpoint()).host; } catch { return "localhost:3003"; }
  })();
  return `ws://${host}/graphene-evm/graphene/tx-watch`;
}

export function formatGRPH(wei: bigint): string {
  const num = Number(wei) / GRPH_DECIMALS;
  if (num === 0) return "0";
  if (num < 0.0001) return "< 0.0001";
  return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

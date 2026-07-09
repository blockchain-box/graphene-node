import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { CHAIN_ID_HEX, CHAIN_ID, CURRENCY_SYMBOL, formatGRPH, RPC_ENDPOINT } from "@/config/rpc";

declare global {
  interface Window {
    ethereum?: {
      isMetaMask?: boolean;
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      on: (event: string, callback: (...args: unknown[]) => void) => void;
      removeListener: (event: string, callback: (...args: unknown[]) => void) => void;
    };
  }
}

export interface WalletState {
  isInstalled: boolean;
  isConnecting: boolean;
  address: string | null;
  balance: bigint | null;
  balanceFormatted: string;
  walletChainId: string | null;
  rpcChainId: string | null;
  isCorrectChain: boolean;
}

interface WalletContextType extends WalletState {
  connect: () => Promise<void>;
  disconnect: () => void;
  switchNetwork: () => Promise<void>;
}

const WalletContext = createContext<WalletContextType | undefined>(undefined);
const DISCONNECT_KEY = "validator_dapp_disconnected";

function getRpcEndpoint(): string {
  return localStorage.getItem("validator_dapp_rpc") || RPC_ENDPOINT;
}

function chainsMatch(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  try { return BigInt(a) === BigInt(b); } catch { return false; }
}

async function fetchRpcChainId(): Promise<string | null> {
  try {
    const res = await fetch(getRpcEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
    });
    const data = await res.json();
    return data.result || null;
  } catch { return null; }
}

async function fetchBalance(address: string): Promise<bigint> {
  const res = await fetch(getRpcEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getBalance", params: [address, "latest"], id: 1 }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return BigInt(data.result);
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WalletState>({
    isInstalled: false, isConnecting: false,
    address: null, balance: null, balanceFormatted: "0",
    walletChainId: null, rpcChainId: null, isCorrectChain: false,
  });

  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  const isInstalled = typeof window !== "undefined" && !!window.ethereum?.isMetaMask;

  const getAccounts = useCallback(async (): Promise<string[]> => {
    if (!window.ethereum) return [];
    try { return await window.ethereum.request({ method: "eth_accounts" }) as string[]; } catch { return []; }
  }, []);

  const getWalletChainId = useCallback(async (): Promise<string | null> => {
    if (!window.ethereum) return null;
    try { return await window.ethereum.request({ method: "eth_chainId" }) as string; } catch { return null; }
  }, []);

  const refreshBalance = useCallback(async (addr: string) => {
    try {
      const bal = await fetchBalance(addr);
      if (mountedRef.current) setState(prev => ({ ...prev, balance: bal, balanceFormatted: formatGRPH(bal) }));
    } catch {
      if (mountedRef.current) setState(prev => ({ ...prev, balance: null, balanceFormatted: "0" }));
    }
  }, []);

  const syncAccounts = useCallback(async (accounts: string[]) => {
    if (!mountedRef.current) return;
    const userDisconnected = localStorage.getItem(DISCONNECT_KEY) === "1";
    if (accounts.length === 0 || userDisconnected) {
      setState(prev => ({ ...prev, address: null, balance: null, balanceFormatted: "0" }));
    } else {
      const addr = accounts[0];
      setState(prev => ({ ...prev, address: addr }));
      refreshBalance(addr);
    }
  }, [refreshBalance]);

  const syncChain = useCallback((walletChain: string | null) => {
    if (!mountedRef.current) return;
    setState(prev => ({ ...prev, walletChainId: walletChain, isCorrectChain: chainsMatch(walletChain, prev.rpcChainId) }));
  }, []);

  const fullSync = useCallback(async () => {
    if (!mountedRef.current) return;
    if (!isInstalled) {
      setState(prev => ({ ...prev, isInstalled: false, isConnecting: false, address: null, balance: null, balanceFormatted: "0", walletChainId: null, rpcChainId: null, isCorrectChain: false }));
      return;
    }
    const [walletChain, accounts, rpcChain] = await Promise.all([getWalletChainId(), getAccounts(), fetchRpcChainId()]);
    if (!mountedRef.current) return;
    const userDisconnected = localStorage.getItem(DISCONNECT_KEY) === "1";
    const addr = (!userDisconnected && accounts.length > 0) ? accounts[0] : null;
    setState(prev => ({ ...prev, isInstalled: true, isConnecting: false, address: addr, walletChainId: walletChain, rpcChainId: rpcChain, isCorrectChain: chainsMatch(walletChain, rpcChain) }));
    if (addr) refreshBalance(addr);
  }, [isInstalled, getWalletChainId, getAccounts, refreshBalance]);

  useEffect(() => { fullSync(); }, []);

  useEffect(() => {
    if (!window.ethereum?.on) return;
    const ethereum = window.ethereum;
    const onAccountsChanged = (accounts: unknown) => syncAccounts(accounts as string[]);
    const onChainChanged = (chainId: unknown) => syncChain(chainId as string);
    ethereum.on("accountsChanged", onAccountsChanged);
    ethereum.on("chainChanged", onChainChanged);
    return () => {
      ethereum.removeListener("accountsChanged", onAccountsChanged);
      ethereum.removeListener("chainChanged", onChainChanged);
    };
  }, [syncAccounts, syncChain]);

  const connect = useCallback(async () => {
    if (!window.ethereum) return;
    setState(prev => ({ ...prev, isConnecting: true }));
    try {
      await window.ethereum.request({ method: "eth_requestAccounts" });
      localStorage.removeItem(DISCONNECT_KEY);
      if (!mountedRef.current) return;
      const [walletChain, accounts, rpcChain] = await Promise.all([getWalletChainId(), getAccounts(), fetchRpcChainId()]);
      if (!mountedRef.current) return;
      const addr = accounts.length > 0 ? accounts[0] : null;
      setState(prev => ({ ...prev, isConnecting: false, address: addr, walletChainId: walletChain, rpcChainId: rpcChain, isCorrectChain: chainsMatch(walletChain, rpcChain) }));
      if (addr) refreshBalance(addr);
    } catch {
      if (mountedRef.current) setState(prev => ({ ...prev, isConnecting: false }));
    }
  }, [getWalletChainId, getAccounts, refreshBalance]);

  const disconnect = useCallback(() => {
    localStorage.setItem(DISCONNECT_KEY, "1");
    setState(prev => ({ ...prev, address: null, balance: null, balanceFormatted: "0" }));
  }, []);

  const switchNetwork = useCallback(async () => {
    if (!window.ethereum) return;
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] });
    } catch (switchError: unknown) {
      const err = switchError as { code?: number };
      if (err.code === 4902) {
        try {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: CHAIN_ID_HEX,
              chainName: "Graphene Network",
              nativeCurrency: { name: CURRENCY_SYMBOL, symbol: CURRENCY_SYMBOL, decimals: 18 },
              rpcUrls: [getRpcEndpoint()],
              blockExplorerUrls: [window.location.origin],
            }],
          });
        } catch (addError) { console.error("Failed to add chain:", addError); }
      }
    }
  }, []);

  return (
    <WalletContext.Provider value={{ ...state, connect, disconnect, switchNetwork }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  const context = useContext(WalletContext);
  if (!context) throw new Error("useWallet must be used within a WalletProvider");
  return context;
}

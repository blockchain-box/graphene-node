import { useState } from "react";
import { useWallet } from "@/contexts/WalletContext";
import { truncateAddress } from "@/config/rpc";

export function ConnectWallet() {
  const { isInstalled, isConnecting, address, balanceFormatted, walletChainId, rpcChainId, isCorrectChain, connect, disconnect, switchNetwork } = useWallet();

  if (!isInstalled) {
    return (
      <div className="bg-yellow-900/30 border border-yellow-700 rounded-lg p-4">
        <p className="text-yellow-300">MetaMask is not installed. Please install MetaMask to use this dApp.</p>
      </div>
    );
  }

  if (!address) {
    return (
      <button onClick={connect} disabled={isConnecting} className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-6 py-2 rounded-lg font-medium transition-colors">
        {isConnecting ? "Connecting..." : "Connect MetaMask"}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-4 bg-gray-800 rounded-lg px-4 py-2">
      {!isCorrectChain && walletChainId && rpcChainId && (
        <button onClick={switchNetwork} className="bg-red-600 hover:bg-red-700 text-white px-3 py-1 rounded text-sm transition-colors">
          Switch Network
        </button>
      )}
      <div className="text-right">
        <div className="text-sm font-mono text-gray-300">{truncateAddress(address)}</div>
        <div className="text-xs text-gray-400">{balanceFormatted} GRPH</div>
      </div>
      <button onClick={disconnect} className="text-gray-400 hover:text-white text-sm transition-colors">
        Disconnect
      </button>
    </div>
  );
}

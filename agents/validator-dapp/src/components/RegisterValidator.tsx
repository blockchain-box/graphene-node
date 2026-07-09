import { useState } from "react";
import { useWallet } from "@/contexts/WalletContext";
import { registerValidator } from "@/lib/contract/platform-contract";
import { watchTx } from "@/lib/tx-watch";
import { GRPH_DECIMALS, CHAIN_ID_HEX } from "@/config/rpc";

export function RegisterValidator() {
  const { address, isCorrectChain, switchNetwork } = useWallet();
  const [form, setForm] = useState({ agentAddress: "", nodeId: "", networkPublicKey: "", encryptionPublicKey: "", moniker: "", stakeAmount: "" });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ type: "info" | "success" | "error"; message: string } | null>(null);

  const handleChange = (field: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm(prev => ({ ...prev, [field]: e.target.value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!address || !window.ethereum) return;

    if (!isCorrectChain) {
      await switchNetwork();
      return;
    }

    setBusy(true);
    setStatus({ type: "info", message: "Please confirm the transaction in MetaMask..." });
    try {
      const stakeBigInt = BigInt(Math.floor(parseFloat(form.stakeAmount || "0") * GRPH_DECIMALS));
      const tx = registerValidator(
        form.agentAddress, form.nodeId, form.networkPublicKey,
        form.encryptionPublicKey, form.moniker, stakeBigInt
      );

      const txHash = await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [{ from: address, to: tx.to, data: tx.data, value: tx.value }],
      }) as string;

      setStatus({ type: "info", message: `Transaction submitted: ${txHash.slice(0, 10)}... waiting for confirmation...` });

      watchTx(txHash, "platform", (result) => {
        if (result.type === "ready") {
          setStatus({ type: "success", message: `Validator registered successfully in block ${result.blockNumber}` });
        } else if (result.type === "timeout") {
          setStatus({ type: "error", message: "Transaction confirmation timed out. Check the explorer." });
        } else if (result.type === "error") {
          setStatus({ type: "error", message: result.message || "Transaction failed" });
        }
        setBusy(false);
      });
    } catch (err: unknown) {
      const e = err as { message?: string; code?: number };
      if (e.code === 4001) {
        setStatus({ type: "error", message: "Transaction rejected by user." });
      } else {
        setStatus({ type: "error", message: e.message || "Transaction failed" });
      }
      setBusy(false);
    }
  };

  if (!address) return null;

  return (
    <div className="bg-gray-800 rounded-lg p-6">
      <h2 className="text-xl font-semibold mb-4">Register Validator</h2>
      <p className="text-gray-400 text-sm mb-4">
        Use values from <code className="bg-gray-700 px-1 rounded">validator-agent init</code> output.
        Stake will be locked in the platform contract.
      </p>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="block text-sm text-gray-300 mb-1">Agent Address</label>
          <input value={form.agentAddress} onChange={handleChange("agentAddress")} placeholder="0x..." className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm font-mono" required />
        </div>
        <div>
          <label className="block text-sm text-gray-300 mb-1">Node ID</label>
          <input value={form.nodeId} onChange={handleChange("nodeId")} placeholder="tendermint node ID" className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm font-mono" required />
        </div>
        <div>
          <label className="block text-sm text-gray-300 mb-1">Network Public Key</label>
          <input value={form.networkPublicKey} onChange={handleChange("networkPublicKey")} placeholder="ed25519 pubkey" className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm font-mono" required />
        </div>
        <div>
          <label className="block text-sm text-gray-300 mb-1">Encryption Public Key</label>
          <input value={form.encryptionPublicKey} onChange={handleChange("encryptionPublicKey")} placeholder="X25519 pubkey" className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm font-mono" required />
        </div>
        <div>
          <label className="block text-sm text-gray-300 mb-1">Moniker</label>
          <input value={form.moniker} onChange={handleChange("moniker")} placeholder="My Validator" className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm" required />
        </div>
        <div>
          <label className="block text-sm text-gray-300 mb-1">Stake Amount (GRPH)</label>
          <input value={form.stakeAmount} onChange={handleChange("stakeAmount")} placeholder="1000" type="number" min="0" step="any" className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm" required />
        </div>
        <button type="submit" disabled={busy || !isCorrectChain} className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white px-6 py-2 rounded-lg font-medium transition-colors">
          {!isCorrectChain ? "Wrong Network" : busy ? "Processing..." : "Register Validator"}
        </button>
      </form>
      {status && (
        <div className={`mt-4 p-3 rounded text-sm ${status.type === "success" ? "bg-green-900/30 border border-green-700 text-green-300" : status.type === "error" ? "bg-red-900/30 border border-red-700 text-red-300" : "bg-blue-900/30 border border-blue-700 text-blue-300"}`}>
          {status.message}
        </div>
      )}
    </div>
  );
}

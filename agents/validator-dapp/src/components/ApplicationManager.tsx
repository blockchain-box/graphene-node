import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWallet } from "@/contexts/WalletContext";
import { cancelApplication as cancelApp } from "@/lib/contract/platform-contract";
import { getApplications as getApps } from "@/lib/platform-state";
import { watchTx } from "@/lib/tx-watch";
import { useState } from "react";

export function ApplicationManager() {
  const { address, isCorrectChain, switchNetwork } = useWallet();
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState<{ type: "info" | "success" | "error"; message: string } | null>(null);

  const { data: apps, isLoading } = useQuery({
    queryKey: ["applications", address],
    queryFn: () => getApps(address!),
    refetchInterval: 10000,
    enabled: !!address,
  });

  const handleCancel = async (appId: string) => {
    if (!address || !window.ethereum) return;
    if (!isCorrectChain) { await switchNetwork(); return; }
    setBusyId(appId);
    setStatus({ type: "info", message: `Cancelling application ${appId}...` });
    try {
      const tx = cancelApp(BigInt(appId));
      const txHash = await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [{ from: address, to: tx.to, data: tx.data, value: tx.value }],
      }) as string;

      watchTx(txHash, "platform", (result) => {
        if (result.type === "ready") {
          setStatus({ type: "success", message: `Application ${appId} cancelled.` });
          queryClient.invalidateQueries({ queryKey: ["applications"] });
        } else {
          setStatus({ type: "error", message: result.message || "Cancellation failed" });
        }
        setBusyId(null);
      });
    } catch (err: unknown) {
      const e = err as { message?: string; code?: number };
      if (e.code !== 4001) setStatus({ type: "error", message: e.message || "Failed" });
      setBusyId(null);
    }
  };

  if (!address) return null;

  return (
    <div className="bg-gray-800 rounded-lg p-6">
      <h2 className="text-xl font-semibold mb-4">My Applications</h2>
      {status && (
        <div className={`mb-4 p-3 rounded text-sm ${status.type === "success" ? "bg-green-900/30 border border-green-700 text-green-300" : status.type === "error" ? "bg-red-900/30 border border-red-700 text-red-300" : "bg-blue-900/30 border border-blue-700 text-blue-300"}`}>
          {status.message}
        </div>
      )}
      {isLoading && <p className="text-gray-400">Loading...</p>}
      {apps && apps.length === 0 && <p className="text-gray-400">No applications yet.</p>}
      <div className="space-y-2">
        {apps?.map((a) => (
          <div key={a.id} className="flex items-center justify-between bg-gray-900 rounded p-3">
            <div>
              <div className="text-sm font-medium">Application #{a.id}</div>
              <div className="text-xs text-gray-400">Sentry: {a.sentryId.slice(0, 12)}... &middot; Status: <span className={a.status === "Pending" ? "text-yellow-400" : a.status === "Approved" ? "text-green-400" : "text-red-400"}>{a.status}</span></div>
            </div>
            {a.status === "Pending" && (
              <button
                onClick={() => handleCancel(a.id)}
                disabled={busyId === a.id}
                className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-3 py-1 rounded text-sm transition-colors"
              >
                {busyId === a.id ? "..." : "Cancel"}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

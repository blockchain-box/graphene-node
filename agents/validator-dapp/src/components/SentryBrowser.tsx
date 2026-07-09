import { useQuery } from "@tanstack/react-query";
import { useWallet } from "@/contexts/WalletContext";
import { applyToSentry } from "@/lib/contract/platform-contract";
import { getSentries, getValidator, getApplications as getApps } from "@/lib/platform-state";
import { watchTx } from "@/lib/tx-watch";
import { useState } from "react";
import type { SentryDTO } from "@/lib/platform-state";

export function SentryBrowser() {
  const { address, isCorrectChain, switchNetwork } = useWallet();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState<{ type: "info" | "success" | "error"; message: string } | null>(null);

  const sentriesQuery = useQuery({
    queryKey: ["sentries"],
    queryFn: getSentries,
    refetchInterval: 15000,
    enabled: !!address,
  });

  const validatorQuery = useQuery({
    queryKey: ["validator", address],
    queryFn: () => getValidator(address!),
    enabled: !!address,
  });

  const appsQuery = useQuery({
    queryKey: ["applications", address],
    queryFn: () => getApps(address!),
    enabled: !!address,
  });

  const handleApply = async (sentry: SentryDTO) => {
    if (!address || !window.ethereum) return;
    if (!isCorrectChain) { await switchNetwork(); return; }
    setBusyId(sentry.sentryId);
    setStatus({ type: "info", message: `Applying to sentry ${sentry.name}...` });
    try {
      const tx = applyToSentry(sentry.sentryId);
      const txHash = await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [{ from: address, to: tx.to, data: tx.data, value: tx.value }],
      }) as string;

      watchTx(txHash, "platform", (result) => {
        if (result.type === "ready") {
          setStatus({ type: "success", message: `Applied to ${sentry.name}` });
          sentriesQuery.refetch();
          appsQuery.refetch();
        } else {
          setStatus({ type: "error", message: result.message || "Application failed" });
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
  if (!validatorQuery.data?.registered) return null;

  const sentries = sentriesQuery.data || [];
  const apps = appsQuery.data || [];
  const appliedSentryIds = new Set(apps.filter(a => a.status === "Pending").map(a => a.sentryId));

  return (
    <div className="bg-gray-800 rounded-lg p-6">
      <h2 className="text-xl font-semibold mb-4">Browse Sentries</h2>
      {status && (
        <div className={`mb-4 p-3 rounded text-sm ${status.type === "success" ? "bg-green-900/30 border border-green-700 text-green-300" : status.type === "error" ? "bg-red-900/30 border border-red-700 text-red-300" : "bg-blue-900/30 border border-blue-700 text-blue-300"}`}>
          {status.message}
        </div>
      )}
      {sentriesQuery.isLoading && <p className="text-gray-400">Loading sentries...</p>}
      {sentries.length === 0 && !sentriesQuery.isLoading && <p className="text-gray-400">No sentries available.</p>}
      <div className="space-y-2">
        {sentries.map((s) => (
          <div key={s.sentryId} className="flex items-center justify-between bg-gray-900 rounded p-3">
            <div>
              <div className="font-medium">{s.name}</div>
              <div className="text-xs text-gray-400">{s.country} &middot; Capacity: {s.capacity} &middot; {s.active ? "Active" : "Inactive"}</div>
              <div className="text-xs text-gray-500 font-mono">{s.sentryId.slice(0, 12)}...</div>
            </div>
            <button
              onClick={() => handleApply(s)}
              disabled={busyId === s.sentryId || appliedSentryIds.has(s.sentryId) || !s.active}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-1.5 rounded text-sm transition-colors"
            >
              {appliedSentryIds.has(s.sentryId) ? "Applied" : busyId === s.sentryId ? "..." : "Apply"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

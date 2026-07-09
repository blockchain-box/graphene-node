import { useQuery } from "@tanstack/react-query";
import { useWallet } from "@/contexts/WalletContext";
import { getApplications, getAssignments, getValidator } from "@/lib/platform-state";

export function StatusMonitor() {
  const { address } = useWallet();

  const validatorQuery = useQuery({
    queryKey: ["validator", address],
    queryFn: () => getValidator(address!),
    refetchInterval: 15000,
    enabled: !!address,
  });

  const appsQuery = useQuery({
    queryKey: ["applications", address],
    queryFn: () => getApplications(address!),
    refetchInterval: 15000,
    enabled: !!address,
  });

  const assignmentsQuery = useQuery({
    queryKey: ["assignments", address],
    queryFn: () => getAssignments(undefined, address!),
    refetchInterval: 15000,
    enabled: !!address,
  });

  if (!address) return null;

  const validator = validatorQuery.data;
  const apps = appsQuery.data || [];
  const assignments = assignmentsQuery.data || [];

  const pendingApps = apps.filter(a => a.status === "Pending").length;
  const approvedApps = apps.filter(a => a.status === "Approved").length;
  const activeAssignments = assignments.filter(a => a.status === "Active").length;

  return (
    <div className="bg-gray-800 rounded-lg p-6">
      <h2 className="text-xl font-semibold mb-4">Status Overview</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-gray-900 rounded p-3 text-center">
          <div className="text-2xl font-bold text-blue-400">{validator?.registered ? "Yes" : "No"}</div>
          <div className="text-xs text-gray-400 mt-1">Registered</div>
        </div>
        <div className="bg-gray-900 rounded p-3 text-center">
          <div className="text-2xl font-bold text-yellow-400">{pendingApps}</div>
          <div className="text-xs text-gray-400 mt-1">Pending Apps</div>
        </div>
        <div className="bg-gray-900 rounded p-3 text-center">
          <div className="text-2xl font-bold text-green-400">{approvedApps}</div>
          <div className="text-xs text-gray-400 mt-1">Approved Apps</div>
        </div>
        <div className="bg-gray-900 rounded p-3 text-center">
          <div className="text-2xl font-bold text-purple-400">{activeAssignments}</div>
          <div className="text-xs text-gray-400 mt-1">Active Assignments</div>
        </div>
      </div>
      {assignments.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-medium text-gray-300 mb-2">Assignments</h3>
          <div className="space-y-1">
            {assignments.map((a) => (
              <div key={a.id} className="flex justify-between text-sm bg-gray-900 rounded p-2">
                <span className="text-gray-400">#{a.id} &rarr; {a.sentryId.slice(0, 10)}...</span>
                <span className={a.status === "Active" ? "text-green-400" : "text-red-400"}>{a.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

import { ConnectWallet } from "@/components/ConnectWallet";
import { RegisterValidator } from "@/components/RegisterValidator";
import { SentryBrowser } from "@/components/SentryBrowser";
import { ApplicationManager } from "@/components/ApplicationManager";
import { StatusMonitor } from "@/components/StatusMonitor";
import { useWallet } from "@/contexts/WalletContext";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const queryClient = new QueryClient();

function Dashboard() {
  const { address } = useWallet();

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <h1 className="text-lg font-bold">Graphene Validator dApp</h1>
        <ConnectWallet />
      </header>
      <main className="max-w-4xl mx-auto p-6 space-y-6">
        {!address && (
          <div className="text-center py-12">
            <h2 className="text-2xl font-semibold mb-2">Welcome to the Validator dApp</h2>
            <p className="text-gray-400 mb-6">Connect MetaMask to register as a validator, browse sentries, and manage applications.</p>
          </div>
        )}
        {address && <StatusMonitor />}
        {address && <RegisterValidator />}
        {address && <SentryBrowser />}
        {address && <ApplicationManager />}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Dashboard />
    </QueryClientProvider>
  );
}

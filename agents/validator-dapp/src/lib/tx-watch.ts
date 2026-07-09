import { getTxWatchWsEndpoint } from "@/config/rpc";

export interface TxWatchResult {
  type: "ready" | "timeout" | "error";
  txHash: string;
  domain: string;
  blockNumber?: number;
  receiptStatus?: boolean;
  message?: string;
}

export function watchTx(
  txHash: string,
  domain: string,
  onResult: (result: TxWatchResult) => void,
  timeoutMs = 60_000
): { close: () => void } {
  let closed = false;
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    closed = true;
    if (timer) clearTimeout(timer);
    if (socket) {
      socket.close();
      socket = null;
    }
  };

  const connect = () => {
    try {
      socket = new WebSocket(getTxWatchWsEndpoint());
    } catch {
      pollFallback();
      return;
    }

    socket.onopen = () => {
      socket!.send(JSON.stringify({ txHash, domain }));
    };

    socket.onmessage = (event) => {
      try {
        const result: TxWatchResult = JSON.parse(event.data);
        if (result.type === "ready" || result.type === "timeout" || result.type === "error") {
          onResult(result);
          cleanup();
        }
      } catch {
        // ignore parse errors
      }
    };

    socket.onerror = () => {
      socket?.close();
      pollFallback();
    };

    socket.onclose = () => {
      if (!closed) pollFallback();
    };

    timer = setTimeout(() => {
      if (!closed) {
        onResult({ type: "timeout", txHash, domain });
        cleanup();
      }
    }, timeoutMs);
  };

  const pollFallback = () => {
    if (closed) return;
    const startTime = Date.now();
    const poll = async () => {
      if (closed || Date.now() - startTime > timeoutMs) {
        if (!closed) {
          onResult({ type: "timeout", txHash, domain });
          cleanup();
        }
        return;
      }
      try {
        const rpc = localStorage.getItem("validator_dapp_rpc") || "http://localhost:3003/graphene-evm/rpc";
        const res = await fetch(rpc, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getTransactionReceipt", params: [txHash], id: 1 }),
        });
        const data = await res.json();
        if (data.result) {
          onResult({
            type: "ready",
            txHash,
            domain,
            blockNumber: parseInt(data.result.blockNumber, 16),
            receiptStatus: data.result.status === "0x1",
          });
          cleanup();
          return;
        }
      } catch {
        // retry
      }
      timer = setTimeout(poll, 1000);
    };
    timer = setTimeout(poll, 500);
  };

  connect();
  return { close: cleanup };
}

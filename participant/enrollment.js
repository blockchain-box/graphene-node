// Build only the participant's transactions. Signing and broadcasting stay in the operator's wallet.
import { formatEther, Interface, parseEther } from "ethers";
const contract = "0x0000000000000000000000000000000000000004";
const abi = new Interface([
  "function registerValidator(address,string,string,string,string,uint256)",
  "function applyToSentry(address)",
]);
export async function enrollment(invite, identity, request = fetch) {
  const call = async (route, body, optional = false) => {
    const url = new URL(invite.rpc);
    url.pathname = "/graphene-evm/" + route;
    const response = await request(url, {
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      ...(body
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    });
    if (optional && [204, 404].includes(response.status)) return null;
    if (!response.ok)
      throw new Error("The public enrollment API is unavailable.");
    return response.json();
  };
  const chain = await call("rpc", {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_chainId",
    params: [],
  });
  if (chain.result !== "0x" + invite.network.chain_id.toString(16))
    throw new Error("The public RPC is on a different chain.");
  const owner = identity.operator_address;
  const v = await call(
    "graphene/state/platform/validators/" + owner,
    null,
    true,
  );
  if (v && typeof v.registered !== "boolean")
    throw new Error("Unrecognized registration response.");
  if (!v?.registered) {
    const balance = await call("rpc", {
      jsonrpc: "2.0",
      id: 2,
      method: "eth_getBalance",
      params: [owner, "latest"],
    });
    if (typeof balance?.result !== "string" || !/^(0x[\da-f]+|\d+)$/i.test(balance.result))
      throw new Error("Could not read the operator balance. Check enrollment again.");
    return {
      registered: false,
      pending: false,
      approved: false,
      balance: formatEther(BigInt(balance.result)),
    };
  }
  const lower = (s) => String(s || "").toLowerCase();
  if (
    lower(v.wallet) !== owner ||
    lower(v.nodeId) !== identity.node_id ||
    lower(v.agentAddress) !== identity.agent_address ||
    v.networkPublicKey !== identity.validator_public_key ||
    lower(v.encryptionPublicKey).replace(/^0x/, "") !==
      identity.encryption_public_key.slice(2)
  )
    throw new Error(
      "This wallet is registered to a different validator identity.",
    );
  const query = "?validator=" + owner + "&sentryId=" + invite.sentryId;
  const readRows = async (name) => {
    // Set query separately from the path to preserve its parameters.
    const url = new URL(invite.rpc);
    url.pathname = "/graphene-evm/graphene/state/platform/" + name;
    url.search = query;
    const r = await request(url, {
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error("Cannot verify the sentry assignment.");
    const rows = await r.json();
    if (!Array.isArray(rows))
      throw new Error("Unrecognized sentry assignment response.");
    return rows.filter(
      (row) =>
        lower(row.validator) === owner &&
        lower(row.sentryId) === invite.sentryId,
    );
  };
  const [applications, assignments] = await Promise.all([
    readRows("applications"),
    readRows("assignments"),
  ]);
  return {
    registered: true,
    pending: applications.some((r) => lower(r.status) === "pending"),
    approved: assignments.some((r) => lower(r.status) === "active"),
  };
}
export function transaction(invite, identity, state, action, amount) {
  let data;
  if (action === "register") {
    if (state.registered)
      throw new Error("This validator is already registered.");
    if (
      typeof amount !== "string" ||
      !/^\d{1,60}(\.\d{1,18})?$/.test(amount) ||
      parseEther(amount) <= 0n
    )
      throw new Error(
        "Enter a positive stake in GRPH, with up to 18 decimal places.",
      );
    if (state.balance !== undefined && parseEther(amount) >= parseEther(state.balance))
      throw new Error("Fund the operator wallet on this network with enough GRPH for the stake and transaction fees.");
    data = abi.encodeFunctionData("registerValidator", [
      identity.agent_address,
      identity.node_id,
      identity.validator_public_key,
      identity.encryption_public_key.slice(2),
      "validator-" + identity.node_id.slice(0, 8),
      parseEther(amount),
    ]);
  } else if (action === "request-sentry") {
    if (!state.registered || state.pending || state.approved)
      throw new Error(
        "A registered validator with no pending or approved assignment is required.",
      );
    data = abi.encodeFunctionData("applyToSentry", [invite.sentryId]);
  } else throw new Error("Unknown wallet action.");
  return {
    from: identity.operator_address,
    to: contract,
    chainId: "0x" + invite.network.chain_id.toString(16),
    value: "0x0",
    data,
  };
}

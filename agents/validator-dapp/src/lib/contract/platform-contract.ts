import { encodeFunctionData } from "viem";
import { CONTRACT_ADDRESS, REGISTER_VALIDATOR_ABI, APPLY_TO_SENTRY_ABI, CANCEL_APPLICATION_ABI } from "@/config/abi";

export interface TxParams {
  to: string;
  data: string;
  value: string;
}

export function registerValidator(
  agentAddress: string,
  nodeId: string,
  networkPublicKey: string,
  encryptionPublicKey: string,
  moniker: string,
  stakeAmount: bigint
): TxParams {
  return {
    to: CONTRACT_ADDRESS,
    data: encodeFunctionData({
      abi: [REGISTER_VALIDATOR_ABI],
      functionName: "registerValidator",
      args: [agentAddress as `0x${string}`, nodeId, networkPublicKey, encryptionPublicKey, moniker, stakeAmount],
    }),
    value: "0x0",
  };
}

export function applyToSentry(sentryId: string): TxParams {
  return {
    to: CONTRACT_ADDRESS,
    data: encodeFunctionData({
      abi: [APPLY_TO_SENTRY_ABI],
      functionName: "applyToSentry",
      args: [sentryId],
    }),
    value: "0x0",
  };
}

export function cancelApplication(applicationId: bigint): TxParams {
  return {
    to: CONTRACT_ADDRESS,
    data: encodeFunctionData({
      abi: [CANCEL_APPLICATION_ABI],
      functionName: "cancelApplication",
      args: [applicationId],
    }),
    value: "0x0",
  };
}

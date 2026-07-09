import { parseAbiItem } from "viem";

export const CONTRACT_ADDRESS = "0x0000000000000000000000000000000000000004";

export const REGISTER_VALIDATOR_ABI = parseAbiItem(
  "function registerValidator(address agentAddress, string nodeId, string networkPublicKey, string encryptionPublicKey, string moniker, uint256 stakeAmount)"
);

export const APPLY_TO_SENTRY_ABI = parseAbiItem(
  "function applyToSentry(string sentryId)"
);

export const CANCEL_APPLICATION_ABI = parseAbiItem(
  "function cancelApplication(uint256 applicationId)"
);

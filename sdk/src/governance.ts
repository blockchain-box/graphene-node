import type { GovernanceProposalCommand, MintPolicy } from './types.js';

export const GOVERNANCE_CONTRACT = '0x0000000000000000000000000000000000000004';
export const GOVERNANCE_ABI = ['function governance(string operation, string payload)'] as const;
export interface ControlledTokenCommand {
  name: string;
  symbol: string;
  decimals: number;
  initialSupply: string;
  logoURI?: string;
  mintPolicy: MintPolicy;
}
export type GovernanceOperation = {
  draft: GovernanceProposalCommand;
  propose: GovernanceProposalCommand;
  start: { id: string };
  vote: { id: string; amount: string; support: boolean };
  createToken: ControlledTokenCommand;
  requestMint: { token: string; recipient: string; amount: string };
  approveMint: { id: string };
};
/** Pass these arguments to governance() using an ABI encoder such as ethers Interface. Set tx.value to zero. */
export function governanceArguments<K extends keyof GovernanceOperation>(operation: K, command: GovernanceOperation[K]): [K, string] {
  return [operation, JSON.stringify(command)];
}

export interface Coin {
  denom: string;
  amount: string;
}

export interface AccountState {
  balance: Coin;
  nonce: string;
}

export interface Validator {
  exitRequestedHeight?: string | number | null;
  exitEffectiveHeight?: string | number | null;
  withdrawableHeight?: string | number | null;
  lastSignedHeight?: string | number | null;
  operatorAddress: string;
  consensusPubKey: string;
  jailed: boolean;
  status: number;
  tokens: string;
  delegatorShares: string;
  moniker: string;
  website: string;
  details: string;
}

export interface Delegation {
  delegatorAddress: string;
  validatorAddress: string;
  shares: string;
}

export interface StakePot {
  totalWeight: string;
  rewardPerBlock: string;
}

export interface DelegatorReward {
  amount: Coin;
}

export interface VaultBalances {
  onStake: Coin;
  onMarket: Coin;
  deposited: Coin;
}

export interface TokenHolder {
  address: string;
  balance: string;
}

export interface TokenInfo {
  mintPolicy?: MintPolicy;
  name?: string;
  creator?: string;
  creationNonce?: string;
  totalSupply: string;
  chainId: number;
  address: { address: string; value?: string; bytes?: number[]; zero?: boolean };
  logoURI?: string;
  marked: boolean;
  symbol: string;
  decimals: number;
}

export interface Tenant {
  owner: string;
  name: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  totalCount: number;
  page: number;
  size: number;
}

export interface ChainConfig {
  governance?: GovernanceConfig;
  tokenCreationFee: string | null;
  chainId: string;
  minStake: string;
  minDelegate: string;
  rewardPerBlock: string;
  unbondingPeriod: string;
}

export interface AttestSchema {
  uid: string;
  schema: string;
  resolver: string;
  revocable: boolean;
}

export interface Attestation {
  uid: string;
  schemaUID: string;
  attester: string;
  recipient: string;
  revoked: boolean;
  expirationTime: string;
  data: string;
}

export interface AttestVerifyResult {
  valid: boolean;
  uid: string;
  checks: string[];
}

export interface DecodedParameter {
  name: string;
  type: string;
  value: unknown;
}

export interface DecodedInput {
  functionName: string;
  parameters: DecodedParameter[];
}

export interface SyncStatus {
  lastIndexedBlock: number;
  lastStateSyncedBlock: number;
}

export interface Sentry {
  id: string;
  owner: string;
  pubKey: string;
  status: string;
}

export interface ValidatorPlatformInfo {
  address: string;
  moniker: string;
  website: string;
}

export interface SentryApplication {
  id: string;
  sentryId: string;
  validator: string;
  status: string;
}

export interface Assignment {
  id: string;
  sentryId: string;
  validator: string;
  chainId: string;
}

export interface TxWatchRequest {
  txHash: string;
  domain: 'stake' | 'attest' | 'platform';
}

export interface EntityChange {
  kind: string;
  uid: string;
  action: 'UPSERT' | 'DELETE';
}

export interface TxWatchReady {
  type: 'ready';
  txHash: string;
  domain: string;
  blockNumber: number;
  receiptStatus: boolean;
  changes: EntityChange[];
}

export interface TxWatchTimeout {
  type: 'timeout';
  txHash: string;
  domain: string;
}

export interface TxWatchError {
  type: 'error';
  txHash?: string;
  domain?: string;
  message: string;
}

export type TxWatchMessage = TxWatchReady | TxWatchTimeout | TxWatchError;

export type SyncDomain = 'account' | 'stake' | 'token' | 'vault' | 'config' | 'tenant' | 'platform' | 'attest';

export interface StateWatchSubscribe {
  type: 'subscribe';
  domain: SyncDomain;
  scope?: { addresses: string[] };
  lastBlock?: number;
}

export interface StateWatchUnsubscribe {
  type: 'unsubscribe';
  domain: SyncDomain;
}

export interface StateWatchNextPage {
  type: 'nextPage';
  domain: SyncDomain;
  cursor: string;
}

export type StateWatchClientMessage = StateWatchSubscribe | StateWatchUnsubscribe | StateWatchNextPage;

export interface StateWatchEntity {
  kind: string;
  uid: string;
  entity: Record<string, unknown>;
}

export interface StateWatchSnapshot {
  type: 'snapshot';
  domain: SyncDomain;
  blockNumber: number;
  entities: StateWatchEntity[];
}

export interface StateWatchSnapshotPage {
  type: 'snapshotPage';
  domain: SyncDomain;
  blockNumber: number;
  entities: StateWatchEntity[];
  nextCursor: string;
  hasMore: boolean;
}

export interface StateWatchSnapshotComplete {
  type: 'snapshotComplete';
  domain: SyncDomain;
  blockNumber: number;
}

export interface StateWatchChangeEntry {
  kind: string;
  uid: string;
  action: 'UPSERT' | 'DELETE';
  entity?: Record<string, unknown>;
}

export interface StateWatchStateChange {
  type: 'stateChange';
  domain: SyncDomain;
  blockNumber: number;
  changes: StateWatchChangeEntry[];
}

export interface StateWatchError {
  type: 'error';
  message: string;
}

export type StateWatchServerMessage = StateWatchSnapshot | StateWatchStateChange | StateWatchError | StateWatchSnapshotPage | StateWatchSnapshotComplete;

export type StateWatchDomainMessage =
  | Omit<StateWatchSnapshot, 'type'>
  | Omit<StateWatchStateChange, 'type'>
  | Omit<StateWatchSnapshotPage, 'type'>
  | Omit<StateWatchSnapshotComplete, 'type'>;

export interface NewBlockMessage {
  type: 'newBlock';
  block: {
    jsonrpc: string;
    id: string;
    result: {
      query: string;
      data: {
        type: string;
        value: {
          block: {
            header: {
              version: { block: string };
              chain_id: string;
              height: string;
              time: string;
              last_block_id: { hash: string; parts: { total: number; hash: string } };
              last_commit_hash: string;
              data_hash: string;
              validators_hash: string;
              next_validators_hash: string;
              consensus_hash: string;
              app_hash: string;
              last_results_hash: string;
              evidence_hash: string;
              proposer_address: string;
            };
            data: { txs: string[] | null };
            evidence: { evidence: unknown[] };
            last_commit: unknown;
          };
          result_begin_block: unknown;
          result_end_block: unknown;
        };
      };
      events: Record<string, string[]>;
    };
  };
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params: unknown[];
  id: number;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: string;
  };
}

export interface EthereumBlock {
  number: string;
  hash: string;
  parentHash: string;
  nonce: string;
  sha3Uncles: string;
  logsBloom: string;
  transactionsRoot: string;
  stateRoot: string;
  receiptsRoot: string;
  miner: string;
  difficulty: string;
  totalDifficulty: string;
  extraData: string;
  size: string;
  gasLimit: string;
  gasUsed: string;
  timestamp: string;
  transactions: string[] | unknown[];
  uncles: string[];
  baseFeePerGas?: string;
}

export interface EthereumTransaction {
  blockHash: string;
  blockNumber: string;
  from: string;
  gas: string;
  gasPrice: string;
  hash: string;
  input: string;
  nonce: string;
  to: string;
  transactionIndex: string;
  value: string;
  v: string;
  r: string;
  s: string;
}

export interface EthereumTransactionReceipt {
  blockHash: string;
  blockNumber: string;
  contractAddress: string | null;
  cumulativeGasUsed: string;
  from: string;
  gasUsed: string;
  logs: unknown[];
  logsBloom: string;
  status: string;
  to: string;
  transactionHash: string;
  transactionIndex: string;
}

export interface GrphClientConfig {
  baseUrl: string;
  rpc: boolean;
  ws: {
    txWatch: boolean;
    blocks: boolean;
    stateWatch: boolean;
  };
  reconnect: {
    enabled: boolean;
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
}

const DEFAULT_CONFIG: GrphClientConfig = {
  baseUrl: 'http://localhost:3003/graphene-evm',
  rpc: true,
  ws: {
    txWatch: true,
    blocks: true,
    stateWatch: true,
  },
  reconnect: {
    enabled: true,
    maxRetries: 10,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
  },
};

export function defaultConfig(): GrphClientConfig {
  return { ...DEFAULT_CONFIG };
}

/** Native GRPH governance. Monetary amounts are decimal strings in base units. */
export interface GovernanceConfig {
  proposalDeposit: string;
  depositDestination: 'BURN' | 'TREASURY' | 'SPLIT';
  treasuryShareBps: number;
  treasury: string;
  votingPeriod: number;
  timelock: number;
  holdingPeriod: number;
  quorumBps: number;
  approvalBps: number;
  maxActiveProposals: number;
  walletVoteCap: string;
  baseFee: string;
  minFee: string;
  maxFee: string;
  feeDestination: 'BURN' | 'TREASURY' | 'SPLIT';
}
export interface MintPolicy {
  maxSupply: string;
  periodCap: string;
  periodSeconds: number;
  minters: string[];
  threshold: number;
  revision?: number;
  currentPeriod?: number;
  mintedInPeriod?: string;
}
export type GovernanceChange =
  | { parameter: 'mintPolicy'; token: string; mintPolicy: MintPolicy }
  | { parameter: keyof GovernanceConfig | 'tokenCreationFee'; value: string };
export type GovernanceProposalCommand = GovernanceChange & { title: string; description: string };
export interface GovernanceVote {
  locked: string;
  power: string;
  support: boolean;
  released: boolean;
}
export interface GovernanceProposal {
  id: string;
  proposer: string;
  title: string;
  description: string;
  change: GovernanceProposalCommand;
  rules: GovernanceConfig;
  status: 'DRAFT' | 'VOTING' | 'PASSED' | 'REJECTED' | 'EXECUTED';
  snapshotHeight: number;
  snapshotRoot: string;
  votingEnds: number;
  executeAfter: number;
  eligiblePower: string;
  eligibleBalances: Record<string, string>;
  votes: Record<string, GovernanceVote>;
  deposit: string;
  depositSettled: boolean;
  executionError?: string;
}
export interface GovernanceMintRequest {
  id: string;
  token: string;
  recipient: string;
  amount: string;
  policyRevision: number;
  expiresAt: number;
  executed: boolean;
  approvals: string[];
}
export interface GovernanceEvent {
  type: string;
  reference: string;
  actor: string;
  amount: string;
  height: string;
  timestamp: string;
}

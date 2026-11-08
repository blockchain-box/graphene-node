import { Observable, Subscription } from 'rxjs';

interface Coin {
    denom: string;
    amount: string;
}
interface AccountState {
    balance: Coin;
    nonce: string;
}
interface Validator {
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
interface Delegation {
    delegatorAddress: string;
    validatorAddress: string;
    shares: string;
}
interface StakePot {
    totalWeight: string;
    rewardPerBlock: string;
}
interface DelegatorReward {
    amount: Coin;
}
interface VaultBalances {
    onStake: Coin;
    onMarket: Coin;
    deposited: Coin;
}
interface TokenHolder {
    address: string;
    balance: string;
}
interface TokenInfo {
    mintPolicy?: MintPolicy;
    name?: string;
    creator?: string;
    creationNonce?: string;
    totalSupply: string;
    chainId: number;
    address: {
        address: string;
        value?: string;
        bytes?: number[];
        zero?: boolean;
    };
    logoURI?: string;
    marked: boolean;
    symbol: string;
    decimals: number;
}
interface Tenant {
    owner: string;
    name: string;
}
interface PaginatedResponse<T> {
    items: T[];
    totalCount: number;
    page: number;
    size: number;
}
interface ChainConfig {
    governance?: GovernanceConfig;
    tokenCreationFee: string | null;
    chainId: string;
    minStake: string;
    minDelegate: string;
    rewardPerBlock: string;
    unbondingPeriod: string;
}
interface AttestSchema {
    uid: string;
    schema: string;
    resolver: string;
    revocable: boolean;
}
interface Attestation {
    uid: string;
    schemaUID: string;
    attester: string;
    recipient: string;
    revoked: boolean;
    expirationTime: string;
    data: string;
}
interface AttestVerifyResult {
    valid: boolean;
    uid: string;
    checks: string[];
}
interface DecodedParameter {
    name: string;
    type: string;
    value: unknown;
}
interface DecodedInput {
    functionName: string;
    parameters: DecodedParameter[];
}
interface SyncStatus {
    lastIndexedBlock: number;
    lastStateSyncedBlock: number;
}
interface Sentry {
    id: string;
    owner: string;
    pubKey: string;
    status: string;
}
interface ValidatorPlatformInfo {
    address: string;
    moniker: string;
    website: string;
}
interface SentryApplication {
    id: string;
    sentryId: string;
    validator: string;
    status: string;
}
interface Assignment {
    id: string;
    sentryId: string;
    validator: string;
    chainId: string;
}
interface TxWatchRequest {
    txHash: string;
    domain: 'stake' | 'attest' | 'platform';
}
interface EntityChange {
    kind: string;
    uid: string;
    action: 'UPSERT' | 'DELETE';
}
interface TxWatchReady {
    type: 'ready';
    txHash: string;
    domain: string;
    blockNumber: number;
    receiptStatus: boolean;
    changes: EntityChange[];
}
interface TxWatchTimeout {
    type: 'timeout';
    txHash: string;
    domain: string;
}
interface TxWatchError {
    type: 'error';
    txHash?: string;
    domain?: string;
    message: string;
}
type TxWatchMessage = TxWatchReady | TxWatchTimeout | TxWatchError;
type SyncDomain = 'account' | 'stake' | 'token' | 'vault' | 'config' | 'tenant' | 'platform' | 'attest';
interface StateWatchSubscribe {
    type: 'subscribe';
    domain: SyncDomain;
    scope?: {
        addresses: string[];
    };
    lastBlock?: number;
}
interface StateWatchUnsubscribe {
    type: 'unsubscribe';
    domain: SyncDomain;
}
interface StateWatchNextPage {
    type: 'nextPage';
    domain: SyncDomain;
    cursor: string;
}
type StateWatchClientMessage = StateWatchSubscribe | StateWatchUnsubscribe | StateWatchNextPage;
interface StateWatchEntity {
    kind: string;
    uid: string;
    entity: Record<string, unknown>;
}
interface StateWatchSnapshot {
    type: 'snapshot';
    domain: SyncDomain;
    blockNumber: number;
    entities: StateWatchEntity[];
}
interface StateWatchSnapshotPage {
    type: 'snapshotPage';
    domain: SyncDomain;
    blockNumber: number;
    entities: StateWatchEntity[];
    nextCursor: string;
    hasMore: boolean;
}
interface StateWatchSnapshotComplete {
    type: 'snapshotComplete';
    domain: SyncDomain;
    blockNumber: number;
}
interface StateWatchChangeEntry {
    kind: string;
    uid: string;
    action: 'UPSERT' | 'DELETE';
    entity?: Record<string, unknown>;
}
interface StateWatchStateChange {
    type: 'stateChange';
    domain: SyncDomain;
    blockNumber: number;
    changes: StateWatchChangeEntry[];
}
interface StateWatchError {
    type: 'error';
    message: string;
}
type StateWatchServerMessage = StateWatchSnapshot | StateWatchStateChange | StateWatchError | StateWatchSnapshotPage | StateWatchSnapshotComplete;
type StateWatchDomainMessage = Omit<StateWatchSnapshot, 'type'> | Omit<StateWatchStateChange, 'type'> | Omit<StateWatchSnapshotPage, 'type'> | Omit<StateWatchSnapshotComplete, 'type'>;
interface NewBlockMessage {
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
                            version: {
                                block: string;
                            };
                            chain_id: string;
                            height: string;
                            time: string;
                            last_block_id: {
                                hash: string;
                                parts: {
                                    total: number;
                                    hash: string;
                                };
                            };
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
                        data: {
                            txs: string[] | null;
                        };
                        evidence: {
                            evidence: unknown[];
                        };
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
interface JsonRpcRequest {
    jsonrpc: '2.0';
    method: string;
    params: unknown[];
    id: number;
}
interface JsonRpcResponse<T = unknown> {
    jsonrpc: '2.0';
    id: number;
    result?: T;
    error?: {
        code: number;
        message: string;
        data?: string;
    };
}
interface EthereumBlock {
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
interface EthereumTransaction {
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
interface EthereumTransactionReceipt {
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
interface GrphClientConfig {
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
declare function defaultConfig(): GrphClientConfig;
/** Native GRPH governance. Monetary amounts are decimal strings in base units. */
interface GovernanceConfig {
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
interface MintPolicy {
    maxSupply: string;
    periodCap: string;
    periodSeconds: number;
    minters: string[];
    threshold: number;
    revision?: number;
    currentPeriod?: number;
    mintedInPeriod?: string;
}
type GovernanceChange = {
    parameter: 'mintPolicy';
    token: string;
    mintPolicy: MintPolicy;
} | {
    parameter: keyof GovernanceConfig | 'tokenCreationFee';
    value: string;
};
type GovernanceProposalCommand = GovernanceChange & {
    title: string;
    description: string;
};
interface GovernanceVote {
    locked: string;
    power: string;
    support: boolean;
    released: boolean;
}
interface GovernanceProposal {
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
interface GovernanceMintRequest {
    id: string;
    token: string;
    recipient: string;
    amount: string;
    policyRevision: number;
    expiresAt: number;
    executed: boolean;
    approvals: string[];
}
interface GovernanceEvent {
    type: string;
    reference: string;
    actor: string;
    amount: string;
    height: string;
    timestamp: string;
}

declare class GrphRestClient {
    private baseUrl;
    constructor(baseUrl: string);
    private get;
    getGovernanceConfig(chainId: string): Promise<GovernanceConfig>;
    getActiveProposals(chainId: string): Promise<{
        active: string[];
    }>;
    getGovernanceProposal(chainId: string, id: string): Promise<GovernanceProposal>;
    getMintRequest(chainId: string, id: string): Promise<GovernanceMintRequest>;
    getGovernanceEvent(chainId: string, reference: string, type: string, actor: string): Promise<GovernanceEvent>;
    getControlledToken(chainId: string, address: string): Promise<TokenInfo>;
    getAccount(address: string): Promise<AccountState | null>;
    getSyncStatus(): Promise<SyncStatus>;
    getStakePot(chainId: string): Promise<StakePot>;
    getValidators(chainId: string): Promise<Validator[]>;
    getDelegations(params: {
        chainId: string;
        address: string;
        page?: number;
        size?: number;
    }): Promise<Delegation[]>;
    getDelegation(chainId: string, validatorAddress: string, delegatorAddress: string): Promise<Delegation | null>;
    getValidatorReward(chainId: string, validatorAddress: string): Promise<DelegatorReward>;
    getDelegatorReward(chainId: string, validatorAddress: string, delegatorAddress: string): Promise<DelegatorReward>;
    getMyDelegations(chainId: string, delegatorAddress: string): Promise<Delegation[]>;
    getTokens(chainId: string, page?: number, size?: number): Promise<PaginatedResponse<TokenInfo>>;
    getTokenHolders(chainId: string, token: string, page?: number, size?: number): Promise<PaginatedResponse<TokenHolder>>;
    getVaultBalances(address: string): Promise<VaultBalances>;
    getTenants(): Promise<Tenant[]>;
    getTenant(owner: string): Promise<Tenant | null>;
    getChainConfig(chainId: string): Promise<ChainConfig>;
    getAttestSchemas(page?: number, size?: number): Promise<AttestSchema[]>;
    getAttestSchema(uid: string): Promise<AttestSchema | null>;
    getAttestations(params: {
        attester?: string;
        recipient?: string;
        schemaUID?: string;
        revoked?: boolean;
        page?: number;
        size?: number;
    }): Promise<Attestation[]>;
    getAttestation(uid: string): Promise<Attestation | null>;
    verifyAttestation(uid: string): Promise<AttestVerifyResult>;
    decodeAttestation(uid: string): Promise<DecodedInput>;
    getSentries(): Promise<Sentry[]>;
    getValidatorPlatform(address: string): Promise<ValidatorPlatformInfo | null>;
    getSentryApplications(params: {
        validator?: string;
        sentryId?: string;
    }): Promise<SentryApplication[]>;
    getAssignments(params: {
        sentryId?: string;
        validator?: string;
    }): Promise<Assignment[]>;
}

declare class GrphRpcClient {
    private rpcUrl;
    private idCounter;
    constructor(rpcUrl: string);
    private call;
    web3_clientVersion(): Promise<string>;
    eth_sha3(data: string): Promise<string>;
    net_version(): Promise<string>;
    net_peerCount(): Promise<string>;
    net_listening(): Promise<boolean>;
    eth_syncing(): Promise<boolean | object>;
    eth_mining(): Promise<boolean>;
    eth_chainId(): Promise<string>;
    eth_blockNumber(): Promise<string>;
    eth_getBlockByNumber(blockNumber: string, fullTx?: boolean): Promise<EthereumBlock | null>;
    eth_getBlockByHash(blockHash: string, fullTx?: boolean): Promise<EthereumBlock | null>;
    eth_sendRawTransaction(data: string): Promise<string>;
    eth_sendRawTransactionBatch(data: string[]): Promise<string[]>;
    eth_call(tx: {
        to?: string;
        data?: string;
        from?: string;
        gas?: string;
        gasPrice?: string;
        value?: string;
    }, blockTag?: string): Promise<string>;
    eth_estimateGas(tx: {
        to?: string;
        data?: string;
        from?: string;
        value?: string;
    }): Promise<string>;
    eth_getTransactionByHash(hash: string): Promise<EthereumTransaction | null>;
    eth_getTransactionReceipt(hash: string): Promise<EthereumTransactionReceipt | null>;
    txpool_content(): Promise<object>;
    eth_getCode(address: string, blockTag?: string): Promise<string>;
    eth_getTransactionCount(address: string, blockTag?: string): Promise<string>;
    eth_getBalance(address: string, blockTag?: string): Promise<string>;
    eth_gasPrice(): Promise<string>;
    eth_maxPriorityFeePerGas(): Promise<string>;
    eth_feeHistory(blockCount: string, newestBlock: string, rewardPercentiles?: number[]): Promise<object>;
    eth_getToken(address: string): Promise<object>;
    eth_getTokens(): Promise<object[]>;
}

declare class CursorPaginatedObservable<T> {
    private observable;
    private domain;
    private send;
    constructor(observable: Observable<T>, domain: SyncDomain, send: (data: unknown) => void);
    subscribe(observerOrNext?: ((value: T) => void) | {
        next?: (value: T) => void;
        error?: (err: Error) => void;
        complete?: () => void;
    } | null, error?: ((err: Error) => void) | null, complete?: (() => void) | null): Subscription;
    requestNextPage(cursor: string): void;
    pipe(): Observable<T>;
}
declare class GrphWsClient {
    private baseUrl;
    private config;
    private connections;
    private stateWatchConn;
    constructor(baseUrl: string, config: GrphClientConfig);
    txWatch(req: TxWatchRequest): Observable<TxWatchMessage>;
    blocks(): Observable<NewBlockMessage>;
    close(): void;
    stateWatch(): {
        account(addresses?: string[]): Observable<StateWatchDomainMessage> | CursorPaginatedObservable<StateWatchDomainMessage>;
        stake(): Observable<StateWatchDomainMessage>;
        token(): Observable<StateWatchDomainMessage>;
        vault(): Observable<StateWatchDomainMessage>;
        config(): Observable<StateWatchDomainMessage>;
        tenant(): Observable<StateWatchDomainMessage>;
        platform(): Observable<StateWatchDomainMessage>;
        attest(): Observable<StateWatchDomainMessage>;
    };
}

declare class GrphClient {
    private config;
    readonly rest: GrphRestClient;
    readonly rpc: GrphRpcClient;
    readonly ws: GrphWsClient;
    constructor(config: GrphClientConfig);
    getConfig(): Readonly<GrphClientConfig>;
}

declare class GrphClientBuilder {
    private config;
    constructor();
    baseUrl(url: string): this;
    rpc(enable: boolean): this;
    ws(options: {
        txWatch?: boolean;
        blocks?: boolean;
        stateWatch?: boolean;
    }): this;
    reconnect(options: {
        enabled?: boolean;
        maxRetries?: number;
        baseDelayMs?: number;
        maxDelayMs?: number;
    }): this;
    build(): GrphClient;
    static configure(): GrphClientBuilder;
}

declare const GOVERNANCE_CONTRACT = "0x0000000000000000000000000000000000000004";
declare const GOVERNANCE_ABI: readonly ["function governance(string operation, string payload)"];
interface ControlledTokenCommand {
    name: string;
    symbol: string;
    decimals: number;
    initialSupply: string;
    logoURI?: string;
    mintPolicy: MintPolicy;
}
type GovernanceOperation = {
    draft: GovernanceProposalCommand;
    propose: GovernanceProposalCommand;
    start: {
        id: string;
    };
    vote: {
        id: string;
        amount: string;
        support: boolean;
    };
    createToken: ControlledTokenCommand;
    requestMint: {
        token: string;
        recipient: string;
        amount: string;
    };
    approveMint: {
        id: string;
    };
};
/** Pass these arguments to governance() using an ABI encoder such as ethers Interface. Set tx.value to zero. */
declare function governanceArguments<K extends keyof GovernanceOperation>(operation: K, command: GovernanceOperation[K]): [K, string];

export { type AccountState, type Assignment, type AttestSchema, type AttestVerifyResult, type Attestation, type ChainConfig, type Coin, type ControlledTokenCommand, type DecodedInput, type DecodedParameter, type Delegation, type DelegatorReward, type EntityChange, type EthereumBlock, type EthereumTransaction, type EthereumTransactionReceipt, GOVERNANCE_ABI, GOVERNANCE_CONTRACT, type GovernanceChange, type GovernanceConfig, type GovernanceEvent, type GovernanceMintRequest, type GovernanceOperation, type GovernanceProposal, type GovernanceProposalCommand, type GovernanceVote, GrphClient, GrphClientBuilder, type GrphClientConfig, GrphRestClient, GrphRpcClient, GrphWsClient, type JsonRpcRequest, type JsonRpcResponse, type MintPolicy, type NewBlockMessage, type PaginatedResponse, type Sentry, type SentryApplication, type StakePot, type StateWatchChangeEntry, type StateWatchClientMessage, type StateWatchDomainMessage, type StateWatchEntity, type StateWatchError, type StateWatchNextPage, type StateWatchServerMessage, type StateWatchSnapshot, type StateWatchSnapshotComplete, type StateWatchSnapshotPage, type StateWatchStateChange, type StateWatchSubscribe, type StateWatchUnsubscribe, type SyncDomain, type SyncStatus, type Tenant, type TokenHolder, type TokenInfo, type TxWatchError, type TxWatchMessage, type TxWatchReady, type TxWatchRequest, type TxWatchTimeout, type Validator, type ValidatorPlatformInfo, type VaultBalances, defaultConfig, governanceArguments };

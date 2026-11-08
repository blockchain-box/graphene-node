import type {
  GovernanceConfig,
  GovernanceProposal,
  GovernanceMintRequest,
  GovernanceEvent,
  AccountState,
  Attestation,
  AttestSchema,
  AttestVerifyResult,
  Assignment,
  ChainConfig,
  DecodedInput,
  Delegation,
  DelegatorReward,
  Sentry,
  SentryApplication,
  StakePot,
  SyncStatus,
  Tenant,
  TokenInfo,
  TokenHolder,
  PaginatedResponse,
  Validator,
  ValidatorPlatformInfo,
  VaultBalances,
} from './types.js';

export class GrphRestClient {
  constructor(private baseUrl: string) {}

  private async get<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
      });
    }
    const response = await fetch(url.toString());
    if (response.status === 204) return null as T;
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`REST ${path} failed (${response.status}): ${body}`);
    }
    const text = await response.text();
    if (!text) return null as T;
    return JSON.parse(text) as T;
  }

  async getGovernanceConfig(chainId: string): Promise<GovernanceConfig> {
    return this.get(`/graphene/state/governance/${encodeURIComponent(chainId)}/config`);
  }

  async getActiveProposals(chainId: string): Promise<{ active: string[] }> {
    return this.get(`/graphene/state/governance/${encodeURIComponent(chainId)}/active`);
  }

  async getGovernanceProposal(chainId: string, id: string): Promise<GovernanceProposal> {
    return this.get(`/graphene/state/governance/${encodeURIComponent(chainId)}/proposals/${encodeURIComponent(id)}`);
  }

  async getMintRequest(chainId: string, id: string): Promise<GovernanceMintRequest> {
    return this.get(`/graphene/state/governance/${encodeURIComponent(chainId)}/mints/${encodeURIComponent(id)}`);
  }

  async getGovernanceEvent(chainId: string, reference: string, type: string, actor: string): Promise<GovernanceEvent> {
    return this.get(`/graphene/state/governance/${encodeURIComponent(chainId)}/events/${encodeURIComponent(reference)}/${encodeURIComponent(type)}/${encodeURIComponent(actor)}`);
  }

  async getControlledToken(chainId: string, address: string): Promise<TokenInfo> {
    return this.get(`/graphene/state/governance/${encodeURIComponent(chainId)}/tokens/${encodeURIComponent(address)}`);
  }

  async getAccount(address: string): Promise<AccountState | null> {
    return this.get<AccountState>('/graphene/state/account', { address });
  }

  async getSyncStatus(): Promise<SyncStatus> {
    return this.get<SyncStatus>('/graphene/state/sync-status');
  }

  async getStakePot(chainId: string): Promise<StakePot> {
    return this.get<StakePot>('/graphene/state/stake/pot', { chainId });
  }

  async getValidators(chainId: string): Promise<Validator[]> {
    return this.get<Validator[]>('/graphene/state/stake/validators', { chainId });
  }

  async getDelegations(params: { chainId: string; address: string; page?: number; size?: number }): Promise<Delegation[]> {
    return this.get<Delegation[]>('/graphene/state/stake/delegators', {
      chainId: params.chainId,
      address: params.address,
      page: params.page?.toString(),
      size: params.size?.toString(),
    });
  }

  async getDelegation(chainId: string, validatorAddress: string, delegatorAddress: string): Promise<Delegation | null> {
    return this.get<Delegation>('/graphene/state/stake/delegator', { chainId, validatorAddress, delegatorAddress });
  }

  async getValidatorReward(chainId: string, validatorAddress: string): Promise<DelegatorReward> {
    return this.get<DelegatorReward>('/graphene/state/stake/validator/reward', { chainId, validatorAddress });
  }

  async getDelegatorReward(chainId: string, validatorAddress: string, delegatorAddress: string): Promise<DelegatorReward> {
    return this.get<DelegatorReward>('/graphene/state/stake/delegator/reward', { chainId, validatorAddress, delegatorAddress });
  }

  async getMyDelegations(chainId: string, delegatorAddress: string): Promise<Delegation[]> {
    return this.get<Delegation[]>('/graphene/state/stake/my-delegations', { chainId, delegatorAddress });
  }

  async getTokens(chainId: string, page = 0, size = 20): Promise<PaginatedResponse<TokenInfo>> {
    return this.get<PaginatedResponse<TokenInfo>>('/graphene/state/tokens', { chainId, page: String(page), size: String(size) });
  }

  async getTokenHolders(chainId: string, token: string, page = 0, size = 20): Promise<PaginatedResponse<TokenHolder>> {
    return this.get<PaginatedResponse<TokenHolder>>('/graphene/state/tokens/holders', {
      chainId, token, page: String(page), size: String(size),
    });
  }

  async getVaultBalances(address: string): Promise<VaultBalances> {
    return this.get<VaultBalances>('/graphene/state/vault-balances', { address });
  }

  async getTenants(): Promise<Tenant[]> {
    return this.get<Tenant[]>('/graphene/state/tenants');
  }

  async getTenant(owner: string): Promise<Tenant | null> {
    return this.get<Tenant>('/graphene/state/tenant', { owner });
  }

  async getChainConfig(chainId: string): Promise<ChainConfig> {
    return this.get<ChainConfig>('/graphene/state/chain-config', { chainId });
  }

  async getAttestSchemas(page?: number, size?: number): Promise<AttestSchema[]> {
    return this.get<AttestSchema[]>('/graphene/state/attest/schemas', {
      page: page?.toString(),
      size: size?.toString(),
    });
  }

  async getAttestSchema(uid: string): Promise<AttestSchema | null> {
    return this.get<AttestSchema>('/graphene/state/attest/schema', { uid });
  }

  async getAttestations(params: {
    attester?: string;
    recipient?: string;
    schemaUID?: string;
    revoked?: boolean;
    page?: number;
    size?: number;
  }): Promise<Attestation[]> {
    return this.get<Attestation[]>('/graphene/state/attest/attestations', {
      attester: params.attester,
      recipient: params.recipient,
      schemaUID: params.schemaUID,
      revoked: params.revoked?.toString(),
      page: params.page?.toString(),
      size: params.size?.toString(),
    });
  }

  async getAttestation(uid: string): Promise<Attestation | null> {
    return this.get<Attestation>('/graphene/state/attest/attestation', { uid });
  }

  async verifyAttestation(uid: string): Promise<AttestVerifyResult> {
    return this.get<AttestVerifyResult>('/graphene/state/attest/verify', { uid });
  }

  async decodeAttestation(uid: string): Promise<DecodedInput> {
    return this.get<DecodedInput>('/graphene/state/attest/decode', { uid });
  }

  async getSentries(): Promise<Sentry[]> {
    return this.get<Sentry[]>('/graphene/state/platform/sentries');
  }

  async getValidatorPlatform(address: string): Promise<ValidatorPlatformInfo | null> {
    return this.get<ValidatorPlatformInfo>(`/graphene/state/platform/validators/${address}`);
  }

  async getSentryApplications(params: { validator?: string; sentryId?: string }): Promise<SentryApplication[]> {
    return this.get<SentryApplication[]>('/graphene/state/platform/applications', {
      validator: params.validator,
      sentryId: params.sentryId,
    });
  }

  async getAssignments(params: { sentryId?: string; validator?: string }): Promise<Assignment[]> {
    return this.get<Assignment[]>('/graphene/state/platform/assignments', {
      sentryId: params.sentryId,
      validator: params.validator,
    });
  }
}

import { getStateApiEndpoint } from "@/config/rpc";

function stateGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${getStateApiEndpoint()}${path}`);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
  }
  return fetch(url.toString()).then((res) => {
    if (!res.ok) throw new Error(`State API error: ${res.status}`);
    return res.json();
  });
}

export interface SentryDTO {
  sentryId: string;
  operator: string;
  name: string;
  country: string;
  capacity: string;
  encryptionPublicKey: string;
  active: boolean;
}

export interface ValidatorDTO {
  wallet: string;
  agentAddress: string;
  nodeId: string;
  networkPublicKey: string;
  encryptionPublicKey: string;
  moniker: string;
  stake: string;
  registered: boolean;
}

export interface ApplicationDTO {
  id: string;
  validator: string;
  sentryId: string;
  status: string;
  createdAt: string;
}

export interface AssignmentDTO {
  id: string;
  applicationId: string;
  validator: string;
  sentryId: string;
  encryptedConnectionString: string;
  status: string;
}

export function getSentries(): Promise<SentryDTO[]> {
  return stateGet<SentryDTO[]>("/platform/sentries");
}

export function getValidator(address: string): Promise<ValidatorDTO | null> {
  return stateGet<ValidatorDTO>("/platform/validators/" + address).catch(() => null);
}

export function getApplications(validator?: string, sentryId?: string): Promise<ApplicationDTO[]> {
  const params: Record<string, string> = {};
  if (validator) params.validator = validator;
  if (sentryId) params.sentryId = sentryId;
  return stateGet<ApplicationDTO[]>("/platform/applications", params);
}

export function getAssignments(sentryId?: string, validator?: string): Promise<AssignmentDTO[]> {
  const params: Record<string, string> = {};
  if (sentryId) params.sentryId = sentryId;
  if (validator) params.validator = validator;
  return stateGet<AssignmentDTO[]>("/platform/assignments", params);
}

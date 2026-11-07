import { describe, it, expect } from 'vitest';
import { buildJsonPayload, validateMoniker, validateStakeAmount } from '../src/cli.js';
import { generateAll } from '../src/keygen.js';

describe('validateMoniker', () => {
  it('accepts valid moniker (1 char)', () => {
    expect(validateMoniker('a')).toBe(true);
  });

  it('accepts valid moniker (64 chars)', () => {
    expect(validateMoniker('a'.repeat(64))).toBe(true);
  });

  it('accepts typical moniker', () => {
    expect(validateMoniker('my-validator-node')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(validateMoniker('')).toBe(false);
  });

  it('rejects null/undefined', () => {
    expect(validateMoniker(null)).toBe(false);
    expect(validateMoniker(undefined)).toBe(false);
  });

  it('rejects moniker longer than 64 chars', () => {
    expect(validateMoniker('a'.repeat(65))).toBe(false);
  });
});

describe('validateStakeAmount', () => {
  it('accepts positive integer', () => {
    expect(validateStakeAmount('1000')).toBe(true);
  });

  it('accepts positive decimal', () => {
    expect(validateStakeAmount('1000.5')).toBe(true);
  });

  it('accepts zero-prefixed decimal', () => {
    expect(validateStakeAmount('0.5')).toBe(true);
  });

  it('rejects zero', () => {
    expect(validateStakeAmount('0')).toBe(false);
  });

  it('rejects negative number', () => {
    expect(validateStakeAmount('-1')).toBe(false);
    expect(validateStakeAmount('-0.5')).toBe(false);
  });

  it('rejects non-numeric string', () => {
    expect(validateStakeAmount('abc')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateStakeAmount('')).toBe(false);
  });
});

describe('buildJsonPayload (form mode, full=false)', () => {
  it('returns all public form fields', () => {
    const secrets = generateAll();
    const payload = buildJsonPayload(secrets, 'test-validator', '500.25', false);

    expect(payload).toHaveProperty('grphInviteKey');
    expect(payload).toHaveProperty('grphDhtPublicKey');
    expect(payload.tendermintValidatorPublicKey).toBe(secrets.tendermint.validator.publicKey.value);
    expect(payload).toHaveProperty('agentAddress');
    expect(payload).toHaveProperty('x25519PublicKey');
    expect(payload).toHaveProperty('tendermintValidatorAddress');
    expect(payload).toHaveProperty('tendermintNodeId');
    expect(payload).toHaveProperty('moniker');

    const keys = Object.keys(payload);
    expect(keys).toHaveLength(8);
  });

  it('maps grphInviteKey correctly', () => {
    const secrets = generateAll();
    const payload = buildJsonPayload(secrets, 'v', '1', false);

    expect(payload.grphInviteKey).toBe(secrets.grph.invite);
    expect(payload.grphInviteKey).toMatch(/^grph_/);
  });

  it('maps grphDhtPublicKey correctly', () => {
    const secrets = generateAll();
    const payload = buildJsonPayload(secrets, 'v', '1', false);

    expect(payload.grphDhtPublicKey).toBe(secrets.grph.keyPair.publicKey);
    expect(payload.grphDhtPublicKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it('maps agentAddress correctly', () => {
    const secrets = generateAll();
    const payload = buildJsonPayload(secrets, 'v', '1', false);

    expect(payload.agentAddress).toBe(secrets.agent.address);
    expect(payload.agentAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it('maps x25519PublicKey correctly', () => {
    const secrets = generateAll();
    const payload = buildJsonPayload(secrets, 'v', '1', false);

    expect(payload.x25519PublicKey).toBe(secrets.x25519.publicKey);
    expect(payload.x25519PublicKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it('maps tendermintValidatorAddress correctly', () => {
    const secrets = generateAll();
    const payload = buildJsonPayload(secrets, 'v', '1', false);

    expect(payload.tendermintValidatorAddress).toBe(secrets.tendermint.validator.address);
    expect(payload.tendermintValidatorAddress).toMatch(/^[A-F0-9]{40}$/);
  });

  it('maps tendermintNodeId correctly', () => {
    const secrets = generateAll();
    const payload = buildJsonPayload(secrets, 'v', '1', false);

    expect(payload.tendermintNodeId).toBe(secrets.tendermint.node.nodeId);
    expect(payload.tendermintNodeId).toMatch(/^[a-f0-9]{40}$/);
  });

  it('uses the provided moniker value', () => {
    const secrets = generateAll();
    const payload = buildJsonPayload(secrets, 'my-node', '1234.56', false);

    expect(payload.moniker).toBe('my-node');
  });

  it('defaults to form mode when full is omitted', () => {
    const secrets = generateAll();
    const payload = buildJsonPayload(secrets, 'v', '1');

    expect(Object.keys(payload)).toHaveLength(8);
    expect(payload).toHaveProperty('grphDhtPublicKey');
    expect(payload.tendermintValidatorPublicKey).toBe(secrets.tendermint.validator.publicKey.value);
  });

  it('produces valid JSON when serialized', () => {
    const secrets = generateAll();
    const payload = buildJsonPayload(secrets, 'test-validator', '1000', false);

    const json = JSON.stringify(payload);
    const parsed = JSON.parse(json);

    expect(parsed.grphInviteKey).toBe(payload.grphInviteKey);
    expect(parsed.grphDhtPublicKey).toBe(payload.grphDhtPublicKey);
    expect(parsed.agentAddress).toBe(payload.agentAddress);
    expect(parsed.x25519PublicKey).toBe(payload.x25519PublicKey);
    expect(parsed.tendermintValidatorAddress).toBe(payload.tendermintValidatorAddress);
    expect(parsed.tendermintNodeId).toBe(payload.tendermintNodeId);
    expect(parsed.moniker).toBe(payload.moniker);
  });
});

describe('buildJsonPayload (full mode, full=true)', () => {
  it('returns all 9 fields', () => {
    const secrets = generateAll();
    const payload = buildJsonPayload(secrets, 'test-validator', '500.25', true);

    expect(payload).toHaveProperty('agentAddress');
    expect(payload).toHaveProperty('nodeId');
    expect(payload).toHaveProperty('networkPublicKey');
    expect(payload).toHaveProperty('encryptionPublicKey');
    expect(payload).toHaveProperty('moniker');
    expect(payload).toHaveProperty('stakeAmount');
    expect(payload).toHaveProperty('grphInviteKey');
    expect(payload).toHaveProperty('grphPublicKey');
    expect(payload).toHaveProperty('validatorAddress');

    const keys = Object.keys(payload);
    expect(keys).toHaveLength(9);
  });

  it('includes moniker and stakeAmount', () => {
    const secrets = generateAll();
    const payload = buildJsonPayload(secrets, 'my-node', '1234.56', true);

    expect(payload.moniker).toBe('my-node');
    expect(payload.stakeAmount).toBe('1234.56');
  });

  it('maps all key material correctly', () => {
    const secrets = generateAll();
    const payload = buildJsonPayload(secrets, 'v', '1', true);

    expect(payload.agentAddress).toBe(secrets.agent.address);
    expect(payload.nodeId).toBe(secrets.tendermint.node.nodeId);
    expect(payload.networkPublicKey).toBe(secrets.tendermint.validator.publicKey.value);
    expect(payload.encryptionPublicKey).toBe(secrets.x25519.publicKey);
    expect(payload.grphInviteKey).toBe(secrets.grph.invite);
    expect(payload.grphPublicKey).toBe(secrets.grph.keyPair.publicKey);
    expect(payload.validatorAddress).toBe(secrets.tendermint.validator.address);
  });

  it('produces valid JSON with all 9 fields', () => {
    const secrets = generateAll();
    const payload = buildJsonPayload(secrets, 'test-validator', '1000', true);

    const parsed = JSON.parse(JSON.stringify(payload));

    expect(parsed.agentAddress).toBe(payload.agentAddress);
    expect(parsed.nodeId).toBe(payload.nodeId);
    expect(parsed.networkPublicKey).toBe(payload.networkPublicKey);
    expect(parsed.encryptionPublicKey).toBe(payload.encryptionPublicKey);
    expect(parsed.moniker).toBe(payload.moniker);
    expect(parsed.stakeAmount).toBe(payload.stakeAmount);
    expect(parsed.grphInviteKey).toBe(payload.grphInviteKey);
    expect(parsed.grphPublicKey).toBe(payload.grphPublicKey);
    expect(parsed.validatorAddress).toBe(payload.validatorAddress);
  });
});

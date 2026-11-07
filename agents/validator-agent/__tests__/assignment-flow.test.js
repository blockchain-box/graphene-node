import { describe, it, expect, vi } from 'vitest';
import { ApprovalMonitor } from '../src/monitor.js';
import { AssignmentMonitor } from '../../sentry-agent/src/monitor.js';

const wallet = '0x' + '12'.repeat(20);
const agent = '0x' + '34'.repeat(20);
const sentry = '0x' + '56'.repeat(20);

describe('agent to platform assignment contract', () => {
  it('validator looks up its assignments by agent, not by the operator wallet', async () => {
    const monitor = new ApprovalMonitor({ rpcUrl: 'http://node:3003/graphene-evm/rpc' }, { agent: { address: agent } });
    monitor.fetchJson = vi.fn().mockResolvedValue([{ id: '1', validator: wallet, sentryId: sentry, status: 'Active' }]);
    monitor._processAssignment = vi.fn().mockResolvedValue({ success: true });
    monitor._schedulePersistentPeersUpdate = vi.fn().mockResolvedValue(undefined);
    await monitor.checkAssignments();
    expect(monitor.fetchJson).toHaveBeenCalledWith(`http://node:3003/graphene-evm/graphene/state/platform/assignments?agent=${agent}`);
    expect(monitor._processAssignment).toHaveBeenCalledOnce();
    expect(monitor.lastPollSuccess).toBe(true);
  });

  it('retries a previously blocked RPC publication, but preserves successful and revoked assignments', async () => {
    const monitor = new ApprovalMonitor({ rpcUrl: 'http://node:3003/graphene-evm/rpc', managePeers: false }, { agent: { address: agent } });
    const assignments = [
      { id: 'retry', validator: wallet, sentryId: sentry, status: 'Active' },
      { id: 'block-format', validator: wallet, sentryId: sentry, status: 'Active' },
      { id: 'published', validator: wallet, sentryId: sentry, status: 'Active', encryptedConnectionString: 'encrypted' },
      { id: 'revoked', validator: wallet, sentryId: sentry, status: 'Revoked' },
      { id: 'denied', validator: wallet, sentryId: sentry, status: 'Active' },
    ];
    for (const a of assignments) {
      monitor.processedAssignments.add(a.id);
      monitor.errors.set(a.id, { errorType: 'PERMANENT', lastError: a.id === 'denied' ? 'Only the validator agent may publish' : a.id === 'block-format' ? 'invalid value for value.difficulty' : 'missing response for request' });
    }
    monitor.fetchJson = vi.fn().mockResolvedValue(assignments);
    monitor._processAssignment = vi.fn().mockResolvedValue({ success: true });
    monitor._saveProcessedAssignments = vi.fn();
    await monitor.checkAssignments();
    expect(monitor._processAssignment).toHaveBeenCalledTimes(2);
    expect(monitor._processAssignment).toHaveBeenNthCalledWith(1, assignments[0]);
    expect(monitor._processAssignment).toHaveBeenNthCalledWith(2, assignments[1]);
    expect(monitor.processedAssignments.has('denied')).toBe(true);
    expect(monitor.processedAssignments.has('published')).toBe(true);
    expect(monitor.processedAssignments.has('revoked')).toBe(true);
  });

  it('sentry closes tunnels when active assignments disappear or verification stays unavailable', async () => {
    const manager = { disconnect: vi.fn().mockResolvedValue(undefined), disconnectAll: vi.fn().mockResolvedValue(undefined) };
    const monitor = new AssignmentMonitor({ rpcUrl: 'http://node:3003/graphene-evm/rpc' }, { agent: { address: sentry } }, manager);
    monitor.processedAssignments.set('1', { validatorId: wallet, encryptedConnectionString: 'encrypted' });
    monitor._saveProcessedAssignments = vi.fn();
    monitor.fetchJson = vi.fn().mockResolvedValue([]);
    await monitor.checkAssignments();
    expect(manager.disconnect).toHaveBeenCalledWith(wallet);
    expect(monitor.processedAssignments.size).toBe(0);
    monitor.lastVerifiedTime = Date.now() - 60000;
    monitor.fetchJson.mockRejectedValue(new Error('network unavailable'));
    await monitor.checkAssignments();
    expect(manager.disconnectAll).toHaveBeenCalledOnce();
    expect(monitor.lastPollSuccess).toBe(false);
  });

  it('sentry connects and revokes using the validator field returned by app-evm', async () => {
    const manager = { connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined) };
    const monitor = new AssignmentMonitor({ rpcUrl: 'http://node:3003/graphene-evm/rpc' }, { agent: { address: sentry } }, manager);
    const assignment = { id: '1', validator: wallet, sentryId: sentry, status: 'Active', encryptedConnectionString: 'encrypted' };
    monitor.fetchJson = vi.fn().mockResolvedValueOnce([assignment]).mockResolvedValueOnce({ nodeId: 'ab'.repeat(20) });
    monitor._saveProcessedAssignments = vi.fn();
    await monitor.checkAssignments();
    expect(monitor.fetchJson).toHaveBeenNthCalledWith(1, `http://node:3003/graphene-evm/graphene/state/platform/assignments?sentryId=${sentry}`);
    expect(manager.connect).toHaveBeenCalledWith(wallet, 'encrypted', expect.objectContaining({ nodeId: 'ab'.repeat(20) }));
    monitor.fetchJson.mockResolvedValue([{ ...assignment, status: 'Revoked' }]);
    await monitor.checkAssignments();
    expect(manager.disconnect).toHaveBeenCalledWith(wallet);
  });
});

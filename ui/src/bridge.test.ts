import { describe, expect, it } from 'vitest';
import { BridgeError, call, decideApproval, inApp, listApprovals, listAudit, normalizeRuntimeMetrics, normalizeSoulComms, setSoulComms, soulAsides, soulComms } from './bridge';

describe('bridge', () => {
  it('invokes the shell command with the method and params', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => { calls.push([cmd, args]); return { souls: [] }; }) as never;
    await expect(call('census', {}, fake)).resolves.toEqual({ souls: [] });
    expect(calls).toEqual([['bridge', { method: 'census', params: {} }]]);
  });

  it('turns shell errors into BridgeError with their code', async () => {
    const fake = (async () => { throw { code: 'broker-unreachable', message: 'down' }; }) as never;
    const error = await call('census', {}, fake).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({ code: 'broker-unreachable', message: 'down' });
  });

  it('is not in the app under test', () => {
    expect(inApp()).toBe(false);
  });
});

describe('soul comms (#71)', () => {
  const state = { agentId: 'agent_1', name: 'bill', managed: true, comms: false, running: false };

  it('reads agent-bot soul comms show, and is null when it cannot say', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => { calls.push([cmd, args]); return state; }) as never;
    await expect(soulComms('agent_1', fake)).resolves.toEqual({ agentId: 'agent_1', managed: true, comms: false, running: false });
    expect(calls).toEqual([['soul_comms', { action: 'show', soul: 'agent_1' }]]);
    const failing = (async () => { throw { code: 'soul-comms-failed', message: 'no record' }; }) as never;
    await expect(soulComms('agent_1', failing)).resolves.toBeNull();
    await expect(soulComms('agent_1')).resolves.toBeNull();
  });

  it('sets on or off and surfaces agent-bot refusals', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => { calls.push([cmd, args]); return { ...state, comms: true }; }) as never;
    await expect(setSoulComms('agent_1', true, fake)).resolves.toMatchObject({ comms: true });
    expect(calls).toEqual([['soul_comms', { action: 'on', soul: 'agent_1' }]]);
    const refused = (async () => { throw { code: 'soul-comms-failed', message: 'agent_1 is running' }; }) as never;
    await expect(setSoulComms('agent_1', false, refused)).rejects.toMatchObject({ code: 'soul-comms-failed', message: 'agent_1 is running' });
  });

  it('drops malformed states', () => {
    expect(normalizeSoulComms({ agentId: 'a' })).toBeNull();
    expect(normalizeSoulComms(null)).toBeNull();
    expect(normalizeSoulComms({ agentId: 'a', comms: true })).toBeNull();
    expect(normalizeSoulComms({ agentId: 'a', comms: true, managed: false })).toBeNull();
    expect(normalizeSoulComms({ agentId: 'a', comms: true, managed: false, running: false })).toEqual({ agentId: 'a', managed: false, comms: true, running: false });
  });
});

describe('normalizeRuntimeMetrics', () => {
  it('drops malformed entries and keeps well-formed ones', () => {
    const observedAt = '2026-10-03T12:00:00Z';
    const good = { metric: 'model_reported', value: 'claude-opus', unit: null, scope: 'call', source: 'claude-session-log', kind: 'reported', observedAt };
    const result = normalizeRuntimeMetrics({
      collectedAt: observedAt,
      souls: { agent_a: { lastCallAt: observedAt, observations: [good, null, { metric: 1 }] }, agent_b: null },
      errors: [null, { agentId: 'agent_a', source: 'claude-session-log', code: 'read-failed', message: 'failed' }],
      missing: [7, { agentId: 'agent_c', source: 'claude-session-log' }],
    });
    expect(result).toEqual({
      collectedAt: observedAt,
      souls: { agent_a: { lastCallAt: observedAt, observations: [good] } },
      errors: [{ agentId: 'agent_a', source: 'claude-session-log', code: 'read-failed', message: 'failed' }],
      missing: [{ agentId: 'agent_c', source: 'claude-session-log' }],
    });
  });

  it('reports unavailable for a payload without the snapshot shape', () => {
    for (const raw of [null, { unavailable: true }, { souls: [], errors: [], missing: [] }]) {
      expect(normalizeRuntimeMetrics(raw)).toEqual({ unavailable: true });
    }
  });
});

describe('agent-bot asides and approvals', () => {
  it('reads asides and approvals through the shell, null when it cannot', async () => {
    const calls: unknown[] = [];
    const fake = (async (command: string, args: unknown) => {
      calls.push([command, args]);
      return command === 'soul_asides' ? { agentId: 'agent_1', asides: [], next: null } : { approvals: [] };
    }) as never;
    await expect(soulAsides('agent_1', 'aside_9', fake)).resolves.toEqual({ asides: [], next: null });
    await expect(listApprovals(fake)).resolves.toEqual([]);
    expect(calls).toEqual([['soul_asides', { soul: 'agent_1', after: 'aside_9' }], ['approvals', { action: 'list' }]]);
    const failing = (async () => { throw { code: 'soul-asides-failed', message: 'x' }; }) as never;
    await expect(soulAsides('agent_1', null, failing)).resolves.toBeNull();
    await expect(listApprovals(failing)).resolves.toBeNull();
    await expect(soulAsides('agent_1', null)).resolves.toBeNull();
  });

  it('decides a proposal and keeps the shell’s error code', async () => {
    const ok = (async (_c: string, args: { action: string; proposal: string }) =>
      ({ proposalId: args.proposal, agentId: 'agent_1', status: args.action === 'deny' ? 'denied' : 'approved', summary: 's' })) as never;
    await expect(decideApproval('p1', 'deny', ok)).resolves.toMatchObject({ proposalId: 'p1', status: 'denied' });
    const refused = (async () => { throw { code: 'not-open', message: 'p1 is not waiting on a decision' }; }) as never;
    await expect(decideApproval('p1', 'approve', refused)).rejects.toMatchObject({ code: 'not-open' });
    await expect(decideApproval('p1', 'approve', (async () => ({})) as never)).rejects.toMatchObject({ code: 'approvals-failed' });
  });
});

describe('audit log (#122)', () => {
  it('reads agent-bot audit list for a soul or the fleet, dropping malformed records', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => {
      calls.push([cmd, args]);
      return { records: [{ at: '2026-10-05T10:00:00Z', event: 'permission', decision: 'allow' }, { at: 'x' }] };
    }) as never;
    await expect(listAudit('agent_1', fake)).resolves.toEqual([{ at: '2026-10-05T10:00:00Z', event: 'permission', decision: 'allow' }]);
    await expect(listAudit(null, fake)).resolves.toHaveLength(1);
    expect(calls).toEqual([['audit_list', { agent: 'agent_1' }], ['audit_list', { agent: null }]]);
  });

  it('is null when agent-bot cannot say', async () => {
    // An older bundle: the shell turns its usage line into an error.
    const older = (async () => { throw { code: 'audit-failed', message: 'agent-bot: usage: agent-bot soul' }; }) as never;
    await expect(listAudit('agent_1', older)).resolves.toBeNull();
    await expect(listAudit('agent_1', (async () => ({ error: {} })) as never)).resolves.toBeNull();
    await expect(listAudit(null)).resolves.toBeNull();
  });
});

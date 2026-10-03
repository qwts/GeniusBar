import { describe, expect, it } from 'vitest';
import { BridgeError, call, inApp, normalizeRuntimeMetrics, normalizeSoulComms, setSoulComms, soulComms } from './bridge';

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
    expect(normalizeSoulComms({ agentId: 'a', comms: true })).toEqual({ agentId: 'a', managed: false, comms: true, running: false });
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

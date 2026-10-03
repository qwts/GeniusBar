import { describe, expect, it } from 'vitest';
import { BridgeError, call, inApp, normalizeRuntimeMetrics } from './bridge';

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

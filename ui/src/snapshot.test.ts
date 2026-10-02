import { describe, expect, it } from 'vitest';
import { BridgeError } from './bridge';
import { sampleCensus } from './model/fixtures';
import { censusOnce, detailKey, snapshotError } from './snapshot';

describe('snapshot', () => {
  it('waits for the bridge to start, but takes any broker answer as final', async () => {
    const answers: unknown[] = [new BridgeError('bridge-starting', ''), new BridgeError('bridge-starting', ''), { souls: [] }];
    let t = 0;
    const callImpl = (async () => {
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    }) as never;
    expect(await censusOnce({ callImpl, sleep: async () => { t += 250; }, now: () => t })).toEqual({ ok: true, souls: [] });
    const unpaired = (async () => { throw new BridgeError('unauthenticated', 'no'); }) as never;
    expect(await censusOnce({ callImpl: unpaired, sleep: async () => {} })).toMatchObject({ ok: false, code: 'unauthenticated' });
  });

  it('gives up on a bridge that never starts', async () => {
    let t = 0;
    const callImpl = (async () => { throw new BridgeError('bridge-starting', 'node'); }) as never;
    expect(await censusOnce({ callImpl, sleep: async () => { t += 1_000; }, now: () => t }))
      .toMatchObject({ ok: false, code: 'bridge-starting' });
  });

  it('finds the requested detail by agent ID and reports what went wrong', () => {
    expect(detailKey(sampleCensus, 'agent_c')).toBe('user/agent_c');
    expect(detailKey(sampleCensus, 'agent_nope')).toBeNull();
    expect(detailKey(sampleCensus, null)).toBeNull();
    const ok = { ok: true as const, souls: sampleCensus };
    expect(snapshotError(ok, { detail: null }, null)).toBeNull();
    expect(snapshotError(ok, { detail: 'agent_nope' }, null)).toBe('unknown detail ID agent_nope');
    expect(snapshotError({ ok: false, code: 'broker-unreachable', message: 'down' }, { detail: null }, null))
      .toBe('broker-unreachable: down');
  });
});

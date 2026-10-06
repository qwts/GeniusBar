import { describe, expect, it } from 'vitest';
import { BridgeError } from './bridge';
import { brokerInstalled, fetchCensus } from './useCensus';

describe('fetchCensus', () => {
  it('returns the rows from the bridge', async () => {
    const souls = [{ account: 'a', agentId: 'agent_1' }];
    const outcome = await fetchCensus((async () => ({ ok: true, souls })) as never);
    expect(outcome).toEqual({ ok: true, souls });
  });

  it('turns bridge errors into a coded outcome', async () => {
    const outcome = await fetchCensus((async () => { throw new BridgeError('broker-timeout', 'late'); }) as never);
    expect(outcome).toEqual({ ok: false, code: 'broker-timeout', message: 'late' });
  });
});

describe('brokerInstalled (#118)', () => {
  const installed = (broker: boolean) => async () => ({ broker, daemon: broker });

  it('asks the shell only after a failure that reached the bridge', async () => {
    let asked = 0;
    const check = async () => { asked += 1; return { broker: true, daemon: true }; };
    await expect(brokerInstalled({ ok: true, souls: [] }, check)).resolves.toBe(false);
    await expect(brokerInstalled({ ok: false, code: 'bridge-timeout', message: '' }, check)).resolves.toBe(false);
    expect(asked).toBe(0);
    await expect(brokerInstalled({ ok: false, code: 'broker-timeout', message: '' }, check)).resolves.toBe(true);
    expect(asked).toBe(1);
  });

  it('is false when the broker is not installed or the shell cannot say', async () => {
    const timeout = { ok: false as const, code: 'broker-unreachable', message: '' };
    await expect(brokerInstalled(timeout, installed(false))).resolves.toBe(false);
    await expect(brokerInstalled(timeout, async () => null)).resolves.toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { BridgeError } from './bridge';
import { fetchCensus } from './useCensus';

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

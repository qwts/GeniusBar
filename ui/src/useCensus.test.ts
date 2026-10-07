import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeError } from './bridge';
import { brokerInstalled, fetchCensus, useCensus } from './useCensus';

const bridge = vi.hoisted(() => ({
  souls: [] as { account: string; agentId: string; presence: string }[],
}));
vi.mock('./bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bridge')>()),
  call: async () => ({ souls: bridge.souls }),
  servicesInstalled: async () => ({ broker: true }),
  inApp: () => true,
}));

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

describe('useCensus', () => {
  afterEach(() => cleanup());

  it('drops archived souls from the roster and re-reads them on an explicit refresh (#196)', async () => {
    bridge.souls = [
      { account: 'a', agentId: 'agent_gone', presence: 'left' },
      { account: 'a', agentId: 'agent_here', presence: 'joined' },
    ];
    let population: { agentId: string; comms: boolean; managed: boolean; status: string | null }[] = [
      { agentId: 'agent_gone', comms: false, managed: true, status: 'active' },
    ];
    const reads = vi.fn(async () => population);
    const { result } = renderHook(() => useCensus(true, reads));
    await waitFor(() => expect(result.current.census.map((s) => s.agentId)).toEqual(['agent_gone', 'agent_here']));
    expect(reads).toHaveBeenCalledTimes(1);
    // The owner archives agent_gone; the archive path refreshes.
    population = [{ agentId: 'agent_gone', comms: false, managed: true, status: 'retired' }];
    await act(async () => { await result.current.refresh?.(); });
    await waitFor(() => expect(result.current.census.map((s) => s.agentId)).toEqual(['agent_here']));
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('keeps every hub row when agent-bot cannot list the population', async () => {
    bridge.souls = [{ account: 'a', agentId: 'agent_gone', presence: 'left' }];
    const { result } = renderHook(() => useCensus(true, async () => null));
    await waitFor(() => expect(result.current.census).toHaveLength(1));
    // Settled all the same: the roster will not shrink from a later read.
    await waitFor(() => expect(result.current.settled).toBe(true));
  });

  it('is settled once the population has been read, whatever it said', async () => {
    bridge.souls = [{ account: 'a', agentId: 'agent_here', presence: 'joined' }];
    let release: () => void = () => {};
    const reads = vi.fn(() => new Promise<{ agentId: string; comms: boolean; managed: boolean; status: string | null }[]>((resolve) => {
      release = () => resolve([]);
    }));
    const { result } = renderHook(() => useCensus(true, reads));
    await waitFor(() => expect(result.current.census).toHaveLength(1));
    expect(result.current.settled).toBe(false);
    await act(async () => { release(); });
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(renderHook(() => useCensus(false)).result.current.settled).toBe(true);
  });
});

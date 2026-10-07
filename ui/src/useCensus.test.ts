import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeError } from './bridge';
import { disconnected } from './model/status';
import { brokerInstalled, CENSUS_STALE_MS, CENSUS_STORAGE_KEY, fetchCensus, fromStored, toStored, useCensus, type StoredCensus } from './useCensus';

const bridge = vi.hoisted(() => ({
  souls: [] as { account: string; agentId: string; presence: string }[],
  calls: 0,
}));
vi.mock('./bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bridge')>()),
  call: async () => { bridge.calls += 1; return { souls: bridge.souls }; },
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

describe('useCensus shared between windows (#223)', () => {
  const noPopulation = async () => null;
  const memory = () => {
    const items = new Map<string, string>();
    return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => { items.set(k, v); }, items };
  };
  const stored = (at: number, agentId = 'agent_shared'): StoredCensus => toStored({
    rows: [{ account: 'a', agentId, name: null, harness: null, parent: null, presence: 'joined', unacked: 0, lastWake: null }],
    archivedBy: [], populationRead: true,
    connection: { ...disconnected, bridgeConnected: true, lastRefresh: new Date(at) },
  }, at);
  afterEach(() => { cleanup(); bridge.calls = 0; });

  it('round-trips the connection dates through storage and rejects what does not parse', () => {
    const back = fromStored(JSON.stringify(stored(1_000)));
    expect(back?.connection.lastRefresh).toBe(new Date(1_000).toISOString());
    expect(back?.rows[0]?.agentId).toBe('agent_shared');
    expect(fromStored(null)).toBeNull();
    expect(fromStored('{')).toBeNull();
    expect(fromStored('{"at":"soon"}')).toBeNull();
    expect(fromStored('[]')).toBeNull();
  });

  it('a publisher stores each census for the other windows', async () => {
    bridge.souls = [{ account: 'a', agentId: 'agent_here', presence: 'joined' }];
    const storage = memory();
    const { result } = renderHook(() => useCensus(true, noPopulation, { share: 'publish', storage, now: () => 42_000 }));
    await waitFor(() => expect(result.current.census).toHaveLength(1));
    await waitFor(() => expect(storage.items.has(CENSUS_STORAGE_KEY)).toBe(true));
    const saved = fromStored(storage.getItem(CENSUS_STORAGE_KEY));
    expect(saved?.at).toBe(42_000);
    expect(saved?.rows.map((r) => r.agentId)).toEqual(['agent_here']);
    expect(saved?.populationRead).toBe(true);
    expect(saved?.connection.bridgeConnected).toBe(true);
    expect(typeof saved?.connection.lastRefresh).toBe('string');
  });

  it('a follower shows a fresh stored census without asking the bridge, and takes the next from the storage event', async () => {
    bridge.souls = [{ account: 'a', agentId: 'agent_polled', presence: 'joined' }];
    const storage = memory();
    storage.setItem(CENSUS_STORAGE_KEY, JSON.stringify(stored(10_000)));
    const { result } = renderHook(() => useCensus(true, noPopulation, { share: 'follow', storage, now: () => 12_000 }));
    await waitFor(() => expect(result.current.census.map((r) => r.agentId)).toEqual(['agent_shared']));
    expect(result.current.connection.lastRefresh).toEqual(new Date(10_000));
    expect(result.current.settled).toBe(true);
    expect(bridge.calls).toBe(0);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: CENSUS_STORAGE_KEY, newValue: JSON.stringify(stored(11_000, 'agent_next')) }));
    });
    await waitFor(() => expect(result.current.census.map((r) => r.agentId)).toEqual(['agent_next']));
    expect(bridge.calls).toBe(0);
  });

  it('a follower polls itself while the stored census is stale or missing', async () => {
    bridge.souls = [{ account: 'a', agentId: 'agent_polled', presence: 'joined' }];
    const storage = memory();
    storage.setItem(CENSUS_STORAGE_KEY, JSON.stringify(stored(10_000)));
    const { result } = renderHook(() => useCensus(true, noPopulation, { share: 'follow', storage, now: () => 10_000 + CENSUS_STALE_MS + 1 }));
    await waitFor(() => expect(result.current.census.map((r) => r.agentId)).toEqual(['agent_polled']));
    expect(bridge.calls).toBe(1);
    // Polling stores nothing: only the popup publishes.
    expect(fromStored(storage.getItem(CENSUS_STORAGE_KEY))?.at).toBe(10_000);
    const empty = memory();
    const alone = renderHook(() => useCensus(true, noPopulation, { share: 'follow', storage: empty }));
    await waitFor(() => expect(alone.result.current.census).toHaveLength(1));
    expect(bridge.calls).toBe(2);
  });
});

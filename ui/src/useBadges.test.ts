import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonStatus } from './bridge';
import { BADGES_STALE_MS, BADGES_STORAGE_KEY, COMMS_INTERVAL_MS, fromStoredBadges, STATUS_INTERVAL_MS, toStoredBadges, useBadges, type BadgeSources, type StoredBadges } from './useBadges';

afterEach(() => vi.useRealTimers());

/** `oneCall` false plays an older bundle: `population` answers null. */
const sources = (using: string[], commsOn: string[], oneCall = true): BadgeSources => ({
  status: vi.fn(async () => ({ running: true, computerUse: using.map((agentId) => ({ agentId, since: null })) })),
  population: vi.fn(async () => (oneCall
    ? ['agent_p', 'agent_c', 'agent_other'].map((agentId) => ({ agentId, comms: commsOn.includes(agentId), managed: true }))
    : null)),
  comms: vi.fn(async (agentId: string) => ({ agentId, comms: commsOn.includes(agentId), managed: true, running: false })),
});

describe('useBadges (#122, #137)', () => {
  it('reads comms for every soul in one population call', async () => {
    const fake = sources(['agent_c'], ['agent_p', 'agent_other']);
    const { result } = renderHook(() => useBadges(['agent_p', 'agent_c'], true, fake));
    await waitFor(() => expect([...result.current.computerUse]).toEqual(['agent_c']));
    // agent_other has comms on but is not on the desktop.
    await waitFor(() => expect([...result.current.comms]).toEqual(['agent_p']));
    expect(fake.population).toHaveBeenCalledTimes(1);
    expect(fake.comms).not.toHaveBeenCalled();
  });

  it('falls back to one comms read per soul on an older bundle', async () => {
    const fake = sources([], ['agent_p'], false);
    const { result } = renderHook(() => useBadges(['agent_p', 'agent_c'], true, fake));
    await waitFor(() => expect([...result.current.comms]).toEqual(['agent_p']));
    expect(fake.population).toHaveBeenCalledTimes(1);
    expect(fake.comms).toHaveBeenCalledTimes(2);
  });

  it('falls back when the population call throws', async () => {
    const fake = sources([], ['agent_p']);
    fake.population = vi.fn(async () => { throw new Error('no'); });
    const { result } = renderHook(() => useBadges(['agent_p'], true, fake));
    await waitFor(() => expect([...result.current.comms]).toEqual(['agent_p']));
    expect(fake.comms).toHaveBeenCalledTimes(1);
  });

  it('reads no comms with no souls on the desktop', async () => {
    const fake = sources([], ['agent_p']);
    renderHook(() => useBadges([], true, fake));
    await act(async () => {});
    expect(fake.population).not.toHaveBeenCalled();
    expect(fake.comms).not.toHaveBeenCalled();
  });

  it('reads nothing while disabled, and survives failing reads', async () => {
    const idle = sources(['agent_c'], ['agent_p']);
    const { result } = renderHook(() => useBadges(['agent_p'], false, idle));
    expect(result.current.comms.size + result.current.computerUse.size).toBe(0);
    expect(idle.status).not.toHaveBeenCalled();
    expect(idle.population).not.toHaveBeenCalled();
    const failing: BadgeSources = {
      status: async () => { throw new Error('no'); },
      population: async () => null,
      comms: async () => null,
    };
    const { result: failed } = renderHook(() => useBadges(['agent_p'], true, failing));
    await act(async () => {});
    expect(failed.current.comms.size + failed.current.computerUse.size).toBe(0);
  });

  it('polls comms once a minute with one call', async () => {
    vi.useFakeTimers();
    const fake = sources([], ['agent_p']);
    renderHook(() => useBadges(['agent_p', 'agent_c'], true, fake));
    await act(async () => { await vi.advanceTimersByTimeAsync(COMMS_INTERVAL_MS); });
    expect(fake.population).toHaveBeenCalledTimes(2);
    expect(fake.comms).not.toHaveBeenCalled();
  });

  it('polls computer use every 15 s while no soul drives the screen', async () => {
    vi.useFakeTimers();
    const fake = sources([], []);
    renderHook(() => useBadges([], true, fake));
    await act(async () => { await vi.advanceTimersByTimeAsync(STATUS_INTERVAL_MS - 1); });
    expect(fake.status).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fake.status).toHaveBeenCalledTimes(2);
  });

  it('reports the souls mid-turn and keeps the census cadence while any is', async () => {
    vi.useFakeTimers();
    let busy = ['agent_p'];
    const fake = sources([], []);
    fake.status = vi.fn(async (): Promise<DaemonStatus> => ({ running: true, computerUse: [], busy }));
    const { result } = renderHook(() => useBadges(['agent_p'], true, fake));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(fake.status).toHaveBeenCalledTimes(2);
    expect([...result.current.busy]).toEqual(['agent_p']);
    busy = [];
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(result.current.busy.size).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(fake.status).toHaveBeenCalledTimes(3);
  });

  it('polls on the census cadence while a soul drives the screen, then slows once it stops', async () => {
    vi.useFakeTimers();
    let using = ['agent_c'];
    const fake = sources([], []);
    fake.status = vi.fn(async (): Promise<DaemonStatus> => ({ running: true, computerUse: using.map((agentId) => ({ agentId, since: null })) }));
    const { result } = renderHook(() => useBadges(['agent_c'], true, fake));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(fake.status).toHaveBeenCalledTimes(2);
    expect([...result.current.computerUse]).toEqual(['agent_c']);
    using = [];
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(fake.status).toHaveBeenCalledTimes(3);
    expect(result.current.computerUse.size).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(STATUS_INTERVAL_MS - 1); });
    expect(fake.status).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fake.status).toHaveBeenCalledTimes(4);
  });
});

describe('useBadges hues (#64)', () => {
  it('keeps the hues souls declare from the same population call', async () => {
    const fake: BadgeSources = {
      status: vi.fn(async () => null),
      population: vi.fn(async () => [
        { agentId: 'agent_p', comms: false, managed: true, appearance: { hue: 210 } },
        { agentId: 'agent_c', comms: false, managed: true },
      ]),
      comms: vi.fn(async () => null),
    };
    const { result } = renderHook(() => useBadges(['agent_p', 'agent_c'], true, fake));
    await waitFor(() => expect(result.current.hues && [...result.current.hues]).toEqual([['agent_p', 210]]));
    expect(fake.population).toHaveBeenCalledTimes(1);
  });
});

describe('useBadges roles (agent-bot-identity #535)', () => {
  it('keeps the roles souls declare from the same population call', async () => {
    const fake: BadgeSources = {
      status: vi.fn(async () => null),
      population: vi.fn(async () => [
        { agentId: 'agent_p', comms: false, managed: true, role: 'Release captain', roleLine: 'Release captain' },
        { agentId: 'agent_c', comms: false, managed: true },
      ]),
      comms: vi.fn(async () => null),
    };
    const { result } = renderHook(() => useBadges(['agent_p', 'agent_c'], true, fake));
    await waitFor(() => expect(result.current.roles && [...result.current.roles])
      .toEqual([['agent_p', { role: 'Release captain', roleLine: 'Release captain' }]]));
    expect(fake.population).toHaveBeenCalledTimes(1);
  });
});

describe('useBadges shared between windows (#223)', () => {
  const memory = () => {
    const items = new Map<string, string>();
    return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => { items.set(k, v); }, items };
  };
  const stored = (at: number, computerUse: string[] = ['agent_c']): StoredBadges =>
    toStoredBadges({ comms: new Set(['agent_p']), computerUse: new Set(computerUse), busy: new Set(), hues: new Map([['agent_p', 200]]), roles: new Map([['agent_p', { role: 'lead' }]]) }, at);

  it('round-trips sets and maps through storage and rejects what does not parse', () => {
    const back = fromStoredBadges(JSON.stringify(stored(1_000)));
    expect(back).toEqual({ at: 1_000, comms: ['agent_p'], computerUse: ['agent_c'], busy: [], hues: [['agent_p', 200]], roles: [['agent_p', { role: 'lead' }]] });
    expect(fromStoredBadges(null)).toBeNull();
    expect(fromStoredBadges('{')).toBeNull();
    expect(fromStoredBadges('{"at":1,"comms":[1],"computerUse":[],"busy":[]}')).toBeNull();
    expect(fromStoredBadges('[]')).toBeNull();
  });

  it('a publisher stores each read, stamped, even when nothing changed', async () => {
    vi.useFakeTimers();
    let at = 1_000;
    const storage = memory();
    const fake = sources(['agent_c'], ['agent_p']);
    renderHook(() => useBadges(['agent_p', 'agent_c'], true, fake, { share: 'publish', storage, now: () => at }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const first = fromStoredBadges(storage.getItem(BADGES_STORAGE_KEY));
    expect(first?.computerUse).toEqual(['agent_c']);
    expect(first?.comms).toEqual(['agent_p']);
    at = 6_000;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(fromStoredBadges(storage.getItem(BADGES_STORAGE_KEY))?.at).toBe(6_000);
  });

  it('a follower shows a fresh stored set without reading agent-bot, and takes the next from the storage event', async () => {
    const storage = memory();
    storage.setItem(BADGES_STORAGE_KEY, JSON.stringify(stored(10_000)));
    const fake = sources(['agent_other'], []);
    const { result } = renderHook(() => useBadges(['agent_p', 'agent_c'], true, fake, { share: 'follow', storage, now: () => 12_000 }));
    await waitFor(() => expect([...result.current.computerUse]).toEqual(['agent_c']));
    expect([...result.current.comms]).toEqual(['agent_p']);
    expect(result.current.hues?.get('agent_p')).toBe(200);
    expect(result.current.roles?.get('agent_p')).toEqual({ role: 'lead' });
    expect(fake.status).not.toHaveBeenCalled();
    expect(fake.population).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: BADGES_STORAGE_KEY, newValue: JSON.stringify(stored(11_000, [])) }));
    });
    await waitFor(() => expect(result.current.computerUse.size).toBe(0));
    expect(fake.status).not.toHaveBeenCalled();
  });

  it('a follower reads agent-bot itself while the stored set is stale, and stores nothing', async () => {
    const storage = memory();
    storage.setItem(BADGES_STORAGE_KEY, JSON.stringify(stored(10_000)));
    const fake = sources(['agent_p'], []);
    const { result } = renderHook(() => useBadges(['agent_p'], true, fake, { share: 'follow', storage, now: () => 10_000 + BADGES_STALE_MS + 1 }));
    await waitFor(() => expect([...result.current.computerUse]).toEqual(['agent_p']));
    expect(fake.status).toHaveBeenCalledTimes(1);
    expect(fromStoredBadges(storage.getItem(BADGES_STORAGE_KEY))?.at).toBe(10_000);
  });
});

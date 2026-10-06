import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonStatus } from './bridge';
import { COMMS_INTERVAL_MS, STATUS_INTERVAL_MS, useBadges, type BadgeSources } from './useBadges';

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

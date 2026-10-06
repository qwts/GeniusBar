import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBadges, type BadgeSources } from './useBadges';

afterEach(() => vi.useRealTimers());

const sources = (using: string[], commsOn: string[]): BadgeSources => ({
  status: vi.fn(async () => ({ running: true, computerUse: using.map((agentId) => ({ agentId, since: null })) })),
  comms: vi.fn(async (agentId: string) => ({ agentId, comms: commsOn.includes(agentId), managed: true, running: false })),
});

describe('useBadges (#122)', () => {
  it('reads computer use from the daemon and comms per soul', async () => {
    const fake = sources(['agent_c'], ['agent_p']);
    const { result } = renderHook(() => useBadges(['agent_p', 'agent_c'], true, fake));
    await waitFor(() => expect([...result.current.computerUse]).toEqual(['agent_c']));
    await waitFor(() => expect([...result.current.comms]).toEqual(['agent_p']));
    expect(fake.comms).toHaveBeenCalledTimes(2);
  });

  it('reads nothing while disabled, and survives failing reads', async () => {
    const idle = sources(['agent_c'], ['agent_p']);
    const { result } = renderHook(() => useBadges(['agent_p'], false, idle));
    expect(result.current.comms.size + result.current.computerUse.size).toBe(0);
    expect(idle.status).not.toHaveBeenCalled();
    const failing: BadgeSources = { status: async () => { throw new Error('no'); }, comms: async () => null };
    const { result: failed } = renderHook(() => useBadges(['agent_p'], true, failing));
    await act(async () => {});
    expect(failed.current.comms.size + failed.current.computerUse.size).toBe(0);
  });

  it('polls computer use on the census cadence', async () => {
    vi.useFakeTimers();
    const fake = sources([], []);
    renderHook(() => useBadges([], true, fake));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(fake.status).toHaveBeenCalledTimes(2);
  });
});

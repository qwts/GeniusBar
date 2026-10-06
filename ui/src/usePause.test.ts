import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PauseEntry } from './model/pause';
import { usePause, type Pauser } from './usePause';

const soul = (agentId: string, paused = false, over: Partial<PauseEntry> = {}): PauseEntry =>
  ({ agentId, managed: true, paused, status: 'active', ...over });

function fake(entries: PauseEntry[], supported = true) {
  const state = new Map(entries.map((e) => [e.agentId, e]));
  const set = (agentId: string, paused: boolean) => { state.set(agentId, { ...state.get(agentId)!, paused }); return { agentId, paused }; };
  const pauser = {
    supported: vi.fn(async () => supported),
    list: vi.fn(async () => [...state.values()]),
    pause: vi.fn(async (agentId: string) => ({ ...set(agentId, true), stopped: false })),
    resume: vi.fn(async (agentId: string) => set(agentId, false)),
  } satisfies Pauser;
  return pauser;
}

describe('usePause (#122)', () => {
  it('offers nothing on a bundle without soul pause, and never reads', async () => {
    const p = fake([soul('agent_a', true)], false);
    const { result } = renderHook(() => usePause(p));
    await waitFor(() => expect(p.supported).toHaveBeenCalled());
    expect(result.current.offered).toBe(false);
    expect(result.current.paused).toBe(false);
    expect(p.list).not.toHaveBeenCalled();
  });

  it('pauses every managed, unarchived soul, then resumes only the paused ones', async () => {
    const p = fake([soul('agent_a'), soul('agent_b'), soul('agent_u', false, { managed: false }), soul('agent_r', false, { status: 'retired' })]);
    const { result } = renderHook(() => usePause(p));
    await waitFor(() => expect(p.list).toHaveBeenCalled());
    expect(result.current.offered).toBe(true);
    expect(result.current.paused).toBe(false);
    await act(() => result.current.toggle());
    expect(p.pause.mock.calls.map(([id]) => id)).toEqual(['agent_a', 'agent_b']);
    expect(result.current.paused).toBe(true);
    p.resume.mockClear();
    await act(() => result.current.toggle());
    expect(p.resume.mock.calls.map(([id]) => id)).toEqual(['agent_a', 'agent_b']);
    expect(result.current.paused).toBe(false);
  });

  it('resumes only the souls that are paused', async () => {
    const p = fake([soul('agent_a', true), soul('agent_b')]);
    const { result } = renderHook(() => usePause(p));
    await waitFor(() => expect(result.current.paused).toBe(true));
    await act(() => result.current.toggle());
    expect(p.resume.mock.calls.map(([id]) => id)).toEqual(['agent_a']);
    expect(p.pause).not.toHaveBeenCalled();
  });

  it('reports the first failure, and hides itself when the bundle turns out not to have the command', async () => {
    const p = fake([soul('agent_a'), soul('agent_b')]);
    p.pause.mockImplementation(async (agentId: string) => {
      if (agentId === 'agent_b') throw { code: 'daemon-unavailable', message: 'the daemon is not running' };
      return { agentId, paused: true, stopped: false };
    });
    const { result } = renderHook(() => usePause(p));
    await waitFor(() => expect(p.list).toHaveBeenCalled());
    await act(() => result.current.toggle());
    expect(result.current.failure).toEqual({ action: 'pause', message: 'the daemon is not running' });

    const old = fake([soul('agent_a')]);
    old.pause.mockRejectedValue({ code: 'soul-pause-unsupported', message: 'this agent-bot has no soul pause' });
    const second = renderHook(() => usePause(old));
    await waitFor(() => expect(second.result.current.offered).toBe(true));
    await waitFor(() => expect(old.list).toHaveBeenCalled());
    await act(() => second.result.current.toggle());
    expect(second.result.current.offered).toBe(false);
    expect(second.result.current.failure).toBeNull();
  });

  it('does nothing without a pauser', () => {
    const { result } = renderHook(() => usePause(undefined));
    expect(result.current).toMatchObject({ offered: false, paused: false });
  });
});

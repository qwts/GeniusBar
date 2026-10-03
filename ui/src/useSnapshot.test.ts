import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSoulForest, type CensusRow } from './model/census';
import { sampleCensus, sampleConnection } from './model/fixtures';
import { disconnected, unpairedMessage, type ConnectionSnapshot } from './model/status';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const { snapshotReport, useSnapshot } = await import('./useSnapshot');

const forest = buildSoulForest(sampleCensus);

describe('snapshotReport', () => {
  it('waits while the bridge has not answered', () => {
    expect(snapshotReport(forest, disconnected, null)).toBeNull();
  });

  it('counts every soul, nested ones included', () => {
    expect(snapshotReport(forest, sampleConnection, null)).toEqual({ souls: 3, error: null });
    expect(snapshotReport(forest, sampleConnection, 'agent_c')).toEqual({ souls: 3, error: null });
  });

  it('reports what the popup shows as failing', () => {
    expect(snapshotReport([], { ...sampleConnection, unpaired: true }, null))
      .toEqual({ souls: 0, error: unpairedMessage });
    const unreachable = { ...sampleConnection, brokerUnreachable: true, lastError: 'down' };
    expect(snapshotReport(forest, unreachable, null)).toEqual({ souls: 3, error: 'down' });
    expect(snapshotReport(forest, sampleConnection, 'agent_x'))
      .toEqual({ souls: 3, error: "no soul with agent ID 'agent_x'" });
  });
});

describe('useSnapshot', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  interface Props { census: readonly CensusRow[]; connection: ConnectionSnapshot }

  function setup(detail: string | null, initial: Props) {
    const ready = vi.fn(async () => {});
    const refresh = vi.fn(async () => {});
    const hook = renderHook(({ census, connection }: Props) =>
      useSnapshot({ detail }, census, connection, refresh, { ready, retryMs: 500, settleMs: 100 }),
    { initialProps: initial });
    return { ...hook, ready, refresh };
  }

  it('retries the census until the bridge answers, then reports once', () => {
    const { rerender, ready, refresh } = setup(null, { census: [], connection: disconnected });
    act(() => { vi.advanceTimersByTime(500); });
    expect(refresh).toHaveBeenCalledOnce();
    expect(ready).not.toHaveBeenCalled();
    rerender({ census: sampleCensus, connection: sampleConnection });
    act(() => { vi.advanceTimersByTime(100); });
    expect(ready).toHaveBeenCalledExactlyOnceWith({ souls: 3, error: null });
    rerender({ census: sampleCensus, connection: { ...sampleConnection } });
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(ready).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('opens the requested detail before reporting', () => {
    const { result, ready } = setup('agent_c', { census: sampleCensus, connection: sampleConnection });
    expect(result.current).toBe('user/agent_c');
    expect(ready).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(100); });
    expect(ready).toHaveBeenCalledExactlyOnceWith({ souls: 3, error: null });
  });

  it('does nothing on a normal launch', () => {
    const ready = vi.fn(async () => {});
    const refresh = vi.fn(async () => {});
    const { result } = renderHook(() => useSnapshot(null, [], disconnected, refresh, { ready }));
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(result.current).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
  });
});

import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePerimeter } from './usePerimeter';

afterEach(() => cleanup());

describe('usePerimeter (#122)', () => {
  it('asks the shell on each change only, once enabled', async () => {
    const sync = vi.fn(async (_on: boolean) => true);
    const { rerender } = renderHook(({ driving, enabled }) => usePerimeter(driving, enabled, sync), {
      initialProps: { driving: true, enabled: false },
    });
    expect(sync).not.toHaveBeenCalled();
    rerender({ driving: true, enabled: true });
    await waitFor(() => expect(sync).toHaveBeenCalledWith(true));
    rerender({ driving: true, enabled: true });
    expect(sync).toHaveBeenCalledTimes(1);
    rerender({ driving: false, enabled: true });
    await waitFor(() => expect(sync).toHaveBeenCalledWith(false));
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('stops asking once the shell declines', async () => {
    const sync = vi.fn(async (_on: boolean) => false);
    const { rerender } = renderHook(({ driving }) => usePerimeter(driving, true, sync), { initialProps: { driving: true } });
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    rerender({ driving: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('sends the same state again after a failure', async () => {
    let fail = true;
    const sync = vi.fn(async (_on: boolean) => { if (fail) throw new Error('settling'); return true; });
    renderHook(() => usePerimeter(true, true, sync, 10));
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    fail = false;
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(2));
    expect(sync.mock.calls.every(([on]) => on === true)).toBe(true);
  });
});

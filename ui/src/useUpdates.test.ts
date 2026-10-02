import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const registered: { resolve: (stop: () => void) => void }[] = [];
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => new Promise((resolve) => { registered.push({ resolve }); })),
}));

const { useUpdates } = await import('./useUpdates');

afterEach(() => { cleanup(); registered.length = 0; });

describe('useUpdates', () => {
  it('removes a listener whose registration finishes after unmount', async () => {
    const { unmount } = renderHook(() => useUpdates(true));
    unmount();
    const stop = vi.fn();
    registered[0].resolve(stop);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('removes a registered listener on unmount', async () => {
    const { unmount } = renderHook(() => useUpdates(true));
    const stop = vi.fn();
    registered[0].resolve(stop);
    await Promise.resolve();
    expect(stop).not.toHaveBeenCalled();
    unmount();
    expect(stop).toHaveBeenCalledOnce();
  });
});

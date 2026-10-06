import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOUND_KEY, useChimes, useSound, type ChimeSignals } from './useSound';

describe('useSound (#122)', () => {
  beforeEach(() => localStorage.removeItem(SOUND_KEY));

  it('is off by default', () => {
    expect(renderHook(() => useSound()).result.current.sound).toBe(false);
  });

  it('remembers the choice as "1"/"0"', () => {
    const { result } = renderHook(() => useSound());
    act(() => result.current.setSound(true));
    expect(result.current.sound).toBe(true);
    expect(localStorage.getItem(SOUND_KEY)).toBe('1');
    expect(renderHook(() => useSound()).result.current.sound).toBe(true);
    act(() => result.current.setSound(false));
    expect(localStorage.getItem(SOUND_KEY)).toBe('0');
  });

  it('falls back to off when storage throws', () => {
    const get = vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const set = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const { result } = renderHook(() => useSound());
    expect(result.current.sound).toBe(false);
    act(() => result.current.setSound(true));
    expect(result.current.sound).toBe(true);
    get.mockRestore();
    set.mockRestore();
  });
});

describe('useChimes (#122)', () => {
  const none: ReadonlySet<string> = new Set();
  let hidden = false;
  beforeEach(() => {
    hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  });
  afterEach(() => vi.restoreAllMocks());

  const setup = (initial: ChimeSignals) => {
    const play = vi.fn();
    const hook = renderHook((s: ChimeSignals) => useChimes(s, play), { initialProps: initial });
    return { play, rerender: hook.rerender };
  };

  it('stays quiet on the first render', () => {
    const { play } = setup({ sound: true, waiting: 3, busy: new Set(['a']) });
    expect(play).not.toHaveBeenCalled();
  });

  it('plays "ask" when approvals rise, not when they fall', () => {
    const { play, rerender } = setup({ sound: true, waiting: 1, busy: none });
    rerender({ sound: true, waiting: 2, busy: none });
    expect(play).toHaveBeenCalledWith('ask');
    rerender({ sound: true, waiting: 0, busy: none });
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('plays "done" when a soul leaves the busy set', () => {
    const { play, rerender } = setup({ sound: true, waiting: 0, busy: none });
    rerender({ sound: true, waiting: 0, busy: new Set(['a']) });
    expect(play).not.toHaveBeenCalled();
    rerender({ sound: true, waiting: 0, busy: none });
    expect(play).toHaveBeenCalledWith('done');
  });

  it('plays one chime when both change at once', () => {
    const { play, rerender } = setup({ sound: true, waiting: 0, busy: new Set(['a']) });
    rerender({ sound: true, waiting: 1, busy: none });
    expect(play.mock.calls).toEqual([['ask']]);
  });

  it('stays quiet while muted or hidden', () => {
    const { play, rerender } = setup({ sound: false, waiting: 0, busy: new Set(['a']) });
    rerender({ sound: false, waiting: 1, busy: none });
    hidden = true;
    rerender({ sound: true, waiting: 2, busy: none });
    expect(play).not.toHaveBeenCalled();
  });

  it('yields to the window that answers it is showing, and plays otherwise', async () => {
    const showing = vi.fn(async () => true);
    const { play, rerender } = setup({ sound: true, waiting: 0, busy: none, yieldTo: showing });
    rerender({ sound: true, waiting: 1, busy: none, yieldTo: showing });
    await act(async () => {});
    expect(showing).toHaveBeenCalledOnce();
    expect(play).not.toHaveBeenCalled();
    const hidden = vi.fn(async () => false);
    rerender({ sound: true, waiting: 2, busy: none, yieldTo: hidden });
    await act(async () => {});
    expect(play.mock.calls).toEqual([['ask']]);
    const broken = vi.fn(async () => { throw new Error('no shell'); });
    rerender({ sound: true, waiting: 3, busy: none, yieldTo: broken });
    await act(async () => {});
    expect(play.mock.calls).toEqual([['ask'], ['ask']]);
    // Nothing to play asks nothing.
    rerender({ sound: true, waiting: 1, busy: none, yieldTo: showing });
    await act(async () => {});
    expect(showing).toHaveBeenCalledOnce();
  });

  it('never plays "done" without busy support', () => {
    const { play, rerender } = setup({ sound: true, waiting: 0, busy: none });
    rerender({ sound: true, waiting: 0, busy: new Set() });
    expect(play).not.toHaveBeenCalled();
  });
});

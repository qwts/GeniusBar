import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkSoulPackage, isSoulPackagePath, routeDroppedPackage, soulPackageIn, useSoulDrop, type DropEvent, type DropListener } from './soulPackage';

afterEach(cleanup);

/** A fake `onDragDropEvent`: `emit` plays an event, `unlistened` counts the cleanups. */
function fakeDrops() {
  let handler: ((event: { payload: DropEvent }) => void) | null = null;
  const state = { unlistened: 0 };
  const listen: DropListener = vi.fn(async (h) => { handler = h; return () => { state.unlistened += 1; handler = null; }; });
  const emit = (payload: DropEvent) => act(() => { handler?.({ payload }); });
  return { listen, emit, state, listening: () => handler !== null };
}

describe('dropped paths (#98)', () => {
  it('takes only absolute .soul packages, with or without Finder\'s trailing slash', () => {
    expect(isSoulPackagePath('/Users/me/Luna.soul')).toBe(true);
    expect(isSoulPackagePath('/Users/me/Luna.soul/')).toBe(true);
    expect(isSoulPackagePath('/Users/me/notes.txt')).toBe(false);
    expect(isSoulPackagePath('/Users/me/soul')).toBe(false);
    expect(isSoulPackagePath('Luna.soul')).toBe(false);
    expect(isSoulPackagePath('/Users/me/a\nb.soul')).toBe(false);
    expect(isSoulPackagePath(42)).toBe(false);
    expect(soulPackageIn(['/a/readme.md', '/a/Luna.soul', '/a/Bill.soul'])).toBe('/a/Luna.soul');
    expect(soulPackageIn(['/a/readme.md'])).toBeNull();
    expect(soulPackageIn('nope')).toBeNull();
  });
});

describe('useSoulDrop (#98)', () => {
  it('shows the cue while a .soul hovers and hands over the dropped package', async () => {
    const drops = fakeDrops();
    const onPackage = vi.fn();
    const { result, unmount } = renderHook(() => useSoulDrop(onPackage, drops.listen));
    await vi.waitFor(() => expect(drops.listening()).toBe(true));
    expect(result.current).toBe(false);
    drops.emit({ type: 'enter', paths: ['/a/Luna.soul/'] });
    expect(result.current).toBe(true);
    drops.emit({ type: 'over' });
    expect(result.current).toBe(true);
    drops.emit({ type: 'drop', paths: ['/a/Luna.soul/'] });
    expect(result.current).toBe(false);
    expect(onPackage).toHaveBeenCalledWith('/a/Luna.soul/');
    unmount();
    expect(drops.state.unlistened).toBe(1);
  });

  it('ignores drags and drops without a .soul, and a drag that leaves', async () => {
    const drops = fakeDrops();
    const onPackage = vi.fn();
    const { result } = renderHook(() => useSoulDrop(onPackage, drops.listen));
    await vi.waitFor(() => expect(drops.listening()).toBe(true));
    drops.emit({ type: 'enter', paths: ['/a/photo.png'] });
    expect(result.current).toBe(false);
    drops.emit({ type: 'drop', paths: ['/a/photo.png', '/a/run.sh'] });
    expect(onPackage).not.toHaveBeenCalled();
    drops.emit({ type: 'enter', paths: ['/a/Luna.soul'] });
    drops.emit({ type: 'leave' });
    expect(result.current).toBe(false);
    expect(onPackage).not.toHaveBeenCalled();
  });

  it('does not listen without a handler', () => {
    const drops = fakeDrops();
    renderHook(() => useSoulDrop(null, drops.listen));
    expect(drops.listen).not.toHaveBeenCalled();
  });
});

describe('routeDroppedPackage (#98)', () => {
  it('opens the launch window with the package and hides the popup behind it', async () => {
    const open = vi.fn(async () => {});
    const show = vi.fn();
    const opened = vi.fn();
    await routeDroppedPackage('/a/Luna.soul', { open, show, opened });
    expect(open).toHaveBeenCalledWith({ surface: 'launch', package: '/a/Luna.soul' });
    expect(opened).toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
  });

  it('shows it here, as Finder does, without native windows or when the shell has none', async () => {
    const show = vi.fn();
    await routeDroppedPackage('/a/Luna.soul', { open: null, show });
    expect(show).toHaveBeenCalledWith('/a/Luna.soul');
    const refused = vi.fn();
    await routeDroppedPackage('/a/Bill.soul', { open: async () => { throw new Error('no windows'); }, show, opened: refused });
    expect(show).toHaveBeenLastCalledWith('/a/Bill.soul');
    expect(refused).not.toHaveBeenCalled();
  });
});

describe('checkSoulPackage (shared by Finder and drops)', () => {
  const invoker = (answers: Record<string, unknown>) => vi.fn(async (command: string) => {
    const answer = answers[command];
    if (answer instanceof Error) throw answer;
    return answer;
  }) as never;

  it('prefills from a package\'s soul.json', async () => {
    const invoke = invoker({ validate_soul_package: null,
      locate_soul_package: { status: 'package', name: 'Luna - Starter', description: 'Helps.', preferredHarnesses: ['opencode', 3] } });
    expect(await checkSoulPackage('/a/Luna.soul', invoke)).toEqual({ error: null, name: 'Luna - Starter', description: 'Helps.', preferredHarnesses: ['opencode'] });
  });

  it('names an installed soul, a copy, and a refusal', async () => {
    expect(await checkSoulPackage('/a', invoker({ validate_soul_package: null, locate_soul_package: { status: 'installed', agentId: 'agent_p' } })))
      .toEqual({ error: null, agentId: 'agent_p' });
    expect(await checkSoulPackage('/a', invoker({ validate_soul_package: null, locate_soul_package: { status: 'copy', agentId: 'agent_p', name: 'Luna' } })))
      .toEqual({ error: null, copyOf: { agentId: 'agent_p', name: 'Luna' } });
    expect(await checkSoulPackage('/a', invoker({ validate_soul_package: null, locate_soul_package: { status: 'duplicate', message: 'Two folders claim it.' } })))
      .toEqual({ error: 'Two folders claim it.' });
  });

  it('keeps the package flow without `soul locate`, and says when the shell cannot read it', async () => {
    expect(await checkSoulPackage('/a', invoker({ validate_soul_package: null, locate_soul_package: new Error('unknown command') })))
      .toEqual({ error: null });
    expect((await checkSoulPackage('/a', invoker({ validate_soul_package: new Error('no soul.json') }))).error)
      .toMatch(/couldn’t read this companion package/);
  });
});

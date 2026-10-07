import { describe, expect, it } from 'vitest';
import { PhysicalPosition } from '@tauri-apps/api/window';
import { BridgeError, currentWindow, openSurface, syncTeamWindows, type TauriWindowLike } from './bridge';

describe('native window surfaces (#223)', () => {
  it('asks the shell to open a surface, and rejects outside the app', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => { calls.push([cmd, args]); }) as never;
    await openSurface({ surface: 'session', soul: 'user/agent_p', tab: 'delegation', action: 'archive' }, fake);
    await openSurface({ surface: 'launch' }, fake);
    expect(calls).toEqual([
      ['open_surface', { surface: 'session', soul: 'user/agent_p', tab: 'delegation', action: 'archive' }],
      ['open_surface', { surface: 'launch', soul: undefined, tab: undefined, action: undefined }],
    ]);
    await expect(openSurface({ surface: 'audit' })).rejects.toBeInstanceOf(BridgeError);
    const failing = (async () => { throw 'snapshot'; }) as never;
    await expect(openSurface({ surface: 'audit' }, failing)).rejects.toBe('snapshot');
  });

  it('passes a dropped package to the launch window (#98)', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => { calls.push([cmd, args]); }) as never;
    await openSurface({ surface: 'launch', package: '/souls/Luna.soul' }, fake);
    expect(calls).toEqual([['open_surface', { surface: 'launch', soul: undefined, tab: undefined, action: undefined, package: '/souls/Luna.soul' }]]);
  });

  it('syncs team windows: true only when the shell says so', async () => {
    const calls: unknown[] = [];
    const teams = [{ key: 'user/agent_p', x: 10, y: 20, width: 300, height: 176 }];
    const yes = (async (cmd: string, args: unknown) => { calls.push([cmd, args]); return true; }) as never;
    await expect(syncTeamWindows(teams, yes)).resolves.toBe(true);
    expect(calls).toEqual([['sync_team_windows', { teams }]]);
    await expect(syncTeamWindows(teams, (async () => false) as never)).resolves.toBe(false);
    // An older shell without the command, or one whose capabilities refuse it, cannot; any other failure is retried later.
    await expect(syncTeamWindows(teams, (async () => { throw new Error('Command sync_team_windows not found'); }) as never)).resolves.toBe(false);
    await expect(syncTeamWindows(teams, (async () => { throw 'sync_team_windows not allowed. Permissions associated with this command: ...'; }) as never)).resolves.toBe(false);
    await expect(syncTeamWindows(teams, (async () => { throw 'team windows not created: user/lead: window server refused'; }) as never))
      .rejects.toMatchObject({ code: 'sync-failed', message: 'team windows not created: user/lead: window server refused' });
    await expect(syncTeamWindows(teams)).resolves.toBe(false);
  });

  it('wraps this web view\'s window in logical points, and is null outside the app', async () => {
    expect(currentWindow()).toBeNull();
    const log: unknown[] = [];
    let moved: (() => void) | undefined;
    const fake: TauriWindowLike = {
      close: async () => { log.push('close'); },
      hide: async () => { log.push('hide'); },
      setSize: async (size) => { log.push(['size', size]); },
      outerPosition: async () => new PhysicalPosition(200, 100),
      onMoved: async (handler) => { moved = () => handler({ event: 'tauri://move', id: 1, payload: new PhysicalPosition(0, 0) }); return () => log.push('unlisten'); },
      setTitle: async (title) => { log.push(['title', title]); },
    };
    const original = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    try {
      const w = currentWindow(() => fake)!;
      await w.setSize(300, 120);
      expect(log.at(-1)).toEqual(['size', expect.objectContaining({ width: 300, height: 120, type: 'Logical' })]);
      await expect(w.position()).resolves.toEqual({ x: 100, y: 50 });
      let count = 0;
      const stop = await w.onMoved(() => { count += 1; });
      moved?.();
      expect(count).toBe(1);
      stop();
      await w.close();
      await w.hide();
      await w.setTitle('luna — GeniusBar');
      expect(log.slice(-4)).toEqual(['unlisten', 'close', 'hide', ['title', 'luna — GeniusBar']]);
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { value: original, configurable: true });
    }
  });
});

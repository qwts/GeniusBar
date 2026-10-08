import { describe, expect, it, vi } from 'vitest';
import { aboutInfo, aboutRunning, normalizeAboutInfo, normalizeAboutRunning, openInBrowser } from './bridge';

describe('about info (#290)', () => {
  it('keeps the shell’s app, bundle and OS values, with nothing made up for a missing one', () => {
    expect(normalizeAboutInfo({
      app: { name: 'GeniusBar', version: '0.1.58', build: '0.1.58' },
      bundled: { 'agent-bot': { version: '0.10.49', ref: 'a5e7e7b3de48' }, 'agent-comms': { version: null, ref: null }, 'npm': 'x' },
      os: { name: 'macOS', version: '26.0' },
    })).toEqual({
      app: { name: 'GeniusBar', version: '0.1.58', build: '0.1.58' },
      bundled: { 'agent-bot': { version: '0.10.49', ref: 'a5e7e7b3de48' }, 'agent-comms': { version: null, ref: null } },
      os: { name: 'macOS', version: '26.0' },
    });
    // The build falls back to the version, the OS name to a plain unknown; empty strings are nulls.
    expect(normalizeAboutInfo({ app: { version: '0.1.58', build: '' }, os: { version: '' } })).toEqual({
      app: { name: 'GeniusBar', version: '0.1.58', build: '0.1.58' },
      bundled: {},
      os: { name: 'Unknown OS', version: null },
    });
    for (const raw of [null, 'x', {}, { app: {} }, { app: { version: '' } }, { app: { version: 1 } }]) {
      expect(normalizeAboutInfo(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it('reads the shell’s about_info, and is null outside the app or when the call fails', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string) => { calls.push(cmd); return { app: { name: 'GeniusBar', version: '0.1.58' } }; }) as never;
    await expect(aboutInfo(fake)).resolves.toMatchObject({ app: { version: '0.1.58', build: '0.1.58' } });
    expect(calls).toEqual(['about_info']);
    await expect(aboutInfo((async () => { throw new Error('not found'); }) as never)).resolves.toBeNull();
    await expect(aboutInfo()).resolves.toBeNull();
  });

  it('keeps the engines’ running answers, each nullable', () => {
    expect(normalizeAboutRunning({ 'agent-bot': { running: true, version: '0.10.49' }, 'agent-comms': { version: '0.3.14' } }))
      .toEqual({ 'agent-bot': { running: true, version: '0.10.49' }, 'agent-comms': { version: '0.3.14' } });
    expect(normalizeAboutRunning({ 'agent-bot': { running: 'yes', version: '' } }))
      .toEqual({ 'agent-bot': { running: false, version: null }, 'agent-comms': { version: null } });
    expect(normalizeAboutRunning(null)).toBeNull();
  });

  it('reads the shell’s about_running, null outside the app or on a failure', async () => {
    const fake = (async () => ({ 'agent-bot': { running: false, version: null }, 'agent-comms': { version: '0.3.14' } })) as never;
    await expect(aboutRunning(fake)).resolves.toEqual({ 'agent-bot': { running: false, version: null }, 'agent-comms': { version: '0.3.14' } });
    await expect(aboutRunning((async () => { throw new Error('down'); }) as never)).resolves.toBeNull();
    await expect(aboutRunning()).resolves.toBeNull();
  });

  it('opens a link through the shell’s allow-listed opener, and relays its refusal', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => { calls.push([cmd, args]); }) as never;
    await expect(openInBrowser('https://github.com/qwts/GeniusBar/releases', fake)).resolves.toBeUndefined();
    expect(calls).toEqual([['identity_app_open', { url: 'https://github.com/qwts/GeniusBar/releases' }]]);
    const refusing = (async () => { throw { code: 'identity-app-invalid', message: 'only github.com can be opened' }; }) as never;
    await expect(openInBrowser('https://example.com', refusing)).rejects.toMatchObject({ code: 'identity-app-invalid', message: 'only github.com can be opened' });
  });

  it('outside the app, opens the link in a new tab', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await openInBrowser('https://github.com/qwts/GeniusBar/issues/new/choose');
    expect(open).toHaveBeenCalledWith('https://github.com/qwts/GeniusBar/issues/new/choose', '_blank', 'noopener');
    open.mockRestore();
  });
});

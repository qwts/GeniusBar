import { describe, expect, it } from 'vitest';
import { checkingHost, devBuild, firstNotReady, hostChecking, hostReady, normalizeHostCapabilities, unknownHost, type HostCapabilities } from './host';

const windows: HostCapabilities = {
  platform: 'windows',
  tools: [
    { id: 'git', bundled: true, state: 'ready', message: null },
    { id: 'node', bundled: true, state: 'ready', message: null },
    { id: 'cli', bundled: true, state: 'ready', message: null },
  ],
  build: { signed: false, updater: false },
};

describe('host capabilities (#46)', () => {
  it('keeps the shell’s platform, tools and build facts, with nothing made up', () => {
    expect(normalizeHostCapabilities({
      platform: 'windows',
      tools: [
        { id: 'git', bundled: true, state: 'ready', message: null },
        { id: 'node', bundled: true, state: 'failed', message: 'node.exe exited with code 1' },
        { id: 'cli', bundled: true, state: 'missing', message: '' },
      ],
      build: { signed: false, updater: false },
    })).toEqual({
      platform: 'windows',
      tools: [
        { id: 'git', bundled: true, state: 'ready', message: null },
        { id: 'node', bundled: true, state: 'failed', message: 'node.exe exited with code 1' },
        { id: 'cli', bundled: true, state: 'missing', message: null },
      ],
      build: { signed: false, updater: false },
    });
  });

  it('drops a tool it does not know, never invents a state, and leaves unknown build facts null', () => {
    expect(normalizeHostCapabilities({
      platform: 'plan9',
      tools: [
        { id: 'git', bundled: 'yes', state: 'checking' },
        { id: 'perl', state: 'ready' },
        { id: 'node', bundled: true, state: 'ready' },
        { id: 'node', bundled: true, state: 'failed', message: 'twice' },
        'x',
      ],
      build: { signed: 'no' },
    })).toEqual({
      platform: 'unknown',
      tools: [{ id: 'node', bundled: true, state: 'ready', message: null }],
      build: { signed: null, updater: null },
    });
    for (const raw of [null, 'x', {}, { platform: 1 }, []]) expect(normalizeHostCapabilities(raw), JSON.stringify(raw)).toBeNull();
    expect(normalizeHostCapabilities({ platform: 'macos' })).toEqual({ platform: 'macos', tools: [], build: { signed: null, updater: null } });
  });

  it('is ready only when git, Node and the command-line tools all are', () => {
    expect(hostReady(windows)).toBe(true);
    expect(firstNotReady(windows)).toBeNull();
    const missing: HostCapabilities = { ...windows, tools: windows.tools.map((t) => (t.id === 'cli' ? { ...t, state: 'missing' } : t)) };
    expect(hostReady(missing)).toBe(false);
    expect(firstNotReady(missing)?.id).toBe('cli');
    // The design's order decides which row Retry focuses.
    const two: HostCapabilities = { ...windows, tools: windows.tools.map((t) => (t.id === 'git' ? { ...t, state: 'failed', message: 'x' } : t.id === 'cli' ? { ...t, state: 'missing' } : t)) };
    expect(firstNotReady(two)?.id).toBe('git');
    // A tool the shell left out is not ready.
    expect(hostReady({ ...windows, tools: windows.tools.slice(1) })).toBe(false);
    expect(hostReady(unknownHost)).toBe(false);
  });

  it('puts every tool back to checking for a re-probe', () => {
    const failed: HostCapabilities = { ...windows, tools: windows.tools.map((t) => ({ ...t, state: 'failed', message: 'x' })) };
    const checking = checkingHost(failed);
    expect(checking.tools.every((t) => t.state === 'checking' && t.message === null)).toBe(true);
    expect(hostChecking(checking)).toBe(true);
    expect(hostChecking(windows)).toBe(false);
    expect(checking.platform).toBe('windows');
    expect(checking.build).toEqual(failed.build);
  });

  it('calls a build a development build only when the host says unsigned or no updater', () => {
    expect(devBuild(windows)).toBe(true);
    expect(devBuild({ ...windows, build: { signed: true, updater: true } })).toBe(false);
    expect(devBuild({ ...windows, build: { signed: true, updater: false } })).toBe(true);
    expect(devBuild({ ...windows, build: { signed: null, updater: true } })).toBe(false);
    expect(devBuild(unknownHost)).toBe(false);
  });
});

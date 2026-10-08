import { describe, expect, it } from 'vitest';
import { hostCapabilities } from './bridge';

describe('host capabilities (#46)', () => {
  it('reads the shell’s host_capabilities with its shape checked, and is null when the call fails or outside the app', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string) => {
      calls.push(cmd);
      return { platform: 'windows', tools: [{ id: 'git', bundled: true, state: 'missing', message: null }], build: { signed: false, updater: false } };
    }) as never;
    await expect(hostCapabilities(fake)).resolves.toEqual({
      platform: 'windows',
      tools: [{ id: 'git', bundled: true, state: 'missing', message: null }],
      build: { signed: false, updater: false },
    });
    expect(calls).toEqual(['host_capabilities']);
    const failing = (async () => { throw new Error('no such command'); }) as never;
    await expect(hostCapabilities(failing)).resolves.toBeNull();
    const malformed = (async () => 'x') as never;
    await expect(hostCapabilities(malformed)).resolves.toBeNull();
    await expect(hostCapabilities()).resolves.toBeNull();
  });
});

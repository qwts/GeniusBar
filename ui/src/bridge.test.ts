import { describe, expect, it } from 'vitest';
import { BridgeError, call, inApp } from './bridge';

describe('bridge', () => {
  it('invokes the shell command with the method and params', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => { calls.push([cmd, args]); return { souls: [] }; }) as never;
    await expect(call('census', {}, fake)).resolves.toEqual({ souls: [] });
    expect(calls).toEqual([['bridge', { method: 'census', params: {} }]]);
  });

  it('turns shell errors into BridgeError with their code', async () => {
    const fake = (async () => { throw { code: 'broker-unreachable', message: 'down' }; }) as never;
    const error = await call('census', {}, fake).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({ code: 'broker-unreachable', message: 'down' });
  });

  it('is not in the app under test', () => {
    expect(inApp()).toBe(false);
  });
});

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BridgeError } from './bridge';
import { useLaunch } from './useLaunch';

afterEach(cleanup);

const request = { account: 'user', target: { soul: 'agent_1' }, harness: 'codex', name: '' };

describe('useLaunch', () => {
  it('requests once and polls status until the daemon reports', async () => {
    const calls: string[] = [];
    const statuses = [{ status: 'pending' }, { status: 'launched', agentId: 'agent_1' }];
    const callImpl = (async (method: string) => {
      calls.push(method);
      if (method === 'launch') return { ok: true, requestId: 'launch_1', status: 'pending', agentId: null };
      return { ok: true, requestId: 'launch_1', ...statuses.shift() };
    }) as never;
    const { result } = renderHook(() => useLaunch({ callImpl, pollMs: 5 }));
    await act(() => result.current.launch(request));
    expect(result.current.state).toMatchObject({ phase: 'pending', requestId: 'launch_1' });
    await act(() => result.current.launch(request)); // ignored while unresolved
    await waitFor(() => expect(result.current.state).toEqual({ phase: 'launched', requestId: 'launch_1', agentId: 'agent_1' }));
    expect(calls).toEqual(['launch', 'launchStatus', 'launchStatus']);
  });

  it('shows a refused launch inline and never retries it', async () => {
    const calls: string[] = [];
    const callImpl = (async (method: string) => {
      calls.push(method);
      throw new BridgeError('daemon-unavailable', 'no daemon');
    }) as never;
    const { result } = renderHook(() => useLaunch({ callImpl, pollMs: 5 }));
    await act(() => result.current.launch(request));
    expect(result.current.state).toMatchObject({ phase: 'error', text: expect.stringMatching(/can’t reach the agents on account user/i) });
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual(['launch']);
  });

  it('rejects an invalid request without calling the bridge', async () => {
    let called = false;
    const callImpl = (async () => { called = true; }) as never;
    const { result } = renderHook(() => useLaunch({ callImpl }));
    await act(() => result.current.launch({ ...request, harness: '' }));
    expect(result.current.state).toMatchObject({ phase: 'error', text: 'Enter a harness.' });
    expect(called).toBe(false);
  });
});

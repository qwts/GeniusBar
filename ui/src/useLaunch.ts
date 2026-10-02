// Launching souls (#18): sends one launch request, then polls its status
// until the daemon reports. A launch is never resent: each call to the
// broker is a new request, so an uncertain response is shown, not retried.
import { useCallback, useEffect, useRef, useState } from 'react';
import { BridgeError, call } from './bridge';
import {
  applyStatus,
  applyStatusError,
  canLaunch,
  idleLaunch,
  launchErrorText,
  launchParams,
  launchProblem,
  type LaunchRequest,
  type LaunchState,
} from './model/launch';

export const LAUNCH_POLL_MS = 2_000;

const asBridgeError = (error: unknown) =>
  error instanceof BridgeError ? error : new BridgeError('bridge-error', String(error));

export interface LaunchApi {
  state: LaunchState;
  launch: (request: LaunchRequest) => Promise<void>;
  /** Back to idle once the result has been seen; not while unresolved. */
  reset: () => void;
}

export function useLaunch({ callImpl = call, pollMs = LAUNCH_POLL_MS }:
  { callImpl?: typeof call; pollMs?: number } = {}): LaunchApi {
  const [state, setState] = useState<LaunchState>(idleLaunch);
  const current = useRef<LaunchState>(idleLaunch);
  const set = useCallback((next: LaunchState) => {
    current.current = next;
    setState(next);
  }, []);
  const deps = useRef(callImpl);
  deps.current = callImpl;

  const launch = useCallback(async (request: LaunchRequest) => {
    if (!canLaunch(current.current)) return;
    const problem = launchProblem(request);
    if (problem) {
      set({ phase: 'error', requestId: null, text: problem });
      return;
    }
    set({ phase: 'requesting' });
    try {
      const result = await deps.current<{ requestId?: unknown }>('launch', launchParams(request));
      if (typeof result?.requestId !== 'string') {
        set({ phase: 'error', requestId: null, text: launchErrorText('bad-response', 'launch returned no request id') });
        return;
      }
      set({ phase: 'pending', requestId: result.requestId, note: null });
    } catch (error) {
      const e = asBridgeError(error);
      set({ phase: 'error', requestId: null, text: launchErrorText(e.code, e.message, request.account) });
    }
  }, [set]);

  // Poll while pending; one status read at a time, stopped on unmount.
  const requestId = state.phase === 'pending' ? state.requestId : null;
  useEffect(() => {
    if (requestId === null) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const result = await deps.current('launchStatus', { requestId });
        if (!stopped) set(applyStatus(current.current, result));
      } catch (error) {
        const e = asBridgeError(error);
        if (!stopped) set(applyStatusError(current.current, e.code, e.message));
      }
      if (!stopped && current.current.phase === 'pending') timer = setTimeout(() => { void check(); }, pollMs);
    };
    timer = setTimeout(() => { void check(); }, pollMs);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [requestId, pollMs, set]);

  const reset = useCallback(() => {
    if (canLaunch(current.current)) set(idleLaunch);
  }, [set]);

  return { state, launch, reset };
}

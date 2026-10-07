// The popup's coordinator for the computer-use perimeter (#122): Lovable
// draws an orange border around the screen and a Stop pill while a soul
// drives the computer. In the app the popup is hidden most of the time, so
// the border and the pill are windows of their own over the real screen;
// the popup, which reads the daemon's `computerUse` set, tells the shell
// when they should exist.
import { useEffect, useRef, useState } from 'react';
import { shellLog, syncPerimeter } from './bridge';

/** After a failed sync, the wait before the same state is sent again. */
export const PERIMETER_RETRY_MS = 2_000;

/**
 * Keeps the perimeter windows in step with `driving` while `enabled` (the
 * live tray popup). Calls only on a change. The first `false` means this
 * shell keeps the in-popup perimeter: it stops asking for the rest of the
 * run. A failed call is sent again after a short wait.
 */
export function usePerimeter(driving: boolean, enabled: boolean,
  sync: (on: boolean) => Promise<boolean> = syncPerimeter, retryMs = PERIMETER_RETRY_MS): void {
  const off = useRef(false);
  const sent = useRef<boolean | null>(null);
  const [attempt, setAttempt] = useState(0);
  const call = useRef(sync);
  call.current = sync;
  useEffect(() => {
    if (!enabled || off.current || sent.current === driving) return;
    let stale = false;
    const send = () => {
      sent.current = driving;
      shellLog(`perimeter: ${driving ? 'on' : 'off'}`);
      call.current(driving).then(
        (used) => {
          if (!used) {
            off.current = true;
            shellLog('perimeter: the shell declined; off for this run');
          }
        },
        (error: unknown) => {
          shellLog(`perimeter failed: ${error instanceof Error ? error.message : String(error)}`);
          if (stale) return;
          sent.current = null;
          timer = setTimeout(() => setAttempt((n) => n + 1), retryMs);
        },
      );
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    send();
    return () => { stale = true; clearTimeout(timer); };
  }, [driving, enabled, retryMs, attempt]);
}

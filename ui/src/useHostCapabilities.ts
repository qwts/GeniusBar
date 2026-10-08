// What this computer can do before the first launch (#46), read from the
// shell once on mount and again on Retry. Null until the shell has
// answered; when it cannot answer, `unknownHost`, so nothing is claimed.
import { useCallback, useEffect, useRef, useState } from 'react';
import { hostCapabilities, inApp } from './bridge';
import { checkingHost, unknownHost, type HostCapabilities } from './model/host';

export function useHostCapabilities(enabled: boolean = inApp()): { host: HostCapabilities | null; recheck: () => void } {
  const [host, setHost] = useState<HostCapabilities | null>(null);
  // Only the latest probe's answer lands; an older one is dropped.
  const sequence = useRef(0);
  const recheck = useCallback(() => {
    if (!enabled) return;
    const id = ++sequence.current;
    // While a re-probe runs, the rows say so rather than keep a stale answer.
    setHost((current) => (current ? checkingHost(current) : current));
    void hostCapabilities().then((next) => { if (sequence.current === id) setHost(next ?? unknownHost); });
  }, [enabled]);
  useEffect(() => {
    recheck();
    return () => { sequence.current += 1; };
  }, [recheck]);
  return { host, recheck };
}

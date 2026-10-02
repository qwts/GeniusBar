// Polls the census through the bridge every 5 seconds, as R1 did, and
// keeps the last successful rows on screen through an outage.
import { useCallback, useEffect, useRef, useState } from 'react';
import { BridgeError, call, inApp } from './bridge';
import type { CensusRow } from './model/census';
import { applyCensus, type CensusOutcome } from './model/refresh';
import { disconnected, type ConnectionSnapshot } from './model/status';

export const CENSUS_INTERVAL_MS = 5_000;

export async function fetchCensus(callImpl: typeof call = call): Promise<CensusOutcome> {
  try {
    const { souls } = await callImpl<{ souls: CensusRow[] }>('census');
    return { ok: true, souls };
  } catch (error) {
    const e = error instanceof BridgeError ? error : new BridgeError('bridge-error', String(error));
    return { ok: false, code: e.code, message: e.message };
  }
}

export function useCensus(enabled: boolean = inApp()) {
  const [census, setCensus] = useState<readonly CensusRow[]>([]);
  const [connection, setConnection] = useState<ConnectionSnapshot>(disconnected);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const outcome = await fetchCensus();
      if (outcome.ok) setCensus(outcome.souls);
      setConnection((prev) => applyCensus(prev, outcome, new Date()));
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, CENSUS_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled, refresh]);

  return { census, connection, refresh: enabled ? refresh : undefined };
}

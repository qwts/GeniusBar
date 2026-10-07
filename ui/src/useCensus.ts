// Polls the census through the bridge every 5 seconds, as R1 did, and
// keeps the last successful rows on screen through an outage.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BridgeError, call, inApp, populationList, servicesInstalled, type PopulationEntry } from './bridge';
import { withoutArchived, type CensusRow } from './model/census';
import { applyCensus, type CensusOutcome } from './model/refresh';
import { disconnected, type ConnectionSnapshot } from './model/status';

export const CENSUS_INTERVAL_MS = 5_000;
/** How often the roster re-reads which souls are archived (#196); an explicit refresh reads at once. */
export const POPULATION_INTERVAL_MS = 60_000;

export async function fetchCensus(callImpl: typeof call = call): Promise<CensusOutcome> {
  try {
    const { souls } = await callImpl<{ souls: CensusRow[] }>('census');
    return { ok: true, souls };
  } catch (error) {
    const e = error instanceof BridgeError ? error : new BridgeError('bridge-error', String(error));
    return { ok: false, code: e.code, message: e.message };
  }
}

/**
 * Whether a failed census found GeniusBar's services installed (#118), so
 * a broker that is slow after login reads as starting. Asked only after a
 * failure that reached the bridge; the check is a file test in the shell.
 */
export async function brokerInstalled(outcome: CensusOutcome,
  check: typeof servicesInstalled = servicesInstalled): Promise<boolean> {
  if (outcome.ok || outcome.code.startsWith('bridge-')) return false;
  return (await check())?.broker ?? false;
}

export function useCensus(enabled: boolean = inApp(), population: () => Promise<PopulationEntry[] | null> = populationList) {
  const [rows, setRows] = useState<readonly CensusRow[]>([]);
  const [archivedBy, setArchivedBy] = useState<PopulationEntry[] | null>(null);
  // Whether agent-bot's population has been read once (#223): until then
  // the rows may still hold archived souls, and a native team window for
  // one would appear only to close a moment later.
  const [populationRead, setPopulationRead] = useState(false);
  const [connection, setConnection] = useState<ConnectionSnapshot>(disconnected);
  const inFlight = useRef(false);
  const readPopulation = useRef(population);
  readPopulation.current = population;

  // The hub's rows, and (less often, it is an agent-bot run) which of them
  // agent-bot has archived (#196). An explicit refresh, such as after an
  // archive, reads both so the row goes at once.
  const refresh = useCallback(async ({ archived = true }: { archived?: boolean } = {}) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const outcome = await fetchCensus();
      const installed = await brokerInstalled(outcome);
      if (outcome.ok) setRows(outcome.souls);
      setConnection((prev) => applyCensus(prev, outcome, new Date(), installed));
      if (archived) {
        const list = await readPopulation.current().catch(() => null);
        if (list) setArchivedBy(list);
        setPopulationRead(true);
      }
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      void refresh({ archived: ticks % Math.max(1, Math.round(POPULATION_INTERVAL_MS / CENSUS_INTERVAL_MS)) === 0 });
    }, CENSUS_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled, refresh]);

  const census = useMemo(() => withoutArchived(rows, archivedBy), [rows, archivedBy]);
  const refreshAll = useCallback(() => refresh(), [refresh]);
  return { census, connection, refresh: enabled ? refreshAll : undefined, settled: !enabled || populationRead };
}

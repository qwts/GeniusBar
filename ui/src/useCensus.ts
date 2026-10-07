// Polls the census through the bridge every 5 seconds, as R1 did, and
// keeps the last successful rows on screen through an outage.
//
// The app's windows share one census (#223): the popup publishes each
// outcome to the web view's storage, which every native window shares,
// and a surface window follows it instead of polling the bridge itself,
// so N team cards are not N census pollers. A follower polls on its own
// only while the stored census is stale (the popup gone or asleep).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BridgeError, call, inApp, populationList, servicesInstalled, shellLog, type PopulationEntry } from './bridge';
import { withoutArchived, type CensusRow } from './model/census';
import { applyCensus, type CensusOutcome } from './model/refresh';
import { disconnected, type ConnectionSnapshot } from './model/status';

export const CENSUS_INTERVAL_MS = 5_000;
/** How often the roster re-reads which souls are archived (#196); an explicit refresh reads at once. */
export const POPULATION_INTERVAL_MS = 60_000;
/** Where the popup keeps its last census for the other windows. */
export const CENSUS_STORAGE_KEY = 'geniusbar.census';
/** A stored census older than this has no live publisher behind it, so a follower polls itself. */
export const CENSUS_STALE_MS = 3 * CENSUS_INTERVAL_MS;

/**
 * How a window takes part in the shared census: `poll` reads the bridge
 * itself and tells no one (the default, and what a snapshot or test does);
 * `publish` polls and stores each outcome; `follow` shows what the
 * publisher stored and polls only while that is stale.
 */
export type CensusShare = 'poll' | 'publish' | 'follow';

export type CensusStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): CensusStorage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/** One census as the popup stores it: the hook's state with its dates as ISO strings. */
export interface StoredCensus {
  /** When it was stored, `Date.now()`; a follower compares it with its own clock. */
  at: number;
  rows: readonly CensusRow[];
  archivedBy: PopulationEntry[] | null;
  populationRead: boolean;
  connection: Omit<ConnectionSnapshot, 'lastRefresh' | 'failingSince'> & { lastRefresh: string | null; failingSince?: string | null };
}

interface CensusState {
  rows: readonly CensusRow[];
  archivedBy: PopulationEntry[] | null;
  populationRead: boolean;
  connection: ConnectionSnapshot;
}

export function toStored(state: CensusState, at: number): StoredCensus {
  const { lastRefresh, failingSince, ...rest } = state.connection;
  return { at, rows: state.rows, archivedBy: state.archivedBy, populationRead: state.populationRead,
    connection: { ...rest, lastRefresh: lastRefresh?.toISOString() ?? null, failingSince: failingSince?.toISOString() ?? null } };
}

/** The stored census, or null when there is none or it does not parse. */
export function fromStored(raw: string | null): StoredCensus | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const s = parsed as Partial<StoredCensus>;
    if (typeof s.at !== 'number' || !Array.isArray(s.rows) || typeof s.connection !== 'object' || s.connection === null) return null;
    return { at: s.at, rows: s.rows, archivedBy: Array.isArray(s.archivedBy) ? s.archivedBy : null,
      populationRead: s.populationRead === true, connection: s.connection };
  } catch {
    return null;
  }
}

function revive(stored: StoredCensus): CensusState {
  const { lastRefresh, failingSince, ...rest } = stored.connection;
  return { rows: stored.rows, archivedBy: stored.archivedBy, populationRead: stored.populationRead,
    connection: { ...disconnected, ...rest, lastRefresh: lastRefresh ? new Date(lastRefresh) : null,
      failingSince: failingSince ? new Date(failingSince) : null } };
}

/** Whether a stored census is recent enough to show instead of polling. */
export function fresh(stored: StoredCensus | null, now: number): boolean {
  return stored !== null && now - stored.at <= CENSUS_STALE_MS;
}

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

export interface CensusOptions {
  share?: CensusShare;
  /** Where a published census goes and a followed one comes from; the web view's local storage by default. */
  storage?: CensusStorage | null;
  now?: () => number;
}

export function useCensus(enabled: boolean = inApp(), population: () => Promise<PopulationEntry[] | null> = populationList,
  { share = 'poll', storage = defaultStorage(), now = Date.now }: CensusOptions = {}) {
  const [rows, setRows] = useState<readonly CensusRow[]>([]);
  const [archivedBy, setArchivedBy] = useState<PopulationEntry[] | null>(null);
  // Whether agent-bot's population has been read once (#223): until then
  // the rows may still hold archived souls, and a native team window for
  // one would appear only to close a moment later.
  const [populationRead, setPopulationRead] = useState(false);
  const [connection, setConnection] = useState<ConnectionSnapshot>(disconnected);
  // The same state outside React's batching, so a publish stores what one
  // refresh produced and a follower's adopt starts from what it last saw.
  const state = useRef<CensusState>({ rows: [], archivedBy: null, populationRead: false, connection: disconnected });
  const inFlight = useRef(false);
  // The last census and population outcomes, so `shell.log` gets each change once (#223).
  const logged = useRef<{ census: string | null; population: string | null; skipped: number; startedAt: number; following: boolean | null }>(
    { census: null, population: null, skipped: 0, startedAt: 0, following: null });
  const readPopulation = useRef(population);
  readPopulation.current = population;
  const saved = useRef(storage);
  saved.current = storage;
  const clock = useRef(now);
  clock.current = now;
  // The `at` of the stored census a follower last adopted, so a tick that
  // finds a newer one takes it even if the storage event did not arrive.
  const adoptedAt = useRef<number | null>(null);

  const apply = useCallback((next: Partial<CensusState>) => {
    state.current = { ...state.current, ...next };
    if (next.rows !== undefined) setRows(next.rows);
    if (next.archivedBy !== undefined) setArchivedBy(next.archivedBy);
    if (next.populationRead !== undefined) setPopulationRead(next.populationRead);
    if (next.connection !== undefined) setConnection(next.connection);
  }, []);

  // What this window knows, for the others; only the publisher writes.
  const publish = useCallback(() => {
    if (share !== 'publish') return;
    try { saved.current?.setItem(CENSUS_STORAGE_KEY, JSON.stringify(toStored(state.current, clock.current()))); } catch { /* not shared */ }
  }, [share]);

  // The hub's rows, and (less often, it is an agent-bot run) which of them
  // agent-bot has archived (#196). An explicit refresh, such as after an
  // archive, reads both so the row goes at once.
  const refresh = useCallback(async ({ archived = true }: { archived?: boolean } = {}) => {
    if (inFlight.current) {
      // A read that never comes back would stop every later one (#223): say so.
      logged.current.skipped += 1;
      if (logged.current.skipped === 3) shellLog(`census: a refresh from ${Date.now() - logged.current.startedAt} ms ago is still in flight`);
      return;
    }
    logged.current.skipped = 0;
    logged.current.startedAt = Date.now();
    inFlight.current = true;
    try {
      const outcome = await fetchCensus();
      const installed = await brokerInstalled(outcome);
      apply({ ...(outcome.ok ? { rows: outcome.souls } : {}),
        connection: applyCensus(state.current.connection, outcome, new Date(), installed) });
      const censusLine = outcome.ok ? `census ok: ${outcome.souls.length} souls` : `census ${outcome.code}: ${outcome.message}`;
      if (censusLine !== logged.current.census) { logged.current.census = censusLine; shellLog(censusLine); }
      // Stored before the (slower) population read too, so the followers never find it stale.
      publish();
      if (archived) {
        const list = await readPopulation.current().catch(() => null);
        apply({ ...(list ? { archivedBy: list } : {}), populationRead: true });
        const populationLine = list ? `population: ${list.length} entries` : 'population: not read';
        if (populationLine !== logged.current.population) { logged.current.population = populationLine; shellLog(populationLine); }
      }
      publish();
    } finally {
      inFlight.current = false;
    }
  }, [apply, publish]);

  // What the publisher stored, as this window's own state.
  const adopt = useCallback((stored: StoredCensus) => {
    if (adoptedAt.current === stored.at) return;
    adoptedAt.current = stored.at;
    apply(revive(stored));
    if (logged.current.following !== true) {
      logged.current.following = true;
      shellLog(`census: following the popup (${stored.rows.length} souls)`);
    }
  }, [apply]);

  useEffect(() => {
    if (!enabled || share === 'follow') return;
    void refresh();
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      // A heartbeat (#223): the outcome lines above say only what changed.
      if (ticks % 6 === 0) shellLog(`census tick ${ticks}: ${logged.current.census ?? 'no outcome yet'}`);
      void refresh({ archived: ticks % Math.max(1, Math.round(POPULATION_INTERVAL_MS / CENSUS_INTERVAL_MS)) === 0 });
    }, CENSUS_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled, share, refresh]);

  // A follower shows the stored census while it is fresh, takes each new
  // one from the storage event (it fires in every web view but the writer),
  // and polls itself only while the publisher has gone quiet.
  useEffect(() => {
    if (!enabled || share !== 'follow') return;
    const read = (): StoredCensus | null => {
      try { return fromStored(saved.current?.getItem(CENSUS_STORAGE_KEY) ?? null); } catch { return null; }
    };
    let ticks = 0;
    const tick = (first: boolean) => {
      const stored = read();
      if (stored && fresh(stored, clock.current())) {
        adopt(stored);
        return;
      }
      if (logged.current.following !== false) {
        logged.current.following = false;
        shellLog(`census: ${stored ? `the stored census is ${clock.current() - stored.at} ms old` : 'no stored census'}, polling`);
      }
      void refresh({ archived: first || ticks % Math.max(1, Math.round(POPULATION_INTERVAL_MS / CENSUS_INTERVAL_MS)) === 0 });
    };
    tick(true);
    const timer = setInterval(() => { ticks += 1; tick(false); }, CENSUS_INTERVAL_MS);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== CENSUS_STORAGE_KEY || e.newValue === null) return;
      const stored = fromStored(e.newValue);
      if (stored) adopt(stored);
    };
    if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
    return () => {
      clearInterval(timer);
      if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
    };
  }, [enabled, share, refresh, adopt]);

  const census = useMemo(() => withoutArchived(rows, archivedBy), [rows, archivedBy]);
  const refreshAll = useCallback(() => refresh(), [refresh]);
  return { census, connection, refresh: enabled ? refreshAll : undefined, settled: !enabled || populationRead };
}

// The desktop's avatar badges (#122): which souls have agent comms on and
// which drive the screen. Read from agent-bot: comms for every soul in one
// `population list` run each minute (#137), falling back to one run per soul
// on an older bundle; the computer-use and busy lists every 15 s, or on the
// census cadence while a soul drives the screen or is mid-turn so the badge
// and the floating Dudle's working state clear promptly.
import { useEffect, useRef, useState } from 'react';
import { daemonStatus, populationList, soulComms, type DaemonStatus, type PopulationEntry, type SoulComms } from './bridge';
import { busyOf, commsAmong, commsOf, computerUseOf, noBadges, sameSet, type SoulBadges } from './model/refresh';
import { CENSUS_INTERVAL_MS } from './useCensus';

export const COMMS_INTERVAL_MS = 60_000;
/** Daemon status cadence while no soul is known to drive the screen. */
export const STATUS_INTERVAL_MS = 15_000;

export interface BadgeSources {
  status: () => Promise<DaemonStatus | null>;
  /** Every soul's comms in one call; null on an older bundle. */
  population: () => Promise<PopulationEntry[] | null>;
  comms: (agentId: string) => Promise<SoulComms | null>;
}

const live: BadgeSources = {
  status: () => daemonStatus(),
  population: () => populationList(),
  comms: (agentId) => soulComms(agentId),
};

/**
 * Badges for `agentIds` while `enabled`. Outside Tauri, or with an older
 * bundle, every read is null: no badges and no error.
 */
export function useBadges(agentIds: readonly string[], enabled: boolean, sources: BadgeSources = live): SoulBadges {
  const [badges, setBadges] = useState<SoulBadges>(noBadges);
  const ids = agentIds.join('\n');
  const source = useRef(sources);
  source.current = sources;

  useEffect(() => {
    if (!enabled) { setBadges(noBadges); return; }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Each read schedules the next, so reads never overlap and the delay
    // follows what the last one saw.
    const read = async () => {
      const status = await source.current.status().catch(() => null);
      const next = computerUseOf(status);
      const busy = busyOf(status);
      if (!active) return;
      setBadges((b) => (sameSet(b.computerUse, next) && sameSet(b.busy, busy) ? b : { ...b, computerUse: next, busy }));
      // A soul mid-turn also keeps the census cadence, so working clears promptly.
      timer = setTimeout(() => { void read(); }, next.size > 0 || busy.size > 0 ? CENSUS_INTERVAL_MS : STATUS_INTERVAL_MS);
    };
    void read();
    return () => { active = false; clearTimeout(timer); };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let busy = false;
    const list = ids ? ids.split('\n') : [];
    const read = async () => {
      if (busy) return;
      busy = true;
      try {
        let next: ReadonlySet<string>;
        if (list.length === 0) {
          next = new Set();
        } else {
          const all = await source.current.population().catch(() => null);
          if (all) {
            next = commsAmong(all, list);
          } else {
            // Older bundle: one agent-bot run per soul, one at a time.
            const states: (SoulComms | null)[] = [];
            for (const agentId of list) {
              if (!active) return;
              states.push(await source.current.comms(agentId).catch(() => null));
            }
            next = commsOf(states);
          }
        }
        if (active) setBadges((b) => (sameSet(b.comms, next) ? b : { ...b, comms: next }));
      } finally { busy = false; }
    };
    void read();
    const timer = setInterval(() => { void read(); }, COMMS_INTERVAL_MS);
    return () => { active = false; clearInterval(timer); };
  }, [enabled, ids]);

  return badges;
}

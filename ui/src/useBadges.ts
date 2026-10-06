// The desktop's avatar badges (#122): which souls have agent comms on and
// which drive the screen. Read from agent-bot, the computer-use list on the
// census cadence and comms (one agent-bot run per soul) less often.
import { useEffect, useRef, useState } from 'react';
import { daemonStatus, soulComms, type DaemonStatus, type SoulComms } from './bridge';
import { commsOf, computerUseOf, noBadges, sameSet, type SoulBadges } from './model/refresh';
import { CENSUS_INTERVAL_MS } from './useCensus';

export const COMMS_INTERVAL_MS = 60_000;

export interface BadgeSources {
  status: () => Promise<DaemonStatus | null>;
  comms: (agentId: string) => Promise<SoulComms | null>;
}

const live: BadgeSources = { status: () => daemonStatus(), comms: (agentId) => soulComms(agentId) };

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
    let busy = false;
    const read = async () => {
      if (busy) return;
      busy = true;
      try {
        const next = computerUseOf(await source.current.status().catch(() => null));
        if (active) setBadges((b) => (sameSet(b.computerUse, next) ? b : { ...b, computerUse: next }));
      } finally { busy = false; }
    };
    void read();
    const timer = setInterval(() => { void read(); }, CENSUS_INTERVAL_MS);
    return () => { active = false; clearInterval(timer); };
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
        // One soul at a time: each is its own agent-bot run.
        const states: (SoulComms | null)[] = [];
        for (const agentId of list) {
          if (!active) return;
          states.push(await source.current.comms(agentId).catch(() => null));
        }
        const next = commsOf(states);
        if (active) setBadges((b) => (sameSet(b.comms, next) ? b : { ...b, comms: next }));
      } finally { busy = false; }
    };
    void read();
    const timer = setInterval(() => { void read(); }, COMMS_INTERVAL_MS);
    return () => { active = false; clearInterval(timer); };
  }, [enabled, ids]);

  return badges;
}

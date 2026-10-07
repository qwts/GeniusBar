// The desktop's avatar badges (#122): which souls have agent comms on and
// which drive the screen, and the Dudle hues souls declare (#64), from the
// same population read. Read from agent-bot: comms for every soul in one
// `population list` run each minute (#137), falling back to one run per soul
// on an older bundle; the computer-use and busy lists every 15 s, or on the
// census cadence while a soul drives the screen or is mid-turn so the badge
// and the floating Dudle's working state clear promptly.
//
// The app's windows share one set (#223), as they share the census: the
// popup publishes each read to the web view's storage and a surface window
// follows it, polling agent-bot itself only while the stored set is stale.
import { useEffect, useRef, useState } from 'react';
import { daemonStatus, populationList, soulComms, type DaemonStatus, type PopulationEntry, type SoulComms } from './bridge';
import { busyOf, commsAmong, commsOf, computerUseOf, huesOf, noBadges, rolesOf, sameHues, sameRoles, sameSet, type SoulBadges } from './model/refresh';
import type { SoulRole } from './model/census';
import { CENSUS_INTERVAL_MS, type CensusShare, type CensusStorage } from './useCensus';

export const COMMS_INTERVAL_MS = 60_000;
/** Daemon status cadence while no soul is known to drive the screen. */
export const STATUS_INTERVAL_MS = 15_000;
/** Where the popup keeps its last badges for the other windows. */
export const BADGES_STORAGE_KEY = 'geniusbar.badges';
/** A stored set older than this has no live publisher behind it (the popup writes at least every STATUS_INTERVAL_MS). */
export const BADGES_STALE_MS = 3 * STATUS_INTERVAL_MS;

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

/** The badges as the popup stores them: sets and maps as arrays. */
export interface StoredBadges {
  at: number;
  comms: string[];
  computerUse: string[];
  busy: string[];
  hues?: [string, number][];
  roles?: [string, SoulRole][];
}

export function toStoredBadges(badges: SoulBadges, at: number): StoredBadges {
  return { at, comms: [...badges.comms], computerUse: [...badges.computerUse], busy: [...badges.busy],
    ...(badges.hues ? { hues: [...badges.hues] } : {}), ...(badges.roles ? { roles: [...badges.roles] } : {}) };
}

/** The stored badges, or null when there are none or they do not parse. */
export function fromStoredBadges(raw: string | null): StoredBadges | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const s = parsed as Partial<StoredBadges>;
    const ids = (list: unknown): string[] | null => (Array.isArray(list) && list.every((x) => typeof x === 'string') ? list : null);
    const comms = ids(s.comms);
    const computerUse = ids(s.computerUse);
    const busy = ids(s.busy);
    if (typeof s.at !== 'number' || !comms || !computerUse || !busy) return null;
    return { at: s.at, comms, computerUse, busy,
      ...(Array.isArray(s.hues) ? { hues: s.hues } : {}), ...(Array.isArray(s.roles) ? { roles: s.roles } : {}) };
  } catch {
    return null;
  }
}

function revive(stored: StoredBadges): SoulBadges {
  return { comms: new Set(stored.comms), computerUse: new Set(stored.computerUse), busy: new Set(stored.busy),
    ...(stored.hues ? { hues: new Map(stored.hues) } : {}), ...(stored.roles ? { roles: new Map(stored.roles) } : {}) };
}

function defaultStorage(): CensusStorage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export interface BadgeOptions {
  share?: CensusShare;
  storage?: CensusStorage | null;
  now?: () => number;
}

/**
 * Badges for `agentIds` while `enabled`. Outside Tauri, or with an older
 * bundle, every read is null: no badges and no error. `share` is as for
 * `useCensus`: `publish` stores each read, `follow` shows what is stored and
 * reads agent-bot only while that is stale, `poll` (the default) reads and
 * tells no one.
 */
export function useBadges(agentIds: readonly string[], enabled: boolean, sources: BadgeSources = live,
  { share = 'poll', storage = defaultStorage(), now = Date.now }: BadgeOptions = {}): SoulBadges {
  const [badges, setBadges] = useState<SoulBadges>(noBadges);
  const ids = agentIds.join('\n');
  const source = useRef(sources);
  source.current = sources;
  const saved = useRef(storage);
  saved.current = storage;
  const clock = useRef(now);
  clock.current = now;
  // The state outside React's batching, so a publish stores what one read produced.
  const current = useRef<SoulBadges>(noBadges);
  const adoptedAt = useRef<number | null>(null);
  // A follower polls itself only while the stored set is stale.
  const [stale, setStale] = useState(false);
  const polling = enabled && (share !== 'follow' || stale);

  // Computed from the mirror, not in the setter: a publish right after must store the new set.
  const update = (next: (b: SoulBadges) => SoulBadges) => {
    const n = next(current.current);
    if (n === current.current) return;
    current.current = n;
    setBadges(n);
  };
  const publish = () => {
    if (share !== 'publish') return;
    try { saved.current?.setItem(BADGES_STORAGE_KEY, JSON.stringify(toStoredBadges(current.current, clock.current()))); } catch { /* not shared */ }
  };

  useEffect(() => {
    if (!enabled) { setBadges(noBadges); current.current = noBadges; return; }
  }, [enabled]);

  useEffect(() => {
    if (!polling) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Each read schedules the next, so reads never overlap and the delay
    // follows what the last one saw.
    const read = async () => {
      const status = await source.current.status().catch(() => null);
      const next = computerUseOf(status);
      const busy = busyOf(status);
      if (!active) return;
      update((b) => (sameSet(b.computerUse, next) && sameSet(b.busy, busy) ? b : { ...b, computerUse: next, busy }));
      publish();
      // A soul mid-turn also keeps the census cadence, so working clears promptly.
      timer = setTimeout(() => { void read(); }, next.size > 0 || busy.size > 0 ? CENSUS_INTERVAL_MS : STATUS_INTERVAL_MS);
    };
    void read();
    return () => { active = false; clearTimeout(timer); };
  }, [polling]);

  useEffect(() => {
    if (!polling) return;
    let active = true;
    let busy = false;
    const list = ids ? ids.split('\n') : [];
    const read = async () => {
      if (busy) return;
      busy = true;
      try {
        let next: ReadonlySet<string>;
        let hues: ReadonlyMap<string, number> | undefined;
        let roles: ReadonlyMap<string, SoulRole> | undefined;
        if (list.length === 0) {
          next = new Set();
        } else {
          const all = await source.current.population().catch(() => null);
          if (all) {
            next = commsAmong(all, list);
            hues = huesOf(all);
            roles = rolesOf(all);
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
        if (active) {
          update((b) => {
            const sameComms = sameSet(b.comms, next);
            const keepHues = hues === undefined || sameHues(b.hues, hues);
            const keepRoles = roles === undefined || sameRoles(b.roles, roles);
            if (sameComms && keepHues && keepRoles) return b;
            return { ...b, ...(sameComms ? {} : { comms: next }), ...(keepHues ? {} : { hues }), ...(keepRoles ? {} : { roles }) };
          });
          publish();
        }
      } finally { busy = false; }
    };
    void read();
    const timer = setInterval(() => { void read(); }, COMMS_INTERVAL_MS);
    return () => { active = false; clearInterval(timer); };
  }, [polling, ids]);

  // A follower shows the stored set while it is fresh, takes each new one
  // from the storage event (it fires in every web view but the writer), and
  // a tick catches a newer one the event missed or a publisher gone quiet.
  useEffect(() => {
    if (!enabled || share !== 'follow') return;
    const adopt = (stored: StoredBadges) => {
      if (adoptedAt.current === stored.at) return;
      adoptedAt.current = stored.at;
      const next = revive(stored);
      current.current = next;
      setBadges(next);
      setStale(false);
    };
    const read = (): StoredBadges | null => {
      try { return fromStoredBadges(saved.current?.getItem(BADGES_STORAGE_KEY) ?? null); } catch { return null; }
    };
    const tick = () => {
      const stored = read();
      if (stored && clock.current() - stored.at <= BADGES_STALE_MS) adopt(stored);
      else setStale(true);
    };
    tick();
    const timer = setInterval(tick, CENSUS_INTERVAL_MS);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== BADGES_STORAGE_KEY || e.newValue === null) return;
      const stored = fromStoredBadges(e.newValue);
      if (stored) adopt(stored);
    };
    if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
    return () => {
      clearInterval(timer);
      if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
    };
  }, [enabled, share]);

  return badges;
}

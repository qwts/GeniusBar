// Pause all / Resume (#122): reads every soul's `paused` from agent-bot's
// `population list` while the bundle has `soul pause` (probed once), and
// toggles the fleet through `soul pause` / `soul resume`. agent-bot holds
// the souls; this only asks and renders (model/pause).
import { useCallback, useEffect, useRef, useState } from 'react';
import { pauseSoul, populationList, resumeSoul, soulPauseSupported, type SoulPauseResult } from './bridge';
import { actOnAll, applyPaused, fleetPaused, pauseAction, type PauseEntry } from './model/pause';

/** How often `paused` is re-read, so a pause made elsewhere shows. */
export const PAUSE_INTERVAL_MS = 60_000;
/** How long a failed pause or resume stays on the menu bar. */
export const PAUSE_ERROR_MS = 15_000;

export interface Pauser {
  /** Whether agent-bot has `soul pause`; an older bundle answers false. */
  supported: () => Promise<boolean>;
  list: () => Promise<PauseEntry[] | null>;
  pause: (agentId: string) => Promise<SoulPauseResult>;
  resume: (agentId: string) => Promise<SoulPauseResult>;
}

export const livePauser: Pauser = {
  supported: () => soulPauseSupported(),
  list: () => populationList(),
  pause: (agentId) => pauseSoul(agentId),
  resume: (agentId) => resumeSoul(agentId),
};

export interface PauseApi {
  /** False without a pauser or with an agent-bot that has no `soul pause`. */
  offered: boolean;
  /** The design's `paused`: any managed, unarchived soul is paused. */
  paused: boolean;
  busy: boolean;
  failure: { action: 'pause' | 'resume'; message: string } | null;
  /** Resume while paused, else pause all. */
  toggle: () => Promise<void>;
}

/** Reads while `enabled`; the probe runs once per pauser. */
export function usePause(pauser: Pauser | undefined, enabled = true): PauseApi {
  const [supported, setSupported] = useState(false);
  const [entries, setEntries] = useState<PauseEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<PauseApi['failure']>(null);
  const live = useRef({ entries, busy, pauser });
  live.current = { ...live.current, entries, pauser };

  useEffect(() => {
    setSupported(false);
    setEntries([]);
    if (!pauser) return;
    let current = true;
    pauser.supported().then((ok) => { if (current) setSupported(ok); }, () => {});
    return () => { current = false; };
  }, [pauser]);

  const read = useCallback(async () => {
    const asked = live.current.pauser;
    if (!asked) return;
    const list = await asked.list().catch(() => null);
    if (list && live.current.pauser === asked && !live.current.busy) setEntries(list);
  }, []);

  useEffect(() => {
    if (!pauser || !supported || !enabled) return;
    void read();
    const timer = setInterval(() => { void read(); }, PAUSE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pauser, supported, enabled, read]);

  useEffect(() => {
    if (!failure) return;
    const timer = setTimeout(() => setFailure(null), PAUSE_ERROR_MS);
    return () => clearTimeout(timer);
  }, [failure]);

  const toggle = useCallback(async () => {
    const { entries: now, busy: running, pauser: using } = live.current;
    if (!using || running) return;
    const { action, agentIds } = pauseAction(now);
    if (agentIds.length === 0) return;
    live.current.busy = true;
    setBusy(true);
    setFailure(null);
    try {
      const { answers, failure: failed } = await actOnAll(agentIds, action === 'pause' ? using.pause : using.resume);
      setEntries((e) => applyPaused(e, answers));
      if (failed?.code === 'soul-pause-unsupported') setSupported(false);
      else if (failed) setFailure({ action, message: failed.message });
    } finally {
      live.current.busy = false;
      setBusy(false);
    }
    void read();
  }, [read]);

  const offered = supported && pauser !== undefined;
  return { offered, paused: offered && fleetPaused(entries), busy, failure, toggle };
}

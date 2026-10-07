// The popup's coordinator for native team windows (#223): Lovable's desktop
// draws every team as a card on the wallpaper, and in the app each card is
// its own window on the macOS desktop. The popup knows the forest and the
// layout, so it tells the shell which team windows should exist, where, and
// how big; the shell creates, moves and closes them.
import { useEffect, useMemo, useRef, useState } from 'react';
import { shellLog, syncTeamWindows, type TeamWindowSpec } from './bridge';
import { teamCard } from './components/Desktop';
import { soulKey, type SoulNode } from './model/census';
import { teamsOf } from './model/fleet';
import { desktopWindowsOn, type DesktopLayout } from './state/layout';

/** Debounce for the sync, so a drag or a burst of layout writes is one call. */
export const TEAM_SYNC_MS = 150;
/** After a failed sync, the wait before the same list is sent again: doubles per failure up to the cap. */
export const TEAM_RETRY_MS = 2_000;
export const TEAM_RETRY_MAX_MS = 30_000;

/**
 * One entry per team card the desktop would draw: hidden teams have none,
 * a collapsed one is the collapsed size. The size is the one the team's own
 * window measured, else the design's card size until it has; the position is
 * where its window was dragged on screen (not the in-window desktop's
 * `pos`), absent for the shell to cascade.
 */
export function teamWindowList(forest: readonly SoulNode[], layout: DesktopLayout): TeamWindowSpec[] {
  if (!desktopWindowsOn(layout)) return [];
  return teamsOf(forest).flatMap((team) => {
    const card = teamCard(team, layout);
    if (!card.shown) return [];
    const key = soulKey(team.lead);
    const at = layout.screen?.[key];
    const measured = layout.size?.[key];
    return [{
      key,
      ...(at ? { x: Math.round(at.x), y: Math.round(at.y) } : {}),
      width: measured?.width ?? card.width,
      height: measured?.height ?? card.height,
    }];
  });
}

/**
 * Keeps the native team windows in step with the forest and the layout
 * while `enabled` (the live tray popup, once a census has arrived, so a
 * starting popup never closes every window). Calls only when the list
 * changes. The first `false` means this shell keeps the in-window desktop
 * (`--window`, another platform): it stops asking for the rest of the run.
 * A sync that fails (the shell could not make a window just then, as right
 * after an update while the app is still settling) is sent again after a
 * growing wait, so one bad moment never leaves the desktop empty.
 */
export function useTeamWindows(forest: readonly SoulNode[], layout: DesktopLayout, enabled: boolean,
  sync: (teams: TeamWindowSpec[]) => Promise<boolean> = syncTeamWindows, delayMs = TEAM_SYNC_MS, retryMs = TEAM_RETRY_MS): void {
  const signature = useMemo(() => JSON.stringify(teamWindowList(forest, layout)), [forest, layout]);
  const off = useRef(false);
  const sent = useRef<string | null>(null);
  const failures = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const call = useRef(sync);
  call.current = sync;
  const wasEnabled = useRef<boolean | null>(null);
  useEffect(() => {
    if (wasEnabled.current !== enabled) {
      wasEnabled.current = enabled;
      shellLog(`team sync ${enabled ? 'enabled' : 'disabled'}`);
    }
    if (!enabled || off.current || signature === sent.current) return;
    const wait = failures.current === 0 ? delayMs : Math.min(TEAM_RETRY_MAX_MS, retryMs * 2 ** (failures.current - 1));
    let stale = false;
    const timer = setTimeout(() => {
      sent.current = signature;
      const teams = JSON.parse(signature) as TeamWindowSpec[];
      shellLog(`team sync: ${teams.length} teams${failures.current ? ` (retry ${failures.current})` : ''}`);
      call.current(teams).then(
        (used) => {
          failures.current = 0;
          if (!used) {
            off.current = true;
            shellLog('team sync: the shell declined; off for this run');
          }
        },
        (error: unknown) => {
          shellLog(`team sync failed: ${error instanceof Error ? error.message : String(error)}`);
          if (stale) return;
          // Forget this list was sent, so the next change or the retry resends it.
          failures.current += 1;
          sent.current = null;
          setAttempt((n) => n + 1);
        },
      );
    }, wait);
    return () => { stale = true; clearTimeout(timer); };
  }, [enabled, signature, delayMs, retryMs, attempt]);
}

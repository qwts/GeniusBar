// The popup's coordinator for native team windows (#223): Lovable's desktop
// draws every team as a card on the wallpaper, and in the app each card is
// its own window on the macOS desktop. The popup knows the forest and the
// layout, so it tells the shell which team windows should exist, where, and
// how big; the shell creates, moves and closes them.
import { useEffect, useMemo, useRef } from 'react';
import { syncTeamWindows, type TeamWindowSpec } from './bridge';
import { teamCard } from './components/Desktop';
import { soulKey, type SoulNode } from './model/census';
import { teamsOf } from './model/fleet';
import { desktopWindowsOn, type DesktopLayout } from './state/layout';

/** Debounce for the sync, so a drag or a burst of layout writes is one call. */
export const TEAM_SYNC_MS = 150;

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
 */
export function useTeamWindows(forest: readonly SoulNode[], layout: DesktopLayout, enabled: boolean,
  sync: (teams: TeamWindowSpec[]) => Promise<boolean> = syncTeamWindows, delayMs = TEAM_SYNC_MS): void {
  const signature = useMemo(() => JSON.stringify(teamWindowList(forest, layout)), [forest, layout]);
  const off = useRef(false);
  const sent = useRef<string | null>(null);
  const call = useRef(sync);
  call.current = sync;
  useEffect(() => {
    if (!enabled || off.current || signature === sent.current) return;
    const timer = setTimeout(() => {
      sent.current = signature;
      call.current(JSON.parse(signature) as TeamWindowSpec[]).then(
        (used) => { if (!used) off.current = true; },
        () => { off.current = true; },
      );
    }, delayMs);
    return () => clearTimeout(timer);
  }, [enabled, signature, delayMs]);
}

// What every native surface (#223) shares: the fleet as the popup derives
// it, the page's hidden state for the Dudles, and the window's title.
import { useEffect, useMemo, useState } from 'react';
import type { SurfaceWindow } from '../bridge';
import { menuApprovals } from '../model/approvals';
import { allSouls, buildSoulForest, soulKey, withHues, withRoles, type CensusRow } from '../model/census';
import { unreadOf } from '../model/chat';
import { noBadges, type SoulBadges } from '../model/refresh';
import type { ChatApi } from '../useChat';

/** The live data a surface draws from; the app passes live hooks', tests and the preview fixtures. */
export interface SurfaceData {
  census: readonly CensusRow[];
  /** False until the first census answered: a soul not found yet may still come. */
  loaded: boolean;
  chat?: ChatApi;
  badges?: SoulBadges;
  /** This web view's window; null outside the app. */
  win: SurfaceWindow | null;
  /** Static renders: Dudles stay still. */
  isStatic?: boolean;
}

/** The forest with declared hues and roles, who waits on the owner, who works, and unread counts, as the popup has them. */
export function useSurfaceFleet({ census, chat, badges = noBadges }: Pick<SurfaceData, 'census' | 'chat' | 'badges'>) {
  const hued = useMemo(() => withRoles(withHues(census, badges.hues), badges.roles), [census, badges.hues, badges.roles]);
  const forest = useMemo(() => buildSoulForest(hued), [hued]);
  const roster = useMemo(() => allSouls(forest), [forest]);
  const approvals = chat?.approvals;
  const awaiting = useMemo(() => new Set(approvals ? menuApprovals(approvals.records, approvals.local, roster).map((w) => w.agentId) : []),
    [approvals, roster]);
  const chatState = chat?.chat;
  const unread = useMemo(() => (chatState ? (soul: CensusRow) => unreadOf(chatState, soulKey(soul)) : undefined), [chatState]);
  return { forest, roster, awaiting, busy: badges.busy, badges, unread };
}

/** Dudles rest while the page is hidden (a minimised window), as the popup's do. */
export function usePageHidden(): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return hidden;
}

/** The page's and the native window's title; the shell hides the title bar's text, the Window menu and Mission Control show it. */
export function useWindowTitle(title: string | null, win: SurfaceWindow | null) {
  useEffect(() => {
    if (title === null) return;
    document.title = title;
    win?.setTitle(title).catch(() => {});
  }, [title, win]);
}

/** Closes this window; outside the app there is none, so nothing happens. */
export const closeWindow = (win: SurfaceWindow | null) => { win?.close().catch(() => {}); };

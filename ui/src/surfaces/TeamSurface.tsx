import { useEffect, useRef, type RefObject } from 'react';
import type { SurfaceWindow } from '../bridge';
import { TeamCard } from '../components/Desktop';
import { DropCue } from '../components/DropCue';
import { soulKey, type CensusRow } from '../model/census';
import { teamsOf } from '../model/fleet';
import { layoutActions, useLayout } from '../state/layout';
import { useSurfaceFleet, usePageHidden, type SurfaceData } from './common';
import { SurfaceOpenerContext, type OpenSurface } from './opener';

/** Debounce for writing a dragged window's position, so a drag is one layout write. */
export const MOVE_SAVE_MS = 250;

/**
 * What the team window must show: the card, plus any menu or hover card
 * hanging from it, so they are not clipped by a window the card's size.
 * Menus and hover cards float over the body (#262), shifted to stay inside
 * the window; one too big for it still hangs past the card, and the window
 * grows to show it. Rounded up to whole points.
 */
export function windowSizeFor(card: HTMLElement): { width: number; height: number; card: { width: number; height: number } } {
  const box = card.getBoundingClientRect();
  let right = box.right;
  let bottom = box.bottom;
  card.ownerDocument.querySelectorAll('[role="menu"], [role="tooltip"]').forEach((el) => {
    const r = el.getBoundingClientRect();
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  });
  return { width: Math.ceil(right), height: Math.ceil(bottom), card: { width: Math.ceil(box.width), height: Math.ceil(box.height) } };
}

/** The window fits its content as it changes; the layout keeps the card's own size for the coordinator. */
function useFitWindow(card: RefObject<HTMLElement | null>, win: SurfaceWindow | null, key: string, shown: boolean) {
  useEffect(() => {
    const el = card.current;
    if (!el || !win) return;
    let frame = 0;
    let last = '';
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const size = windowSizeFor(el);
        if (size.width <= 0 || size.height <= 0) return;
        const said = `${size.width}x${size.height}`;
        if (said === last) return;
        last = said;
        win.setSize(size.width, size.height).catch(() => {});
        layoutActions.measure(key, size.card.width, size.card.height);
      });
    };
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    resized?.observe(el);
    // A menu or hover card opening changes no size of the card's own, and
    // floats over the body, placed by its style: the whole page is watched.
    const changed = new MutationObserver(measure);
    changed.observe(el.ownerDocument.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    measure();
    return () => { resized?.disconnect(); changed.disconnect(); cancelAnimationFrame(frame); };
  }, [card, win, key, shown]);
}

/** A drag moves the window; where it rests goes to the layout, so the next launch puts it back. */
function useSavePosition(win: SurfaceWindow | null, key: string) {
  useEffect(() => {
    if (!win) return;
    let active = true;
    let stop: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = async () => {
      const at = await win.position().catch(() => null);
      if (!at || !active) return;
      const x = Math.round(at.x);
      const y = Math.round(at.y);
      // The coordinator placing the window moves it too: the same spot is no change.
      const was = layoutActions.current().screen?.[key];
      if (!was || was.x !== x || was.y !== y) layoutActions.place(key, x, y);
    };
    win.onMoved(() => { clearTimeout(timer); timer = setTimeout(() => { void save(); }, MOVE_SAVE_MS); })
      .then((unlisten) => { if (active) stop = unlisten; else unlisten(); }, () => {});
    return () => { active = false; clearTimeout(timer); stop?.(); };
  }, [win, key]);
}

/**
 * One team's card as its own native window on the desktop (#223), the
 * card Lovable's desktop draws: the page is transparent around it, the title
 * drags it, and its avatars open sessions in their own windows. Hide and
 * collapse write the shared layout; the popup's coordinator then closes or
 * resizes this window.
 */
export function TeamSurface({ soul: leadKey, census, chat, badges, win, isStatic = false, open, dropping = false }: SurfaceData & {
  /** The lead's roster key. */
  soul: string | null;
  open: OpenSurface | null;
  /** A `.soul` package is dragged over the card (#98): its drop cue shows. */
  dropping?: boolean;
}) {
  const layout = useLayout();
  const { forest, awaiting, unread, badges: shownBadges } = useSurfaceFleet({ census, chat, badges });
  const team = leadKey ? teamsOf(forest).find((candidate) => soulKey(candidate.lead) === leadKey) : undefined;
  const paused = usePageHidden() || isStatic;
  const card = useRef<HTMLElement>(null);
  const key = leadKey ?? '';
  useFitWindow(card, win, key, Boolean(team));
  useSavePosition(leadKey ? win : null, key);
  useEffect(() => {
    document.documentElement.classList.add('gb-transparent');
    return () => document.documentElement.classList.remove('gb-transparent');
  }, []);
  // Until the census lists the team there is nothing to draw; the
  // coordinator closes the window if the team has gone.
  if (!team) return null;
  const session = (soul: CensusRow, action?: 'archive') => {
    open?.({ surface: 'session', soul: soulKey(soul), ...(action ? { action } : {}) }).catch(() => {});
  };
  return (
    <SurfaceOpenerContext.Provider value={open}>
      <div className="gb relative inline-block">
        <TeamCard team={team} layout={layout} paused={paused} unreadOf={unread} onOpen={(soul) => session(soul)}
          badges={shownBadges} onArchive={open ? (soul) => session(soul, 'archive') : undefined}
          awaiting={awaiting} cardRef={card} />
        {dropping && <DropCue />}
      </div>
    </SurfaceOpenerContext.Provider>
  );
}

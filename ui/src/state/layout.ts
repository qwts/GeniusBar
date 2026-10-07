import { useSyncExternalStore } from 'react';

/**
 * The desktop's arrangement, shared by every window of the app (#223):
 * companions hidden from it, where each team was dragged, and which teams
 * are collapsed.
 * Keys are roster keys (account/agentId). It is a convenience only, so a
 * storage failure leaves the default layout and nothing else breaks.
 */
export interface DesktopLayout {
  hidden: string[];
  pos: Record<string, { x: number; y: number }>;
  collapsed: string[];
  /**
   * The size each native team window measured for its card (#223), so the
   * popup's coordinator sizes the window as the card asks. Absent until one did.
   */
  size?: Record<string, { width: number; height: number }>;
  /**
   * Where each native team window rests on screen (#223), in logical
   * points. Apart from `pos`, which places cards inside the in-window
   * desktop (`--window`, Open desktop): the two share this storage.
   */
  screen?: Record<string, { x: number; y: number }>;
  /** "Companions on the desktop" (#223): absent is on; only off is stored. */
  desktopWindows?: false;
}

export const LAYOUT_KEY = 'gb.desktop';
const empty: DesktopLayout = { hidden: [], pos: {}, collapsed: [] };
let state: DesktopLayout = empty;
let loaded = false;
const listeners = new Set<() => void>();

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function sizes(value: unknown): NonNullable<DesktopLayout['size']> {
  if (!value || typeof value !== 'object') return {};
  const out: NonNullable<DesktopLayout['size']> = {};
  for (const [key, s] of Object.entries(value)) {
    const { width, height } = (s ?? {}) as { width?: unknown; height?: unknown };
    if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0
      && Number.isFinite(width) && Number.isFinite(height)) out[key] = { width, height };
  }
  return out;
}

function positions(value: unknown): DesktopLayout['pos'] {
  if (!value || typeof value !== 'object') return {};
  const out: DesktopLayout['pos'] = {};
  for (const [key, p] of Object.entries(value)) {
    const { x, y } = (p ?? {}) as { x?: unknown; y?: unknown };
    if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) out[key] = { x, y };
  }
  return out;
}

/** Stored text back to a layout; anything malformed is dropped. */
export function parseLayout(raw: string | null): DesktopLayout {
  if (!raw) return empty;
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof DesktopLayout, unknown>>;
    const size = sizes(value.size);
    const screen = positions(value.screen);
    return {
      hidden: strings(value.hidden), pos: positions(value.pos), collapsed: strings(value.collapsed),
      ...(Object.keys(size).length ? { size } : {}),
      ...(Object.keys(screen).length ? { screen } : {}),
      ...(value.desktopWindows === false ? { desktopWindows: false as const } : {}),
    };
  } catch {
    return empty;
  }
}

function load() {
  if (loaded) return;
  loaded = true;
  try { state = parseLayout(localStorage.getItem(LAYOUT_KEY)); } catch { /* default layout */ }
}

/** Whether native team windows are wanted (#223); on unless switched off. */
export const desktopWindowsOn = (layout: DesktopLayout): boolean => layout.desktopWindows !== false;

const notify = () => listeners.forEach((listener) => listener());

// Every window of the app shares this storage (#223): a team card moved or
// collapsed in one window, or the switch flipped in the popup, reaches the
// others through the storage event, which fires in every web view but the
// one that wrote.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== LAYOUT_KEY && e.key !== null) return;
    loaded = true;
    state = e.key === null ? empty : parseLayout(e.newValue);
    notify();
  });
}

function set(next: DesktopLayout) {
  state = next;
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(next)); } catch { /* not remembered */ }
  notify();
}

const toggle = (list: string[], key: string, on: boolean) =>
  on ? (list.includes(key) ? list : [...list, key]) : list.filter((item) => item !== key);

export const layoutActions = {
  setHidden: (key: string, hidden: boolean) => { load(); set({ ...state, hidden: toggle(state.hidden, key, hidden) }); },
  /** Hide or show a whole team at once: its lead and every subagent. */
  setTeamHidden: (keys: readonly string[], hidden: boolean) => {
    load();
    set({ ...state, hidden: keys.reduce((list, key) => toggle(list, key, hidden), state.hidden) });
  },
  showAll: () => { load(); set({ ...state, hidden: [] }); },
  setCollapsed: (key: string, collapsed: boolean) => { load(); set({ ...state, collapsed: toggle(state.collapsed, key, collapsed) }); },
  move: (key: string, x: number, y: number) => { load(); set({ ...state, pos: { ...state.pos, [key]: { x, y } } }); },
  /** Where a native team window was dragged to (#223), on screen. */
  place: (key: string, x: number, y: number) => { load(); set({ ...state, screen: { ...state.screen, [key]: { x, y } } }); },
  /** A team window's measured card (#223); the same size again changes nothing. */
  measure: (key: string, width: number, height: number) => {
    load();
    const was = state.size?.[key];
    if (was && was.width === width && was.height === height) return;
    set({ ...state, size: { ...state.size, [key]: { width, height } } });
  },
  /** "Companions on the desktop" (#223). */
  setDesktopWindows: (on: boolean) => {
    load();
    const next: DesktopLayout = { ...state };
    if (on) delete next.desktopWindows; else next.desktopWindows = false;
    set(next);
  },
  /** Back to the default arrangement; the desktop windows switch is a preference and stays. */
  reset: () => { load(); set(state.desktopWindows === false ? { ...empty, desktopWindows: false } : empty); },
  /** The layout as stored now, for a check outside React. */
  current: (): DesktopLayout => { load(); return state; },
  /** Tests only: forget the in-memory copy so the next read loads storage. */
  forget: () => { state = empty; loaded = false; },
};

export function useLayout(): DesktopLayout {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => { load(); return state; },
    () => empty,
  );
}

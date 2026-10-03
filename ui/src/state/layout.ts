import { useSyncExternalStore } from 'react';

/**
 * The window-mode desktop's arrangement, per web view: companions hidden
 * from it, where each team was dragged, and which teams are collapsed.
 * Keys are roster keys (account/agentId). It is a convenience only, so a
 * storage failure leaves the default layout and nothing else breaks.
 */
export interface DesktopLayout {
  hidden: string[];
  pos: Record<string, { x: number; y: number }>;
  collapsed: string[];
}

export const LAYOUT_KEY = 'gb.desktop';
const empty: DesktopLayout = { hidden: [], pos: {}, collapsed: [] };
let state: DesktopLayout = empty;
let loaded = false;
const listeners = new Set<() => void>();

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

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
    return { hidden: strings(value.hidden), pos: positions(value.pos), collapsed: strings(value.collapsed) };
  } catch {
    return empty;
  }
}

function load() {
  if (loaded) return;
  loaded = true;
  try { state = parseLayout(localStorage.getItem(LAYOUT_KEY)); } catch { /* default layout */ }
}

function set(next: DesktopLayout) {
  state = next;
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(next)); } catch { /* not remembered */ }
  listeners.forEach((listener) => listener());
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
  reset: () => set(empty),
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

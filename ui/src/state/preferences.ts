import { useSyncExternalStore } from 'react';

/** Where one companion's conversation opens from the popup (#264): as the app says, or its own choice. */
export type WindowChoice = 'inherit' | 'window' | 'popup';

/**
 * Per-viewer preferences. Like the desktop layout, these are a convenience
 * kept in this web view's storage (shared by every window of the app): a
 * storage failure leaves the defaults and nothing else breaks.
 */
export interface Preferences {
  /** Harness new launches start with; null asks every time. */
  defaultHarness: string | null;
  /**
   * "Open conversations in their own window" (#264): on opens a companion's
   * session, the audit log, Customize and Launch in native windows of their
   * own; off (the default) shows them inside the GeniusBar popup, with a
   * pop-out on the view for the window.
   */
  ownWindows: boolean;
  /** Per-companion overrides of `ownWindows`, by roster key; absent follows it. */
  windowFor: Record<string, Exclude<WindowChoice, 'inherit'>>;
  /**
   * "Close GeniusBar when clicking outside it" (#265): on hides the popup
   * when it loses focus, as a menu does; off (the default) keeps it open
   * until the tray icon is clicked, so a drag from Finder can reach it.
   */
  closeOnClickOut: boolean;
}

export const PREFERENCES_KEY = 'gb.preferences';
const empty: Preferences = { defaultHarness: null, ownWindows: false, windowFor: {}, closeOnClickOut: false };
let state: Preferences = empty;
let loaded = false;
const listeners = new Set<() => void>();

function overrides(value: unknown): Preferences['windowFor'] {
  if (!value || typeof value !== 'object') return {};
  const out: Preferences['windowFor'] = {};
  for (const [key, choice] of Object.entries(value)) {
    if (choice === 'window' || choice === 'popup') out[key] = choice;
  }
  return out;
}

/** Stored text back to preferences; anything malformed is dropped. */
export function parsePreferences(raw: string | null): Preferences {
  if (!raw) return empty;
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof Preferences, unknown>>;
    const harness = typeof value.defaultHarness === 'string' ? value.defaultHarness.trim() : '';
    return {
      defaultHarness: harness === '' ? null : harness,
      ownWindows: value.ownWindows === true,
      windowFor: overrides(value.windowFor),
      closeOnClickOut: value.closeOnClickOut === true,
    };
  } catch {
    return empty;
  }
}

/**
 * Whether the popup opens this companion's conversation in its own window
 * (#264): the companion's own choice when it made one, else the app's.
 */
export function opensInOwnWindow(prefs: Pick<Preferences, 'ownWindows' | 'windowFor'>, key: string): boolean {
  const own = prefs.windowFor[key];
  return own ? own === 'window' : prefs.ownWindows;
}

/** This companion's choice as the Details row shows it: inherit unless it picked. */
export function windowChoiceOf(prefs: Pick<Preferences, 'windowFor'>, key: string): WindowChoice {
  return prefs.windowFor[key] ?? 'inherit';
}

function load() {
  if (loaded) return;
  loaded = true;
  try { state = parsePreferences(localStorage.getItem(PREFERENCES_KEY)); } catch { /* defaults */ }
}

const notify = () => listeners.forEach((listener) => listener());

// Every window of the app shares this storage (#223): a choice made in a
// session window's Details reaches the popup through the storage event,
// which fires in every web view but the one that wrote.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== PREFERENCES_KEY && e.key !== null) return;
    loaded = true;
    state = e.key === null ? empty : parsePreferences(e.newValue);
    notify();
  });
}

function set(next: Preferences) {
  state = next;
  try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next)); } catch { /* not remembered */ }
  notify();
}

export const preferenceActions = {
  setDefaultHarness: (harness: string | null) => { load(); set({ ...state, defaultHarness: harness?.trim() || null }); },
  /** "Open conversations in their own window" (#264). */
  setOwnWindows: (on: boolean) => { load(); set({ ...state, ownWindows: on }); },
  /** One companion's choice (#264); inherit forgets it. */
  setWindowFor: (key: string, choice: WindowChoice) => {
    load();
    const windowFor = { ...state.windowFor };
    if (choice === 'inherit') delete windowFor[key]; else windowFor[key] = choice;
    set({ ...state, windowFor });
  },
  /** "Close GeniusBar when clicking outside it" (#265). */
  setCloseOnClickOut: (on: boolean) => { load(); set({ ...state, closeOnClickOut: on }); },
  /** The preferences as stored now, for a check outside React. */
  current: (): Preferences => { load(); return state; },
  /** Tests only: forget the in-memory copy so the next read loads storage. */
  forget: () => { state = empty; loaded = false; },
};

export function usePreferences(): Preferences {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => { load(); return state; },
    () => empty,
  );
}

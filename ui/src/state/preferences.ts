import { useSyncExternalStore } from 'react';

/**
 * Per-viewer launch preferences. Like the desktop layout, these are a
 * convenience kept in this web view's storage: a storage failure leaves
 * the defaults and nothing else breaks.
 */
export interface Preferences {
  /** Harness new launches start with; null asks every time. */
  defaultHarness: string | null;
}

export const PREFERENCES_KEY = 'gb.preferences';
const empty: Preferences = { defaultHarness: null };
let state: Preferences = empty;
let loaded = false;
const listeners = new Set<() => void>();

/** Stored text back to preferences; anything malformed is dropped. */
export function parsePreferences(raw: string | null): Preferences {
  if (!raw) return empty;
  try {
    const value = JSON.parse(raw) as { defaultHarness?: unknown };
    const harness = typeof value.defaultHarness === 'string' ? value.defaultHarness.trim() : '';
    return { defaultHarness: harness === '' ? null : harness };
  } catch {
    return empty;
  }
}

function load() {
  if (loaded) return;
  loaded = true;
  try { state = parsePreferences(localStorage.getItem(PREFERENCES_KEY)); } catch { /* defaults */ }
}

function set(next: Preferences) {
  state = next;
  try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next)); } catch { /* not remembered */ }
  listeners.forEach((listener) => listener());
}

export const preferenceActions = {
  setDefaultHarness: (harness: string | null) => { load(); set({ ...state, defaultHarness: harness?.trim() || null }); },
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

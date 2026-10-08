import { afterEach, describe, expect, it, vi } from 'vitest';
import { PREFERENCES_KEY, opensInOwnWindow, parsePreferences, preferenceActions, windowChoiceOf } from './preferences';

afterEach(() => { localStorage.clear(); preferenceActions.forget(); vi.restoreAllMocks(); });

const defaults = { defaultHarness: null, ownWindows: false, windowFor: {}, closeOnClickOut: false };

describe('preferences', () => {
  it('reads back what it stored, and drops malformed parts', () => {
    expect(parsePreferences(null)).toEqual(defaults);
    expect(parsePreferences('not json')).toEqual(defaults);
    expect(parsePreferences(JSON.stringify({ defaultHarness: 7 }))).toEqual(defaults);
    expect(parsePreferences(JSON.stringify({ defaultHarness: ' claude ' }))).toEqual({ ...defaults, defaultHarness: 'claude' });
  });

  it('stores and clears the default harness', () => {
    preferenceActions.setDefaultHarness('opencode');
    expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY)!)).toEqual({ ...defaults, defaultHarness: 'opencode' });
    preferenceActions.setDefaultHarness(null);
    expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY)!)).toEqual(defaults);
  });

  it('keeps working when storage throws', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(() => preferenceActions.setDefaultHarness('claude')).not.toThrow();
  });
});

describe('windows and the popup (#264, #265)', () => {
  it('starts in the popup, with the popup staying open on a click outside', () => {
    expect(preferenceActions.current()).toEqual(defaults);
    expect(opensInOwnWindow(defaults, 'user/agent_c')).toBe(false);
  });

  it('reads only true switches and only known per-companion choices', () => {
    expect(parsePreferences(JSON.stringify({ ownWindows: 'yes', closeOnClickOut: 1 }))).toEqual(defaults);
    expect(parsePreferences(JSON.stringify({ ownWindows: true, closeOnClickOut: true }))).toEqual({ ...defaults, ownWindows: true, closeOnClickOut: true });
    expect(parsePreferences(JSON.stringify({ windowFor: { 'a/1': 'window', 'a/2': 'popup', 'a/3': 'inherit', 'a/4': 7 } }))).toEqual(
      { ...defaults, windowFor: { 'a/1': 'window', 'a/2': 'popup' } });
    expect(parsePreferences(JSON.stringify({ windowFor: 'all' }))).toEqual(defaults);
  });

  it('stores the two switches and each companion\'s choice', () => {
    preferenceActions.setOwnWindows(true);
    preferenceActions.setCloseOnClickOut(true);
    preferenceActions.setWindowFor('user/agent_c', 'popup');
    expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY)!)).toEqual(
      { ...defaults, ownWindows: true, closeOnClickOut: true, windowFor: { 'user/agent_c': 'popup' } });
    preferenceActions.setWindowFor('user/agent_c', 'inherit');
    preferenceActions.setOwnWindows(false);
    expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY)!)).toEqual({ ...defaults, closeOnClickOut: true });
    // The next load reads the stored copy back.
    preferenceActions.forget();
    expect(preferenceActions.current().closeOnClickOut).toBe(true);
  });

  it('lets a companion\'s choice win over the app\'s, and inherit follow it', () => {
    const app = { ownWindows: true, windowFor: { 'a/1': 'popup' as const, 'a/2': 'window' as const } };
    expect(opensInOwnWindow(app, 'a/1')).toBe(false);
    expect(opensInOwnWindow(app, 'a/2')).toBe(true);
    expect(opensInOwnWindow(app, 'a/3')).toBe(true);
    expect(opensInOwnWindow({ ...app, ownWindows: false }, 'a/3')).toBe(false);
    expect(opensInOwnWindow({ ...app, ownWindows: false }, 'a/2')).toBe(true);
    expect(windowChoiceOf(app, 'a/1')).toBe('popup');
    expect(windowChoiceOf(app, 'a/3')).toBe('inherit');
  });

  it('follows what another window stored (the storage event)', () => {
    preferenceActions.current();
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ ownWindows: true }));
    window.dispatchEvent(new StorageEvent('storage', { key: PREFERENCES_KEY, newValue: JSON.stringify({ ownWindows: true }) }));
    expect(preferenceActions.current().ownWindows).toBe(true);
    window.dispatchEvent(new StorageEvent('storage', { key: null, newValue: null }));
    expect(preferenceActions.current()).toEqual(defaults);
  });
});

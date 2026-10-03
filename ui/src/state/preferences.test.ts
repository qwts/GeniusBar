import { afterEach, describe, expect, it, vi } from 'vitest';
import { PREFERENCES_KEY, parsePreferences, preferenceActions } from './preferences';

afterEach(() => { localStorage.clear(); preferenceActions.forget(); vi.restoreAllMocks(); });

describe('preferences', () => {
  it('reads back what it stored, and drops malformed parts', () => {
    expect(parsePreferences(null)).toEqual({ defaultHarness: null });
    expect(parsePreferences('not json')).toEqual({ defaultHarness: null });
    expect(parsePreferences(JSON.stringify({ defaultHarness: 7 }))).toEqual({ defaultHarness: null });
    expect(parsePreferences(JSON.stringify({ defaultHarness: ' claude ' }))).toEqual({ defaultHarness: 'claude' });
  });

  it('stores and clears the default harness', () => {
    preferenceActions.setDefaultHarness('opencode');
    expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY)!)).toEqual({ defaultHarness: 'opencode' });
    preferenceActions.setDefaultHarness(null);
    expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY)!)).toEqual({ defaultHarness: null });
  });

  it('keeps working when storage throws', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(() => preferenceActions.setDefaultHarness('claude')).not.toThrow();
  });
});

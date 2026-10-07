import { describe, expect, it } from 'vitest';
import { parseSurface, queryTabOf, sessionTabOf } from './surface';

describe('parseSurface (#223)', () => {
  it('keeps today\'s behaviour without a surface, or with an unknown one', () => {
    expect(parseSurface('')).toEqual({ surface: null, soul: null, tab: null, action: null });
    expect(parseSurface('?surface=nope&soul=')).toEqual({ surface: null, soul: null, tab: null, action: null });
    expect(parseSurface('?surface=tray').surface).toBe('tray');
    expect(parseSurface('?surface=window').surface).toBe('window');
  });

  it('reads a session with its decoded roster key, tab and action', () => {
    expect(parseSurface('?surface=session&soul=user%2Fagent_p&tab=delegation&action=archive'))
      .toEqual({ surface: 'session', soul: 'user/agent_p', tab: 'tree', action: 'archive' });
    expect(parseSurface('?surface=session&soul=user/agent_p&tab=audit&action=delete'))
      .toEqual({ surface: 'session', soul: 'user/agent_p', tab: 'audit', action: null });
  });

  it('reads every window surface', () => {
    for (const surface of ['team', 'audit', 'customize', 'launch'] as const) {
      expect(parseSurface(`?surface=${surface}`).surface).toBe(surface);
    }
    expect(parseSurface('?surface=audit').soul).toBeNull();
  });

  it('maps the URL\'s tab names to the session\'s and back', () => {
    expect(['chat', 'delegation', 'audit', 'details', 'tree', 'x', null].map(sessionTabOf))
      .toEqual(['chat', 'tree', 'audit', 'details', 'tree', null, null]);
    expect(queryTabOf('tree')).toBe('delegation');
    expect(queryTabOf('chat')).toBe('chat');
  });
});

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAYOUT_KEY, layoutActions, parseLayout, useLayout } from './layout';

afterEach(() => { localStorage.clear(); layoutActions.forget(); vi.restoreAllMocks(); });

describe('desktop layout', () => {
  it('reads back what it stored, and drops malformed parts', () => {
    expect(parseLayout(null)).toEqual({ hidden: [], pos: {}, collapsed: [] });
    expect(parseLayout('not json')).toEqual({ hidden: [], pos: {}, collapsed: [] });
    expect(parseLayout(JSON.stringify({ hidden: ['a', 3], pos: { a: { x: 1, y: 2 }, b: { x: 'no' } }, collapsed: 'x' })))
      .toEqual({ hidden: ['a'], pos: { a: { x: 1, y: 2 } }, collapsed: [] });
  });

  it('stores hidden, collapsed and moved teams, and resets', () => {
    layoutActions.setHidden('user/a', true);
    layoutActions.setHidden('user/a', true);
    layoutActions.setCollapsed('user/p', true);
    layoutActions.move('user/p', 40, 50);
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!)).toEqual({ hidden: ['user/a'], pos: { 'user/p': { x: 40, y: 50 } }, collapsed: ['user/p'] });
    layoutActions.showAll();
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!).hidden).toEqual([]);
    layoutActions.reset();
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!)).toEqual({ hidden: [], pos: {}, collapsed: [] });
  });

  it('hides and shows a whole team at once, keeping other hidden companions', () => {
    layoutActions.setHidden('user/x', true);
    layoutActions.setHidden('user/a', true);
    layoutActions.setTeamHidden(['user/p', 'user/a', 'user/b'], true);
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!).hidden).toEqual(['user/x', 'user/a', 'user/p', 'user/b']);
    layoutActions.setTeamHidden(['user/p', 'user/a', 'user/b'], false);
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!).hidden).toEqual(['user/x']);
  });

  it('keeps working when storage throws', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(() => layoutActions.setHidden('user/a', true)).not.toThrow();
  });
});

describe('desktop layout across windows (#223)', () => {
  it('keeps "Companions on the desktop" on unless switched off, through a reset', () => {
    expect(parseLayout(null).desktopWindows).toBeUndefined();
    expect(parseLayout(JSON.stringify({ desktopWindows: true })).desktopWindows).toBeUndefined();
    layoutActions.setDesktopWindows(false);
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!).desktopWindows).toBe(false);
    layoutActions.reset();
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!)).toEqual({ hidden: [], pos: {}, collapsed: [], desktopWindows: false });
    layoutActions.setDesktopWindows(true);
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!)).toEqual({ hidden: [], pos: {}, collapsed: [] });
  });

  it('keeps native windows\' screen positions apart from the in-window desktop\'s', () => {
    layoutActions.move('user/p', 16, 16);
    layoutActions.place('user/p', 1400, 820);
    const stored = JSON.parse(localStorage.getItem(LAYOUT_KEY)!);
    expect(stored.pos).toEqual({ 'user/p': { x: 16, y: 16 } });
    expect(stored.screen).toEqual({ 'user/p': { x: 1400, y: 820 } });
    expect(parseLayout(JSON.stringify(stored)).screen).toEqual({ 'user/p': { x: 1400, y: 820 } });
  });

  it('remembers each team window\'s measured size, and drops malformed ones', () => {
    layoutActions.measure('user/p', 300, 176);
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!).size).toEqual({ 'user/p': { width: 300, height: 176 } });
    expect(parseLayout(JSON.stringify({ size: { a: { width: 0, height: 4 }, b: { width: 'x' }, c: { width: 2, height: 3 } } })).size)
      .toEqual({ c: { width: 2, height: 3 } });
  });

  it('reloads when another window writes, and tells its listeners', () => {
    const seen: unknown[] = [];
    function Probe() { seen.push(useLayout()); return null; }
    render(<Probe />);
    const next = { hidden: ['user/a'], pos: { 'user/p': { x: 5, y: 6 } }, collapsed: [] };
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: LAYOUT_KEY, newValue: JSON.stringify(next) })); });
    expect(seen.at(-1)).toEqual(next);
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'gb.lang', newValue: 'es' })); });
    expect(seen.at(-1)).toEqual(next);
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: null })); });
    expect(seen.at(-1)).toEqual({ hidden: [], pos: {}, collapsed: [] });
    cleanup();
  });
});

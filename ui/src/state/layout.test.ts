import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAYOUT_KEY, layoutActions, parseLayout } from './layout';

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

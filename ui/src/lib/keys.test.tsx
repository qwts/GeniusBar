import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { menuKeys, tabStep } from './keys';

afterEach(cleanup);

describe('tabStep', () => {
  const tabs = ['a', 'b', 'c'] as const;
  it('wraps Left and Right, and jumps with Home and End', () => {
    expect(tabStep('ArrowRight', tabs, 'c')).toBe('a');
    expect(tabStep('ArrowLeft', tabs, 'a')).toBe('c');
    expect(tabStep('Home', tabs, 'b')).toBe('a');
    expect(tabStep('End', tabs, 'a')).toBe('c');
    expect(tabStep('Enter', tabs, 'a')).toBeNull();
  });
});

describe('menuKeys', () => {
  it('moves focus over the enabled items, wrapping, with Home and End', () => {
    render(
      <div role="menu" onKeyDown={menuKeys}>
        <button type="button" role="menuitem">One</button>
        <button type="button" role="menuitem" disabled>Off</button>
        <button type="button" role="menuitemradio">Two</button>
        <button type="button" role="menuitem">Three</button>
      </div>,
    );
    const menu = screen.getByRole('menu');
    const item = (name: string) => screen.getByRole(name === 'Two' ? 'menuitemradio' : 'menuitem', { name });
    item('One').focus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(item('Two'));
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(item('Three'));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(item('One'));
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(item('Three'));
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(item('One'));
  });
});

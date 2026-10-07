import type { KeyboardEvent } from 'react';

/**
 * The tab a tablist key moves to, as Radix Tabs: Left and Right wrap, Home
 * and End go to the first and last. Null for any other key.
 */
export function tabStep<T>(key: string, tabs: readonly T[], active: T): T | null {
  const n = tabs.length;
  if (!n) return null;
  const i = Math.max(0, tabs.indexOf(active));
  switch (key) {
    case 'ArrowRight': return tabs[(i + 1) % n];
    case 'ArrowLeft': return tabs[(i - 1 + n) % n];
    case 'Home': return tabs[0];
    case 'End': return tabs[n - 1];
    default: return null;
  }
}

const MENU_KEYS = ['ArrowDown', 'ArrowUp', 'Home', 'End'];

/**
 * Up and Down (wrapping), Home and End move focus between a hand-rolled
 * `role="menu"`'s enabled items, as Radix DropdownMenu and ContextMenu do.
 * Put it on the menu's onKeyDown; Escape and focus return stay the menu's.
 */
export function menuKeys(e: KeyboardEvent<HTMLElement>) {
  if (!MENU_KEYS.includes(e.key)) return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])'));
  if (!items.length) return;
  e.preventDefault();
  const n = items.length;
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1
    : e.key === 'ArrowDown' ? (i + 1) % n : i <= 0 ? n - 1 : i - 1;
  items[next]?.focus();
}

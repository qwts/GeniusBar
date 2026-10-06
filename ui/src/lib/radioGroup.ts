import type { KeyboardEvent } from 'react';

const KEYS = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];

/**
 * Arrow keys, Home and End move the selection in a hand-rolled
 * `role="radiogroup"` (the design's a11y helper): focus moves to the next
 * enabled `role="radio"` and clicks it, wrapping at either end. Pair it
 * with roving `tabIndex` (the checked radio 0, the others -1).
 */
export function radioGroupKeys(e: KeyboardEvent<HTMLElement>) {
  if (!KEYS.includes(e.key)) return;
  const radios = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not([disabled])'));
  if (!radios.length) return;
  e.preventDefault();
  const i = Math.max(0, radios.indexOf(document.activeElement as HTMLElement));
  const n = radios.length;
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1
    : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n;
  radios[next]?.focus();
  radios[next]?.click();
}

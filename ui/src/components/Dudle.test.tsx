import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveDudle, type DudleSpec } from '../model/dudle';
import { Dudle } from './Dudle';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const spec = (blush: number): DudleSpec => ({ ...deriveDudle('agent_1'), blush });
const eyeRy = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('[data-part="eye"]')).map((e) => Number(e.getAttribute('ry')));

describe('Dudle', () => {
  it('is an image with a name when labelled, decorative otherwise', () => {
    render(<Dudle spec={spec(0)} label="Avatar for luna" paused />);
    expect(screen.getByRole('img', { name: 'Avatar for luna' })).toBeTruthy();
    cleanup();
    const { container } = render(<Dudle spec={spec(0)} paused />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws two eyes, and cheeks only above the blush threshold', () => {
    const { container } = render(<Dudle spec={spec(0.2)} paused />);
    expect(container.querySelectorAll('[data-part="eye"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-part="cheek"]')).toHaveLength(0);
    cleanup();
    const blushing = render(<Dudle spec={spec(0.9)} paused />);
    expect(blushing.container.querySelectorAll('[data-part="cheek"]')).toHaveLength(2);
  });

  it('blinks while animating and keeps the eyes open while paused', () => {
    vi.useFakeTimers();
    // 0.07 s into a blink period on R1's 2001 reference clock: mid-blink.
    vi.setSystemTime(978_307_200_000 + 3_600 * 1000 + 70);
    const s = spec(0);
    const open = s.sizeWobble * 14 * 0.38 * s.eyeScale;
    const { container, rerender } = render(<Dudle spec={s} />);
    act(() => {
      vi.advanceTimersByTime(50);
    });
    // 50 ms later is still inside the 140 ms closed window.
    for (const ry of eyeRy(container)) expect(ry).toBeLessThan(open);
    rerender(<Dudle spec={s} paused />);
    for (const ry of eyeRy(container)) expect(ry).toBeCloseTo(open, 9);
  });
});

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveDudle } from '../model/dudle';
import { Dudle } from './Dudle';

afterEach(cleanup);

const spec = deriveDudle('agent_1');
const body = (c: HTMLElement) => c.querySelector('[data-part="body"]')?.getAttribute('fill');

describe('Dudle', () => {
  it('is an image with a name when labelled, decorative otherwise', () => {
    render(<Dudle spec={spec} label="Avatar for luna" paused />);
    expect(screen.getByRole('img', { name: 'Avatar for luna' })).toBeTruthy();
    cleanup();
    const { container } = render(<Dudle spec={spec} paused />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws the design: body, two eyes and two cheeks, coloured by the soul hue', () => {
    const { container } = render(<Dudle spec={spec} />);
    expect(container.querySelectorAll('[data-part="eye"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-part="cheek"]')).toHaveLength(2);
    expect(body(container)).toBe(`hsl(${Math.round(spec.bodyHue * 360)} 70% 62%)`);
  });

  it('keeps a soul\'s colour stable and different souls apart', () => {
    const a = render(<Dudle spec={deriveDudle('agent_1')} />).container;
    const fillA = body(a);
    cleanup();
    expect(body(render(<Dudle spec={deriveDudle('agent_1')} />).container)).toBe(fillA);
    cleanup();
    expect(body(render(<Dudle spec={deriveDudle('agent_abc123')} />).container)).not.toBe(fillA);
  });

  it('marks state for its animation, fades when dim, and stops when paused', () => {
    const { container, rerender } = render(<Dudle spec={spec} state="awaiting" />);
    const svg = () => container.querySelector('svg')!;
    expect(svg().getAttribute('data-state')).toBe('awaiting');
    expect(svg().getAttribute('data-paused')).toBeNull();
    rerender(<Dudle spec={spec} dim />);
    expect(svg().getAttribute('data-state')).toBe('offline');
    expect(body(container)).toContain('45%');
    rerender(<Dudle spec={spec} paused />);
    expect(svg().getAttribute('data-paused')).toBe('true');
  });
});

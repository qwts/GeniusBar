import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sampleCensus } from '../model/fixtures';
import { SoulDetail } from './SoulDetail';

afterEach(cleanup);

const [luna, child] = sampleCensus;

function field(term: string): string | null {
  const dt = screen.getByText(term, { selector: 'dt' });
  return dt.nextElementSibling?.textContent ?? null;
}

describe('SoulDetail', () => {
  it('lists the read-only fields with roster fallbacks', () => {
    render(<SoulDetail soul={child} roster={sampleCensus} paused onDone={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'agent_c, agent_c' });
    expect(within(dialog).getByRole('img', { name: 'Avatar for agent_c' })).toBeTruthy();
    expect(field('Account')).toBe('user');
    expect(field('Harness')).toBe('unknown harness');
    expect(field('Presence')).toBe('watching');
    expect(field('Parent')).toBe('lunaagent_p');
    expect(field('Unacked')).toBe('3');
    expect(field('Last wake')).toBe('none');
    // Principal-client fields appear only when the row carries them.
    expect(screen.queryByText('Hardened')).toBeNull();
  });

  it('falls back to the raw parent ID without a roster, and none for roots', () => {
    render(<SoulDetail soul={child} paused onDone={() => {}} />);
    expect(field('Parent')).toBe('agent_p');
    cleanup();
    render(<SoulDetail soul={luna} paused onDone={() => {}} />);
    expect(field('Parent')).toBe('none');
    expect(field('Verification')).toBe('verified');
    expect(field('Hardened')).toBe('yes');
    expect(field('Daemon watching')).toBe('yes');
  });

  it('focuses Done, which closes it, as does Escape', () => {
    const onDone = vi.fn();
    render(<SoulDetail soul={luna} paused onDone={onDone} />);
    const done = screen.getByRole('button', { name: 'Done' });
    expect(document.activeElement).toBe(done);
    fireEvent.click(done);
    fireEvent.keyDown(done, { key: 'Escape' });
    expect(onDone).toHaveBeenCalledTimes(2);
  });
});

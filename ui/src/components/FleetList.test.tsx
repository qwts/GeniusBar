import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSoulForest } from '../model/census';
import { sampleCensus } from '../model/fixtures';
import { FleetList } from './FleetList';

afterEach(cleanup);

const forest = buildSoulForest(sampleCensus);
const [luna, child, left] = sampleCensus;

describe('FleetList', () => {
  it('groups teams with subagents indented beneath their lead, and opens any row', () => {
    const onOpen = vi.fn();
    render(<FleetList forest={forest} paused onOpen={onOpen} />);
    const team = screen.getByRole('list', { name: 'luna' });
    const rows = within(team).getAllByRole('button');
    expect(rows.map((r) => r.style.paddingLeft)).toEqual(['4px', '18px']);
    fireEvent.click(rows[1]);
    expect(onOpen).toHaveBeenCalledWith(child);
    // Left companions stay listed, and open, with their explanation spoken.
    const gone = screen.getByRole('button', { name: /^old,.*no longer available/ });
    fireEvent.click(gone);
    expect(onOpen).toHaveBeenLastCalledWith(left);
  });

  it('narrows the list as the owner searches', () => {
    render(<FleetList forest={forest} paused onOpen={() => {}} />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search companions…' }), { target: { value: 'agent_c' } });
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['agent_c, unknown harness, Starting']);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
    expect(screen.getByText('No companions found')).toBeTruthy();
  });

  it('shows unread badges, and hide toggles only when given', () => {
    const onToggle = vi.fn();
    const { rerender } = render(<FleetList forest={forest} paused onOpen={() => {}} unreadOf={(s) => (s === luna ? 2 : 0)} />);
    expect(screen.getByRole('button', { name: /^luna,.*2 unread messages/ }).textContent).toContain('2 new');
    expect(screen.queryByRole('button', { name: /^Hide from desktop/ })).toBeNull();
    rerender(<FleetList forest={forest} paused onOpen={() => {}} hiding={{ hidden: ['user/agent_c'], onToggle, onShowAll: () => {} }} />);
    const show = screen.getByRole('button', { name: 'Show on desktop: agent_c' });
    expect(show.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(show);
    expect(onToggle).toHaveBeenCalledWith('user/agent_c', false);
    expect(screen.getByRole('button', { name: 'Show all hidden (1)' })).toBeTruthy();
  });

  it('shows the empty text instead of a search for an empty fleet', () => {
    render(<FleetList forest={[]} paused onOpen={() => {}} empty={<p>nobody here</p>} />);
    expect(screen.getByRole('region', { name: 'Fleet' }).textContent).toBe('nobody here');
    expect(screen.queryByRole('searchbox')).toBeNull();
  });
});

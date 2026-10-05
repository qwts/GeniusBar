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

  it('keeps left companions openable with their visible explanation, and hints that rows show details', () => {
    const onOpen = vi.fn();
    render(<FleetList forest={buildSoulForest([left])} paused onOpen={onOpen} />);
    expect(screen.getByText(/no longer available/)).toBeTruthy();
    const row = screen.getByRole('button', { name: /^old,/ });
    expect(row.getAttribute('title')).toBe('Show details for old');
    expect(row.getAttribute('aria-description')).toBe('Shows details.');
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith(left);
  });

  it('heads each team with its lead, then lists souls with no team last', () => {
    render(<FleetList forest={buildSoulForest([left, ...sampleCensus.filter((s) => s !== left)])} paused onOpen={() => {}} />);
    const lists = screen.getAllByRole('list').slice(1).map((l) => l.getAttribute('aria-label'));
    expect(lists.indexOf('old')).toBeGreaterThan(lists.indexOf('luna'));
    expect(screen.getByText('luna', { selector: 'p' })).toBeTruthy();
    expect(screen.getByText('No team')).toBeTruthy();
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
    rerender(<FleetList forest={forest} paused onOpen={() => {}} hiding={{ hidden: ['user/agent_c'], onToggle, onToggleTeam: () => {}, onShowAll: () => {} }} />);
    const show = screen.getByRole('button', { name: 'Show on desktop: agent_c' });
    expect(show.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(show);
    expect(onToggle).toHaveBeenCalledWith('user/agent_c', false);
    expect(screen.getByRole('button', { name: 'Show all hidden (1)' })).toBeTruthy();
  });

  it('hides a whole team from its lead, and single companions from their own rows', () => {
    const onToggle = vi.fn();
    const onToggleTeam = vi.fn();
    render(<FleetList forest={forest} paused onOpen={() => {}} hiding={{ hidden: [], onToggle, onToggleTeam, onShowAll: () => {} }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide team from desktop: luna' }));
    expect(onToggleTeam).toHaveBeenCalledWith(['user/agent_p', 'user/agent_c'], true);
    // Searching narrows the rows, not the team that hiding acts on.
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'luna' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hide team from desktop: luna' }));
    expect(onToggleTeam).toHaveBeenLastCalledWith(['user/agent_p', 'user/agent_c'], true);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hide from desktop: agent_c' }));
    expect(onToggle).toHaveBeenCalledWith('user/agent_c', true);
    // The lead keeps its own eye for hiding just itself.
    fireEvent.click(screen.getByRole('button', { name: 'Hide from desktop: luna' }));
    expect(onToggle).toHaveBeenLastCalledWith('user/agent_p', true);
  });

  it('shows the empty text instead of a search for an empty fleet', () => {
    render(<FleetList forest={[]} paused onOpen={() => {}} empty={<p>nobody here</p>} />);
    expect(screen.getByRole('region', { name: 'Fleet' }).textContent).toBe('nobody here');
    expect(screen.queryByRole('searchbox')).toBeNull();
  });
});

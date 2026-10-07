import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamWindowSpec } from './bridge';
import { buildSoulForest, type CensusRow } from './model/census';
import { sampleCensus } from './model/fixtures';
import type { DesktopLayout } from './state/layout';
import { TEAM_RETRY_MAX_MS, TEAM_RETRY_MS, TEAM_SYNC_MS, teamWindowList, useTeamWindows } from './useTeamWindows';

const row = (agentId: string, parent: string | null): CensusRow =>
  ({ account: 'user', agentId, name: agentId, harness: 'claude', parent, presence: 'joined', unacked: 0, lastWake: null });
const census = [row('lead', null), ...['a', 'b', 'c', 'd', 'e'].map((id) => row(id, 'lead')), row('solo', null)];
const forest = buildSoulForest(census);
const base: DesktopLayout = { hidden: [], pos: {}, collapsed: [] };

describe('teamWindowList (#223)', () => {
  it('sizes each team as the desktop does, solo cards slim', () => {
    expect(teamWindowList(forest, base)).toEqual([
      { key: 'user/lead', width: 300, height: 64 + 2 * 68 + 12 },
      { key: 'user/solo', width: 200, height: 64 },
    ]);
  });

  it('drops hidden teams, keeps a hidden lead with visible subagents, and collapses', () => {
    expect(teamWindowList(forest, { ...base, hidden: ['user/solo'] }).map((t) => t.key)).toEqual(['user/lead']);
    expect(teamWindowList(forest, { ...base, hidden: ['user/lead'] })[0]).toEqual({ key: 'user/lead', width: 300, height: 212 });
    expect(teamWindowList(forest, { ...base, hidden: ['user/lead', 'user/a', 'user/b', 'user/c', 'user/d', 'user/e'] }).map((t) => t.key))
      .toEqual(['user/solo']);
    expect(teamWindowList(forest, { ...base, collapsed: ['user/lead'] })[0]).toEqual({ key: 'user/lead', width: 300, height: 64 });
    // Four visible members fit one row.
    expect(teamWindowList(forest, { ...base, hidden: ['user/e'] })[0].height).toBe(64 + 68 + 12);
  });

  it('passes saved screen positions, rounded, and the size the window measured; never the in-window desktop\'s', () => {
    const layout = { ...base, pos: { 'user/solo': { x: 16, y: 16 } }, screen: { 'user/lead': { x: 10.4, y: 20.6 } }, size: { 'user/solo': { width: 210, height: 70 } } };
    expect(teamWindowList(forest, layout)).toEqual([
      { key: 'user/lead', x: 10, y: 21, width: 300, height: 212 },
      { key: 'user/solo', width: 210, height: 70 },
    ]);
  });

  it('is empty with "Companions on the desktop" off', () => {
    expect(teamWindowList(forest, { ...base, desktopWindows: false })).toEqual([]);
    expect(teamWindowList(buildSoulForest(sampleCensus), { ...base, desktopWindows: false })).toEqual([]);
  });
});

describe('useTeamWindows (#223)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  function Probe({ layout, enabled = true, sync }: { layout: DesktopLayout; enabled?: boolean; sync: (teams: TeamWindowSpec[]) => Promise<boolean> }) {
    useTeamWindows(forest, layout, enabled, sync);
    return null;
  }

  it('syncs once per change, debounced, and not while disabled', async () => {
    const sync = vi.fn(async () => true);
    const view = render(<Probe layout={base} enabled={false} sync={sync} />);
    await act(async () => { vi.advanceTimersByTime(TEAM_SYNC_MS * 2); });
    expect(sync).not.toHaveBeenCalled();
    view.rerender(<Probe layout={base} sync={sync} />);
    view.rerender(<Probe layout={{ ...base }} sync={sync} />);
    await act(async () => { vi.advanceTimersByTime(TEAM_SYNC_MS - 1); });
    expect(sync).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.mock.calls[0]).toEqual([teamWindowList(forest, base)]);
    // The same list again (a census poll, an equal layout) is not resent.
    view.rerender(<Probe layout={{ ...base, hidden: [] }} sync={sync} />);
    await act(async () => { vi.advanceTimersByTime(TEAM_SYNC_MS); });
    expect(sync).toHaveBeenCalledTimes(1);
    view.rerender(<Probe layout={{ ...base, collapsed: ['user/lead'] }} sync={sync} />);
    await act(async () => { vi.advanceTimersByTime(TEAM_SYNC_MS); });
    expect(sync).toHaveBeenCalledTimes(2);
    // Switched off: an empty list closes every team window.
    view.rerender(<Probe layout={{ ...base, desktopWindows: false }} sync={sync} />);
    await act(async () => { vi.advanceTimersByTime(TEAM_SYNC_MS); });
    expect(sync).toHaveBeenLastCalledWith([]);
  });

  it('sends a failed list again after a growing wait, and forgets the failure once a sync lands', async () => {
    let fail = 2;
    const sync = vi.fn(async (_teams: TeamWindowSpec[]) => { if (fail > 0) { fail -= 1; throw new Error('settling'); } return true; });
    const view = render(<Probe layout={base} sync={sync} />);
    await act(async () => { vi.advanceTimersByTime(TEAM_SYNC_MS); });
    expect(sync).toHaveBeenCalledTimes(1);
    // First retry after TEAM_RETRY_MS, the second after twice that; the list is unchanged.
    await act(async () => { vi.advanceTimersByTime(TEAM_RETRY_MS - 1); });
    expect(sync).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(sync).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(TEAM_RETRY_MS * 2 - 1); });
    expect(sync).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(sync).toHaveBeenCalledTimes(3);
    expect(sync.mock.calls.every(([teams]) => JSON.stringify(teams) === JSON.stringify(teamWindowList(forest, base)))).toBe(true);
    // Landed: no more retries, and the next change goes out after the usual debounce.
    await act(async () => { vi.advanceTimersByTime(TEAM_RETRY_MAX_MS); });
    expect(sync).toHaveBeenCalledTimes(3);
    view.rerender(<Probe layout={{ ...base, collapsed: ['user/lead'] }} sync={sync} />);
    await act(async () => { vi.advanceTimersByTime(TEAM_SYNC_MS); });
    expect(sync).toHaveBeenCalledTimes(4);
  });

  it('a change while a retry is pending goes out with the new list, and disabling cancels the retry', async () => {
    const sync = vi.fn(async () => { throw new Error('settling'); });
    const view = render(<Probe layout={base} sync={sync} />);
    await act(async () => { vi.advanceTimersByTime(TEAM_SYNC_MS); });
    expect(sync).toHaveBeenCalledTimes(1);
    view.rerender(<Probe layout={{ ...base, collapsed: ['user/lead'] }} sync={sync} />);
    await act(async () => { vi.advanceTimersByTime(TEAM_RETRY_MS); });
    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenLastCalledWith(teamWindowList(forest, { ...base, collapsed: ['user/lead'] }));
    view.rerender(<Probe layout={{ ...base, collapsed: ['user/lead'] }} enabled={false} sync={sync} />);
    await act(async () => { vi.advanceTimersByTime(TEAM_RETRY_MAX_MS * 2); });
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('stops for good after the shell says false', async () => {
    const sync = vi.fn(async () => false);
    const view = render(<Probe layout={base} sync={sync} />);
    await act(async () => { vi.advanceTimersByTime(TEAM_SYNC_MS); });
    expect(sync).toHaveBeenCalledTimes(1);
    view.rerender(<Probe layout={{ ...base, collapsed: ['user/lead'] }} sync={sync} />);
    await act(async () => { vi.advanceTimersByTime(TEAM_SYNC_MS * 3); });
    expect(sync).toHaveBeenCalledTimes(1);
  });
});

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, type NativeSurfaces } from './App';
import type { SurfaceRequest } from './bridge';
import { sampleCensus, sampleConnection } from './model/fixtures';
import { LAYOUT_KEY, layoutActions } from './state/layout';
import type { LaunchApi } from './useLaunch';

afterEach(() => { cleanup(); vi.useRealTimers(); globalThis.localStorage?.clear(); layoutActions.forget(); });

function fakeSurfaces(opens = true) {
  const opened: SurfaceRequest[] = [];
  const surfaces: NativeSurfaces = {
    open: vi.fn(async (request: SurfaceRequest) => { opened.push(request); if (!opens) throw new Error('no window'); }),
    hide: vi.fn(async () => {}),
    sync: vi.fn(async () => true),
  };
  return { opened, surfaces };
}

const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
const connected = { ...sampleConnection, lastRefresh: new Date(0) };

describe('the popup\'s native windows (#223)', () => {
  it('opens a companion\'s session in its own window and hides the popup', async () => {
    const { opened, surfaces } = fakeSurfaces();
    render(<App census={sampleCensus} connection={connected} surfaces={surfaces} />);
    fireEvent.click(screen.getByRole('button', { name: /^agent_c,/ }));
    await waitFor(() => expect(surfaces.hide).toHaveBeenCalled());
    expect(opened).toEqual([{ surface: 'session', soul: 'user/agent_c' }]);
    // The popup stays on the fleet.
    expect(screen.getByRole('region', { name: 'Fleet' })).toBeTruthy();
  });

  it('falls back to the in-popup session when the window cannot open', async () => {
    const { surfaces } = fakeSurfaces(false);
    render(<App census={sampleCensus} connection={connected} surfaces={surfaces} />);
    fireEvent.click(screen.getByRole('button', { name: /^agent_c,/ }));
    expect(await screen.findByRole('region', { name: 'agent_c, agent_c' })).toBeTruthy();
    expect(surfaces.hide).not.toHaveBeenCalled();
  });

  it('opens the audit log and the launch dialog in windows, else in the popup', async () => {
    const { opened, surfaces } = fakeSurfaces();
    render(<App census={sampleCensus} connection={connected} surfaces={surfaces} launcher={launcher} />);
    fireEvent.click(screen.getByRole('button', { name: 'Audit log' }));
    fireEvent.click(screen.getByRole('button', { name: 'Launch companion' }));
    await waitFor(() => expect(opened).toEqual([{ surface: 'audit' }, { surface: 'launch' }]));
    expect(screen.queryByRole('dialog', { name: 'Launch a new companion' })).toBeNull();
    cleanup();
    const failing = fakeSurfaces(false);
    render(<App census={sampleCensus} connection={connected} surfaces={failing.surfaces} launcher={launcher} />);
    fireEvent.click(screen.getByRole('button', { name: 'Audit log' }));
    expect(await screen.findByRole('region', { name: 'Audit log' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Launch companion' }));
    expect(await screen.findByRole('dialog', { name: 'Launch a new companion' })).toBeTruthy();
  });

  it('keeps every team\'s window in step, and the ⋯ switch turns them off', async () => {
    vi.useFakeTimers();
    const { surfaces } = fakeSurfaces();
    render(<App census={sampleCensus} connection={connected} surfaces={surfaces} />);
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(surfaces.sync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(surfaces.sync).mock.calls[0][0].map((t) => t.key)).toEqual(['user/agent_p', 'user/agent_gone']);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const item = screen.getByRole('menuitemcheckbox', { name: 'Companions on the desktop' });
    expect(item.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(item);
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!).desktopWindows).toBe(false);
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(surfaces.sync).toHaveBeenLastCalledWith([]);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('menuitemcheckbox', { name: 'Companions on the desktop' }).getAttribute('aria-checked')).toBe('false');
  });

  it('waits for a census before syncing, so a starting popup closes no window', async () => {
    vi.useFakeTimers();
    const { surfaces } = fakeSurfaces();
    render(<App census={[]} connection={sampleConnection} surfaces={surfaces} />);
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(surfaces.sync).not.toHaveBeenCalled();
  });

  it('changes nothing outside the app', () => {
    render(<App census={sampleCensus} connection={connected} onRefresh={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Companions on the desktop' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^agent_c,/ }));
    expect(screen.getByRole('region', { name: 'agent_c, agent_c' })).toBeTruthy();
  });
});

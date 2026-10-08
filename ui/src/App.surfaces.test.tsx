import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, type NativeSurfaces } from './App';
import type { SurfaceRequest } from './bridge';
import { sampleCensus, sampleConnection } from './model/fixtures';
import { LAYOUT_KEY, layoutActions } from './state/layout';
import { PREFERENCES_KEY, preferenceActions } from './state/preferences';
import type { LaunchApi } from './useLaunch';

afterEach(() => { cleanup(); vi.useRealTimers(); globalThis.localStorage?.clear(); layoutActions.forget(); preferenceActions.forget(); });

function fakeSurfaces(opens = true) {
  const opened: SurfaceRequest[] = [];
  const surfaces: NativeSurfaces = {
    open: vi.fn(async (request: SurfaceRequest) => { opened.push(request); if (!opens) throw new Error('no window'); }),
    hide: vi.fn(async () => {}),
    sync: vi.fn(async () => true),
    perimeter: vi.fn(async () => true),
    autohide: vi.fn(async () => {}),
  };
  return { opened, surfaces };
}

/** The footer ⋯ menu's switch by name, opened fresh. */
function menuSwitch(name: string) {
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  return screen.getByRole('menuitemcheckbox', { name });
}

const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
const connected = { ...sampleConnection, lastRefresh: new Date(0) };

describe('the popup\'s native windows (#223)', () => {
  it('opens a companion\'s session in its own window and hides the popup, once asked to (#264)', async () => {
    preferenceActions.setOwnWindows(true);
    const { opened, surfaces } = fakeSurfaces();
    render(<App census={sampleCensus} connection={connected} surfaces={surfaces} />);
    fireEvent.click(screen.getByRole('button', { name: /^agent_c,/ }));
    await waitFor(() => expect(surfaces.hide).toHaveBeenCalled());
    expect(opened).toEqual([{ surface: 'session', soul: 'user/agent_c' }]);
    // The popup stays on the fleet.
    expect(screen.getByRole('region', { name: 'Fleet' })).toBeTruthy();
  });

  it('falls back to the in-popup session when the window cannot open', async () => {
    preferenceActions.setOwnWindows(true);
    const { surfaces } = fakeSurfaces(false);
    render(<App census={sampleCensus} connection={connected} surfaces={surfaces} />);
    fireEvent.click(screen.getByRole('button', { name: /^agent_c,/ }));
    expect(await screen.findByRole('region', { name: 'agent_c, agent_c' })).toBeTruthy();
    expect(surfaces.hide).not.toHaveBeenCalled();
  });

  it('opens the audit log and the launch dialog in windows once asked to, else in the popup', async () => {
    preferenceActions.setOwnWindows(true);
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

  it('waits for the population read too, so an archived soul never flashes a card', async () => {
    vi.useFakeTimers();
    const { surfaces } = fakeSurfaces();
    const { rerender } = render(<App census={sampleCensus} connection={connected} surfaces={surfaces} rosterSettled={false} />);
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(surfaces.sync).not.toHaveBeenCalled();
    rerender(<App census={sampleCensus} connection={connected} surfaces={surfaces} rosterSettled />);
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(surfaces.sync).toHaveBeenCalledTimes(1);
  });

  it('opens the perimeter over the screen while a soul drives it, and closes it after (#122)', async () => {
    const { surfaces } = fakeSurfaces();
    const driving = { comms: new Set<string>(), computerUse: new Set(['agent_c']), busy: new Set<string>() };
    const idle = { comms: new Set<string>(), computerUse: new Set<string>(), busy: new Set<string>() };
    const { rerender } = render(<App census={sampleCensus} connection={connected} surfaces={surfaces} badges={idle} />);
    await waitFor(() => expect(surfaces.perimeter).toHaveBeenCalledWith(false));
    rerender(<App census={sampleCensus} connection={connected} surfaces={surfaces} badges={driving} />);
    await waitFor(() => expect(surfaces.perimeter).toHaveBeenCalledWith(true));
    rerender(<App census={sampleCensus} connection={connected} surfaces={surfaces} badges={idle} />);
    await waitFor(() => expect(surfaces.perimeter).toHaveBeenCalledTimes(3));
    expect(surfaces.perimeter).toHaveBeenLastCalledWith(false);
  });

  it('changes nothing outside the app', () => {
    render(<App census={sampleCensus} connection={connected} onRefresh={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Companions on the desktop' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^agent_c,/ }));
    expect(screen.getByRole('region', { name: 'agent_c, agent_c' })).toBeTruthy();
  });
});

describe('in-parent by default, pop-out by choice (#264)', () => {
  it('shows a companion\'s session inside the popup, with a pop-out to its own window on the same tab', async () => {
    const { opened, surfaces } = fakeSurfaces();
    render(<App census={sampleCensus} connection={connected} surfaces={surfaces} />);
    fireEvent.click(screen.getByRole('button', { name: /^agent_c,/ }));
    const session = screen.getByRole('region', { name: 'agent_c, agent_c' });
    expect(opened).toEqual([]);
    expect(surfaces.hide).not.toHaveBeenCalled();
    // The in-popup session keeps its back button, sandbox pill and ⓘ (Lovable), plus the pop-out.
    expect(screen.getByRole('button', { name: 'Back to fleet' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Audit log' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open in its own window' }));
    await waitFor(() => expect(surfaces.hide).toHaveBeenCalled());
    expect(opened).toEqual([{ surface: 'session', soul: 'user/agent_c', tab: 'audit' }]);
    // The popup goes back to the fleet behind the window.
    await waitFor(() => expect(screen.queryByRole('region', { name: 'agent_c, agent_c' })).toBeNull());
    expect(screen.getByRole('region', { name: 'Fleet' })).toBeTruthy();
    expect(session.isConnected).toBe(false);
  });

  it('keeps the session in the popup when the pop-out window cannot open', async () => {
    const { surfaces } = fakeSurfaces(false);
    render(<App census={sampleCensus} connection={connected} surfaces={surfaces} />);
    fireEvent.click(screen.getByRole('button', { name: /^agent_c,/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Open in its own window' }));
    await waitFor(() => expect(surfaces.open).toHaveBeenCalled());
    expect(screen.getByRole('region', { name: 'agent_c, agent_c' })).toBeTruthy();
  });

  it('the ⋯ switch "Open conversations in their own window" is off, stored, and opens windows when on', async () => {
    const { opened, surfaces } = fakeSurfaces();
    render(<App census={sampleCensus} connection={connected} surfaces={surfaces} launcher={launcher} />);
    const item = menuSwitch('Open conversations in their own window');
    expect(item.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(item);
    expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY)!).ownWindows).toBe(true);
    expect(menuSwitch('Open conversations in their own window').getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: /^agent_c,/ }));
    await waitFor(() => expect(opened).toEqual([{ surface: 'session', soul: 'user/agent_c' }]));
    expect(screen.queryByRole('region', { name: 'agent_c, agent_c' })).toBeNull();
  });

  it('lets one companion choose for itself, over the app\'s setting', async () => {
    preferenceActions.setWindowFor('user/agent_c', 'window');
    const { opened, surfaces } = fakeSurfaces();
    const { unmount } = render(<App census={sampleCensus} connection={connected} surfaces={surfaces} />);
    fireEvent.click(screen.getByRole('button', { name: /^agent_c,/ }));
    await waitFor(() => expect(opened).toEqual([{ surface: 'session', soul: 'user/agent_c' }]));
    // Another companion still opens in the popup.
    fireEvent.click(screen.getByRole('button', { name: /^luna,/ }));
    expect(screen.getByRole('region', { name: /^luna,/ })).toBeTruthy();
    expect(opened).toHaveLength(1);
    unmount();
    // With the app on, a companion kept inside stays inside.
    preferenceActions.setOwnWindows(true);
    preferenceActions.setWindowFor('user/agent_c', 'popup');
    render(<App census={sampleCensus} connection={connected} surfaces={surfaces} />);
    fireEvent.click(screen.getByRole('button', { name: /^agent_c,/ }));
    expect(screen.getByRole('region', { name: 'agent_c, agent_c' })).toBeTruthy();
    expect(opened).toHaveLength(1);
  });

  it('offers the companion\'s choice in its ⓘ details, following the app\'s by default', () => {
    const { surfaces } = fakeSurfaces();
    render(<App census={sampleCensus} connection={connected} surfaces={surfaces} />);
    fireEvent.click(screen.getByRole('button', { name: /^agent_c,/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const select = screen.getByRole('combobox', { name: 'Where agent_c opens from GeniusBar' }) as HTMLSelectElement;
    expect(select.value).toBe('inherit');
    expect(select.options[0].text).toBe('Follow app setting (In GeniusBar)');
    fireEvent.change(select, { target: { value: 'window' } });
    expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY)!).windowFor).toEqual({ 'user/agent_c': 'window' });
    fireEvent.change(select, { target: { value: 'inherit' } });
    expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY)!).windowFor).toEqual({});
  });

  it('keeps the audit log\'s panel in the popup, with a pop-out to its window', async () => {
    const { opened, surfaces } = fakeSurfaces();
    render(<App census={sampleCensus} connection={connected} surfaces={surfaces} launcher={launcher} />);
    fireEvent.click(screen.getByRole('button', { name: 'Audit log' }));
    const panel = screen.getByRole('region', { name: 'Audit log' });
    fireEvent.click(screen.getByRole('button', { name: 'Launch companion' }));
    expect(screen.getByRole('dialog', { name: 'Launch a new companion' })).toBeTruthy();
    expect(opened).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Open in its own window' }));
    await waitFor(() => expect(opened).toEqual([{ surface: 'audit' }]));
    await waitFor(() => expect(panel.isConnected).toBe(false));
  });
});

describe('closing on a click outside is a choice (#265)', () => {
  it('tells the shell the popup stays open, and to hide once the ⋯ switch is on', async () => {
    const { surfaces } = fakeSurfaces();
    render(<App census={sampleCensus} connection={connected} surfaces={surfaces} />);
    await waitFor(() => expect(surfaces.autohide).toHaveBeenCalledWith(false));
    const item = menuSwitch('Close GeniusBar when clicking outside it');
    expect(item.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(item);
    expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY)!).closeOnClickOut).toBe(true);
    await waitFor(() => expect(surfaces.autohide).toHaveBeenLastCalledWith(true));
    expect(menuSwitch('Close GeniusBar when clicking outside it').getAttribute('aria-checked')).toBe('true');
  });

  it('sends the stored choice as the popup starts', async () => {
    preferenceActions.setCloseOnClickOut(true);
    const { surfaces } = fakeSurfaces();
    render(<App census={sampleCensus} connection={connected} surfaces={surfaces} />);
    await waitFor(() => expect(surfaces.autohide).toHaveBeenCalledWith(true));
    expect(surfaces.autohide).toHaveBeenCalledTimes(1);
  });

  it('has nothing to say outside the app', () => {
    render(<App census={sampleCensus} connection={connected} onRefresh={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Close GeniusBar when clicking outside it' })).toBeNull();
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Open conversations in their own window' })).toBeNull();
  });
});

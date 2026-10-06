import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SoulMode, SoulPopulation } from '../bridge';
import { sampleCensus } from '../model/fixtures';
import { SoulNotices, SoulSourceContext, type SoulSource } from './SoulNotices';

afterEach(cleanup);

const [luna] = sampleCensus;
const expired: SoulPopulation = {
  agentId: luna.agentId, appSlug: null,
  harnessAuth: { status: 'expired', harness: 'codex', since: '2026-10-05T10:00:00Z' },
};

function source(overrides: Partial<SoulSource> = {}): SoulSource {
  return {
    population: vi.fn(async () => expired),
    coldWake: vi.fn(async () => null),
    setColdWake: vi.fn(),
    signedIn: vi.fn(async () => null),
    signIn: vi.fn(async () => true),
    mode: vi.fn(async () => null),
    setMode: vi.fn(async (_id: string, mode: SoulMode) => mode),
    model: vi.fn(async () => null),
    setModel: vi.fn(),
    ...overrides,
  };
}

const show = (s: SoulSource, refresh = 0) => render(
  <SoulSourceContext.Provider value={s}><SoulNotices soul={luna} refresh={refresh} /></SoulSourceContext.Provider>,
);

describe('SoulNotices (#122)', () => {
  it('shows the expired sign-in banner from the census record', async () => {
    const s = source();
    show(s);
    expect((await screen.findByRole('alert')).textContent).toContain('codex sign-in expired');
    expect((screen.getByRole('alert')).textContent).toContain("luna can't work until you sign in to codex again");
    expect(s.population).toHaveBeenCalledWith(luna.agentId);
  });

  it('says signed out for a missing sign-in', async () => {
    show(source({ population: vi.fn(async () => ({ ...expired, harnessAuth: { ...expired.harnessAuth!, status: 'signed-out' as const } })) }));
    expect((await screen.findByRole('alert')).textContent).toContain('codex is signed out');
  });

  it('shows nothing without a recorded failure, or when agent-bot cannot say', async () => {
    const clear = source({ population: vi.fn(async () => ({ ...expired, harnessAuth: null })) });
    const { unmount } = show(clear);
    await waitFor(() => expect(clear.population).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
    unmount();
    const none = source({ population: vi.fn(async () => null) });
    show(none);
    await waitFor(() => expect(none.population).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('signs in through agent-bot, then reads the census again and hides', async () => {
    let record: SoulPopulation = expired;
    let finish: (loggedIn: boolean) => void = () => {};
    const s = source({
      population: vi.fn(async () => record),
      signIn: vi.fn(() => new Promise<boolean>((done) => { finish = done; })),
    });
    show(s);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in again' }));
    expect(s.signIn).toHaveBeenCalledWith('codex', luna.agentId);
    expect((screen.getByRole('button', { name: 'Opening codex sign-in…' }) as HTMLButtonElement).disabled).toBe(true);
    record = { ...expired, harnessAuth: null };
    finish(true);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(s.population).toHaveBeenCalledTimes(2);
  });

  it('keeps the banner with the reason when sign-in fails', async () => {
    const s = source({ signIn: vi.fn(async () => { throw new Error('codex sign-in did not finish'); }) });
    show(s);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in again' }));
    await screen.findByText('Sign-in did not finish: codex sign-in did not finish');
    expect((screen.getByRole('button', { name: 'Sign in again' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('reads the census again on refresh, so a new failure appears', async () => {
    let record: SoulPopulation = { ...expired, harnessAuth: null };
    const s = source({ population: vi.fn(async () => record) });
    const { rerender } = show(s);
    await waitFor(() => expect(s.population).toHaveBeenCalledOnce());
    record = expired;
    rerender(<SoulSourceContext.Provider value={s}><SoulNotices soul={luna} refresh={1} /></SoulSourceContext.Provider>);
    await screen.findByRole('alert');
  });
});

describe('Auto-Pilot banner (#122)', () => {
  const banner = 'Auto-Pilot is on — luna runs tools without asking.';
  const clear = { population: vi.fn(async () => ({ ...expired, harnessAuth: null })) };

  it('shows for a soul on Auto-Pilot, and Turn off asks agent-bot for Safe Mode', async () => {
    const s = source({ ...clear, mode: vi.fn(async () => 'autopilot' as const) });
    show(s);
    expect((await screen.findByRole('status')).textContent).toContain(banner);
    expect(s.mode).toHaveBeenCalledWith(luna.agentId);
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(s.setMode).toHaveBeenCalledWith(luna.agentId, 'safe');
    await waitFor(() => expect(screen.queryByText(banner)).toBeNull());
  });

  it('keeps the banner with the reason when the owner refuses', async () => {
    const s = source({
      ...clear,
      mode: vi.fn(async () => 'autopilot' as const),
      setMode: vi.fn(async () => { throw new Error('the owner did not approve'); }),
    });
    show(s);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Execution mode unchanged: the owner did not approve');
    expect(screen.getByText(banner)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Turn off' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows nothing in Safe Mode, or when agent-bot cannot say', async () => {
    const safe = source({ ...clear, mode: vi.fn(async () => 'safe' as const) });
    const { unmount } = show(safe);
    await waitFor(() => expect(safe.mode).toHaveBeenCalled());
    expect(screen.queryByText(banner)).toBeNull();
    unmount();
    const none = source(clear);
    show(none);
    await waitFor(() => expect(none.mode).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows with the expired sign-in banner', async () => {
    show(source({ mode: vi.fn(async () => 'autopilot' as const) }));
    expect(await screen.findByText(banner)).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toContain('codex sign-in expired');
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy();
  });

  it('reads the mode again on refresh', async () => {
    let mode: SoulMode = 'safe';
    const s = source({ ...clear, mode: vi.fn(async () => mode) });
    const { rerender } = show(s);
    await waitFor(() => expect(s.mode).toHaveBeenCalledOnce());
    mode = 'autopilot';
    rerender(<SoulSourceContext.Provider value={s}><SoulNotices soul={luna} refresh={1} /></SoulSourceContext.Provider>);
    expect(await screen.findByText(banner)).toBeTruthy();
  });
});

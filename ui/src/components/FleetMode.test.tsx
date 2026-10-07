import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SoulMode } from '../bridge';
import { I18nProvider } from '../lib/i18n';
import { sampleCensus } from '../model/fixtures';
import { FleetMode } from './FleetMode';
import { SoulSourceContext, type SoulSource } from './SoulNotices';

afterEach(() => { cleanup(); globalThis.localStorage?.clear(); });

const [luna, child] = sampleCensus;

function source(modes: Record<string, SoulMode | null>, setMode = vi.fn(async (_id: string, mode: SoulMode) => mode)): SoulSource {
  return {
    population: vi.fn(async () => null), coldWake: vi.fn(async () => null), setColdWake: vi.fn(),
    signedIn: vi.fn(async () => null), signIn: vi.fn(),
    mode: vi.fn(async (id: string) => modes[id] ?? null), setMode,
    model: vi.fn(async () => null), setModel: vi.fn(),
  };
}

const show = (s: SoulSource) => render(
  <I18nProvider><SoulSourceContext.Provider value={s}><FleetMode roster={sampleCensus} /></SoulSourceContext.Provider></I18nProvider>,
);

describe('FleetMode', () => {
  it('summarises every companion’s mode and switches the ones that differ (#122)', async () => {
    const setMode = vi.fn(async (_id: string, mode: SoulMode) => mode);
    show(source({ [luna.agentId]: 'safe', [child.agentId]: 'autopilot' }, setMode));
    const toggle = await screen.findByRole('switch', { name: 'Auto-Pilot for every companion' }) as HTMLInputElement;
    expect(screen.getByText('Mixed')).toBeTruthy();
    expect(toggle.indeterminate).toBe(true);
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText('Auto-Pilot')).toBeTruthy());
    expect(setMode).toHaveBeenCalledTimes(1);
    expect(setMode).toHaveBeenCalledWith(luna.agentId, 'autopilot');
    const on = screen.getByRole('switch', { name: 'Auto-Pilot for every companion' }) as HTMLInputElement;
    expect(on.checked).toBe(true);
    // The design's small switch, amber when on, from classes rather than an inline style.
    expect(on.className).toBe('switch-sm switch-warning');
    expect(on.getAttribute('style')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Auto-Pilot for every companion' }));
    await waitFor(() => expect(screen.getByText('Safe Mode')).toBeTruthy());
    expect(setMode).toHaveBeenCalledTimes(3);
    expect(setMode).toHaveBeenLastCalledWith(child.agentId, 'safe');
  });

  it('is absent while agent-bot cannot say for any companion', async () => {
    const s = source({});
    show(s);
    await waitFor(() => expect(s.mode).toHaveBeenCalledTimes(sampleCensus.length));
    expect(screen.queryByRole('switch', { name: 'Auto-Pilot for every companion' })).toBeNull();
  });

  it('keeps the mode and says why when agent-bot refuses', async () => {
    show(source({ [luna.agentId]: 'safe' }, vi.fn(async () => { throw new Error('the owner declined'); })));
    fireEvent.click(await screen.findByRole('switch', { name: 'Auto-Pilot for every companion' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Execution mode unchanged: the owner declined');
    expect(screen.getByText('Safe Mode')).toBeTruthy();
  });
});

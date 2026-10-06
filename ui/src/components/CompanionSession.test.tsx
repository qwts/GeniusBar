import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeError, runtimeMetrics, setSoulComms, soulComms, type ComputerUseSwitch, type RuntimeMetrics, type SoulMode, type SoulModel, type SoulPopulation } from '../bridge';
import { buildSoulForest } from '../model/census';
import { emptyComposer } from '../model/chat';
import type { LaunchRequest } from '../model/launch';
import { sampleCensus, sampleProfile } from '../model/fixtures';
import { ProfileSourceContext, type ProfileSource } from '../useSoulProfile';
import { CompanionDetails, CompanionSession, ComputerUseContext } from './CompanionSession';
import { SoulSourceContext, type SoulSource } from './SoulNotices';

afterEach(cleanup);
vi.mock('../bridge', async (original) => {
  const real = await original<typeof import('../bridge')>();
  return { BridgeError: real.BridgeError, computerUseSupported: real.computerUseSupported,
    runtimeMetrics: vi.fn(), soulComms: vi.fn(), setSoulComms: vi.fn() };
});
beforeEach(() => {
  vi.mocked(runtimeMetrics).mockReset().mockResolvedValue({ unavailable: true });
  vi.mocked(soulComms).mockReset().mockResolvedValue(null);
  vi.mocked(setSoulComms).mockReset();
});

const [luna, child] = sampleCensus;
const forest = buildSoulForest(sampleCensus);
const observedAt = new Date(Date.now() - 120_000).toISOString();
const metrics: RuntimeMetrics = {
  collectedAt: observedAt,
  souls: {
    [child.agentId]: {
      lastCallAt: observedAt,
      observations: [
        { metric: 'model_reported', value: 'claude-sonnet-4-6', unit: 'model', scope: 'main', source: 'claude', kind: 'reported', observedAt },
        { metric: 'context_used_tokens', value: 12345, unit: 'tokens', scope: 'main', source: 'claude', kind: 'reported', method: 'last-call-usage', observedAt },
      ],
    },
  },
  errors: [],
  missing: [],
};

function field(term: string): string | null {
  const dt = screen.getByText(term, { selector: 'dt' });
  return dt.nextElementSibling?.textContent ?? null;
}

describe('CompanionDetails', () => {
  describe('managed and agent comms (#71)', () => {
    const stopped = { agentId: child.agentId, managed: true, comms: true, running: false };

    it('adds Managed and Agent comms rows, keeping every other row', async () => {
      vi.mocked(soulComms).mockResolvedValue(stopped);
      render(<CompanionDetails soul={child} />);
      await screen.findByText('Managed', { selector: 'dt' });
      expect(field('Managed')).toBe('Managed');
      expect(field('Agent comms')).toBe('On');
      expect(field('Agent id')).toBe(child.agentId);
      for (const term of ['Account', 'Harness', 'Presence', 'Parent', 'Unacked', 'Last wake']) {
        expect(screen.getByText(term, { selector: 'dt' })).toBeTruthy();
      }
      expect(soulComms).toHaveBeenCalledWith(child.agentId);
    });

    it('shows Unmanaged and Off', async () => {
      vi.mocked(soulComms).mockResolvedValue({ ...stopped, managed: false, comms: false });
      render(<CompanionDetails soul={child} />);
      await screen.findByText('Unmanaged');
      expect(field('Agent comms')).toBe('Off');
    });

    it('locks the toggle while the companion runs', async () => {
      vi.mocked(soulComms).mockResolvedValue({ ...stopped, running: true });
      render(<CompanionDetails soul={child} />);
      const toggle = await screen.findByRole('switch', { name: /Agent comms for/ });
      expect((toggle as HTMLInputElement).disabled).toBe(true);
      expect(screen.getByText('Stop the companion to change')).toBeTruthy();
    });

    it('turns comms off through agent-bot when stopped, and shows a refusal', async () => {
      vi.mocked(soulComms).mockResolvedValue(stopped);
      vi.mocked(setSoulComms).mockResolvedValueOnce({ ...stopped, comms: false });
      render(<CompanionDetails soul={child} />);
      fireEvent.click(await screen.findByRole('switch', { name: /Agent comms for/ }));
      expect(setSoulComms).toHaveBeenCalledWith(child.agentId, false);
      await waitFor(() => expect(field('Agent comms')).toBe('Off'));
      vi.mocked(setSoulComms).mockRejectedValueOnce(new BridgeError('soul-comms-failed', 'the owner did not approve'));
      fireEvent.click(screen.getByRole('switch', { name: /Agent comms for/ }));
      await screen.findByText('Agent comms unchanged: the owner did not approve');
      expect(field('Agent comms')).toMatch(/^Off/);
    });

    it('a change for one soul never lands on another soul shown since', async () => {
      vi.mocked(soulComms).mockImplementation(async (agentId: string) => ({ ...stopped, agentId, comms: agentId === child.agentId }));
      let finish: (value: typeof stopped) => void = () => {};
      vi.mocked(setSoulComms).mockImplementationOnce(() => new Promise((done) => { finish = done; }));
      const { rerender } = render(<CompanionDetails soul={child} />);
      fireEvent.click(await screen.findByRole('switch', { name: /Agent comms for/ }));
      rerender(<CompanionDetails soul={luna} />);
      await waitFor(() => expect(field('Agent comms')).toBe('Off'));
      finish({ ...stopped, comms: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(field('Agent comms')).toBe('Off');
      expect(screen.queryByText('Waiting for your approval…')).toBeNull();
    });

    it('a refresh during a change does not replace its result', async () => {
      vi.mocked(soulComms).mockResolvedValue(stopped);
      let finish: (value: typeof stopped) => void = () => {};
      vi.mocked(setSoulComms).mockImplementationOnce(() => new Promise((done) => { finish = done; }));
      const { rerender } = render(<CompanionDetails soul={child} metricsRefresh={0} />);
      fireEvent.click(await screen.findByRole('switch', { name: /Agent comms for/ }));
      rerender(<CompanionDetails soul={child} metricsRefresh={1} />);
      expect(soulComms).toHaveBeenCalledOnce();
      finish({ ...stopped, comms: false });
      await waitFor(() => expect(field('Agent comms')).toBe('Off'));
    });

    it('relaunching keeps the soul setting: no switch until it is known, then it follows it', async () => {
      const { LaunchForm } = await import('./LaunchForm');
      const launcher = { state: { phase: 'idle' as const }, launch: vi.fn(async () => {}), reset: vi.fn() };
      const { rerender } = render(<LaunchForm launcher={launcher} accounts={['user']} harnesses={[]} soul={child} />);
      expect(screen.queryByRole('switch')).toBeNull();
      rerender(<LaunchForm launcher={launcher} accounts={['user']} harnesses={[]} soul={child} initialComms={false} />);
      expect((screen.getByRole('switch', { name: 'Agent comms' }) as HTMLInputElement).checked).toBe(false);
      fireEvent.submit(screen.getByRole('form'));
      expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ comms: false }));
    });

    it('puts the comms row in the ⓘ Details sheet, with the same toggle', async () => {
      const { InfoButton } = await import('./CompanionSession');
      vi.mocked(soulComms).mockResolvedValue(stopped);
      vi.mocked(setSoulComms).mockResolvedValueOnce({ ...stopped, comms: false });
      render(<InfoButton soul={child} />);
      fireEvent.click(screen.getByRole('button', { name: 'Details' }));
      const sheet = screen.getByRole('dialog', { name: 'Details · agent_c' });
      expect(await within(sheet).findByText('Lets this soul message and be messaged by other souls.')).toBeTruthy();
      expect(within(sheet).getByText('Managed')).toBeTruthy();
      fireEvent.click(within(sheet).getByRole('switch', { name: /Agent comms for/ }));
      expect(setSoulComms).toHaveBeenCalledWith(child.agentId, false);
      fireEvent.keyDown(sheet, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('adds no rows when agent-bot cannot say', async () => {
      render(<CompanionDetails soul={child} />);
      await waitFor(() => expect(soulComms).toHaveBeenCalledOnce());
      expect(screen.queryByText('Managed', { selector: 'dt' })).toBeNull();
      expect(screen.queryByRole('switch')).toBeNull();
    });
  });

  it('shows model and context with their observation ages, without changing presence', async () => {
    vi.mocked(runtimeMetrics).mockResolvedValue(metrics);
    render(<CompanionDetails soul={child} />);
    await screen.findByText('claude-sonnet-4-6');
    expect(field('Model')).toBe('claude-sonnet-4-6from claude, 2 minutes ago');
    expect(field('Context')).toBe('12,345 tokensfrom claude, 2 minutes ago');
    expect(field('Presence')).toBe('watching');
    expect(runtimeMetrics).toHaveBeenCalledOnce();
  });

  it.each<RuntimeMetrics>([{ unavailable: true }, { collectedAt: observedAt, souls: {}, errors: [], missing: [{ agentId: child.agentId, source: 'claude' }] }])(
    'omits metrics when unavailable or the soul has no entry (%j)', async (result) => {
      vi.mocked(runtimeMetrics).mockResolvedValue(result);
      render(<CompanionDetails soul={child} />);
      await waitFor(() => expect(runtimeMetrics).toHaveBeenCalledOnce());
      expect(screen.queryByText('Model')).toBeNull();
      expect(screen.queryByText('Context')).toBeNull();
      expect(screen.queryByText(/from claude/)).toBeNull();
      expect(screen.queryByText(/Metrics collector/)).toBeNull();
    },
  );

  it('shows a muted collector error only for this soul, even without observations', async () => {
    vi.mocked(runtimeMetrics).mockResolvedValue({
      collectedAt: observedAt, souls: {}, missing: [],
      errors: [
        { agentId: child.agentId, source: 'claude', code: 'read-failed', message: 'Could not read session' },
        { agentId: luna.agentId, source: 'claude', code: 'read-failed', message: 'Another soul error' },
      ],
    });
    render(<CompanionDetails soul={child} />);
    const error = await screen.findByText('Metrics collector (claude): Could not read session');
    expect(error.className).toContain('text-muted-foreground');
    expect(screen.queryByText(/Another soul error/)).toBeNull();
    expect(field('Presence')).toBe('watching');
  });

  it('refreshes on request and soul changes, ignoring a late reply for the previous soul', async () => {
    let resolve!: (value: RuntimeMetrics) => void;
    vi.mocked(runtimeMetrics).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const { rerender } = render(<CompanionDetails soul={child} />);
    rerender(<CompanionDetails soul={luna} />);
    resolve(metrics);
    await waitFor(() => expect(runtimeMetrics).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Model')).toBeNull();
    rerender(<CompanionDetails soul={luna} metricsRefresh={1} />);
    await waitFor(() => expect(runtimeMetrics).toHaveBeenCalledTimes(3));
    rerender(<CompanionDetails soul={{ ...luna }} metricsRefresh={1} />);
    expect(runtimeMetrics).toHaveBeenCalledTimes(3);
  });

  it('lists the read-only fields with roster fallbacks', () => {
    render(<CompanionDetails soul={child} roster={sampleCensus} />);
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
    render(<CompanionDetails soul={child} />);
    expect(field('Parent')).toBe('agent_p');
    cleanup();
    render(<CompanionDetails soul={luna} />);
    expect(field('Parent')).toBe('none');
    expect(field('Verification')).toBe('verified');
    expect(field('Hardened')).toBe('yes');
    expect(field('Daemon watching')).toBe('yes');
  });
});

describe('CompanionSession', () => {
  const chat = { entries: [], composer: emptyComposer, onDraft: () => {}, onSend: () => {} };

  it('opens on the chat, and moves between tabs with the arrow keys', () => {
    render(<CompanionSession soul={child} forest={forest} roster={sampleCensus} paused chat={chat} onOpen={() => {}} onClose={() => {}} />);
    const session = screen.getByRole('region', { name: 'agent_c, agent_c' });
    expect(within(session).getByRole('img', { name: 'Avatar for agent_c' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('textbox', { name: 'Message to agent_c' })).toBeTruthy();
    expect(runtimeMetrics).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Chat' }), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Delegation' }));
    expect(screen.getByRole('tabpanel').textContent).toContain('luna');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Delegation' }), { key: 'ArrowRight' });
    expect(field('Account')).toBe('user');
    expect(runtimeMetrics).toHaveBeenCalledOnce();
  });

  it('opens on the details without chat', () => {
    render(<CompanionSession soul={luna} forest={forest} roster={sampleCensus} paused onOpen={() => {}} onClose={() => {}} />);
    expect(screen.queryByRole('tab', { name: 'Chat' })).toBeNull();
    expect(field('Harness')).toBe('codex');
  });

  it('opens another companion from the delegation tree, the current one marked', () => {
    const onOpen = vi.fn();
    render(<CompanionSession soul={child} forest={forest} roster={sampleCensus} paused onOpen={onOpen} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Delegation' }));
    const tree = screen.getByRole('list', { name: 'Delegation' });
    expect(within(tree).getByRole('button', { current: true }).textContent).toContain('agent_c');
    fireEvent.click(within(tree).getByRole('button', { name: /luna/ }));
    expect(onOpen).toHaveBeenCalledWith(luna);
  });

  it('focuses Back in the popup, which closes it, as does Escape', () => {
    const onClose = vi.fn();
    render(<CompanionSession soul={luna} forest={forest} roster={sampleCensus} paused onOpen={() => {}} onClose={onClose} showBack />);
    const back = screen.getByRole('button', { name: 'Back to fleet' });
    expect(document.activeElement).toBe(back);
    fireEvent.click(back);
    fireEvent.keyDown(back, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('Details rows from the Lovable design (#122)', () => {
  const stopped = { agentId: luna.agentId, managed: true, comms: true, running: false };
  const record: SoulPopulation = { agentId: luna.agentId, appSlug: 'luna-bot', harnessAuth: null };
  function source(overrides: Partial<SoulSource> = {}): SoulSource {
    return {
      population: vi.fn(async () => record),
      coldWake: vi.fn(async () => ({ on: true, lane: 'acp' })),
      setColdWake: vi.fn(async (_id: string, on: boolean) => ({ on, lane: on ? 'acp' : null })),
      signedIn: vi.fn(async () => true),
      signIn: vi.fn(async () => true),
      mode: vi.fn(async () => null),
      setMode: vi.fn(async (_id: string, mode: SoulMode) => mode),
      model: vi.fn(async () => null),
      setModel: vi.fn(),
      ...overrides,
    };
  }
  const withSource = (s: SoulSource, ui: React.ReactElement) => <SoulSourceContext.Provider value={s}>{ui}</SoulSourceContext.Provider>;

  it('adds Wake, Harness sign-in and GitHub App rows, keeping every other row', async () => {
    const s = source();
    render(withSource(s, <CompanionDetails soul={luna} />));
    await screen.findByText('GitHub App', { selector: 'dt' });
    expect(await screen.findByText('Signed in')).toBeTruthy();
    expect(field('Wake on new messages')).toBe('On');
    expect(field('Harness sign-in')).toBe('Signed in');
    expect(field('GitHub App')).toBe('Connected · luna-bot');
    for (const term of ['Agent id', 'Account', 'Harness', 'Presence', 'Parent', 'Unacked', 'Last wake', 'Verification', 'Hardened', 'Daemon watching']) {
      expect(screen.getByText(term, { selector: 'dt' })).toBeTruthy();
    }
    expect(s.coldWake).toHaveBeenCalledWith(luna.agentId);
    expect(s.signedIn).toHaveBeenCalledWith('codex', luna.agentId);
  });

  it('shows the census sign-in failure without asking the harness, and an App-less soul', async () => {
    const s = source({ population: vi.fn(async () => ({ ...record, appSlug: null, harnessAuth: { status: 'expired' as const, harness: 'codex', since: null } })) });
    render(withSource(s, <CompanionDetails soul={luna} />));
    expect(await screen.findByText('Expired')).toBeTruthy();
    expect(field('GitHub App')).toBe('Not connected · joins without an App');
    expect(s.signedIn).not.toHaveBeenCalled();
  });

  it('reads harness sign-in once per soul, not on every refresh', async () => {
    const s = source();
    const { rerender } = render(withSource(s, <CompanionDetails soul={luna} metricsRefresh={0} />));
    await screen.findByText('Signed in');
    rerender(withSource(s, <CompanionDetails soul={luna} metricsRefresh={1} />));
    await waitFor(() => expect(s.population).toHaveBeenCalledTimes(2));
    expect(s.signedIn).toHaveBeenCalledOnce();
  });

  it('turns wake off through agent-bot; a refusal leaves the switch and says why', async () => {
    const s = source();
    vi.mocked(soulComms).mockResolvedValue(stopped);
    render(withSource(s, <CompanionDetails soul={luna} />));
    const toggle = await screen.findByRole('switch', { name: 'Wake luna on new messages' }) as HTMLInputElement;
    fireEvent.click(toggle);
    expect(s.setColdWake).toHaveBeenCalledWith(luna.agentId, false);
    await waitFor(() => expect(field('Wake on new messages')).toContain('Off'));
    vi.mocked(s.setColdWake).mockRejectedValueOnce(new BridgeError('cold-wake-failed', 'the owner did not approve'));
    fireEvent.click(toggle);
    expect((await screen.findByRole('alert')).textContent).toBe('Wake setting unchanged: the owner did not approve');
    expect(toggle.checked).toBe(false);
  });

  it('locks the wake switch while the companion runs', async () => {
    vi.mocked(soulComms).mockResolvedValue({ ...stopped, running: true });
    render(withSource(source(), <CompanionDetails soul={luna} />));
    await screen.findByRole('switch', { name: 'Agent comms for luna' });
    const toggle = screen.getByRole('switch', { name: 'Wake luna on new messages' }) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
  });

  it('adds none of them when agent-bot cannot say', async () => {
    const s = source({ population: vi.fn(async () => null), coldWake: vi.fn(async () => null), signedIn: vi.fn(async () => null) });
    render(withSource(s, <CompanionDetails soul={luna} />));
    await waitFor(() => expect(s.signedIn).toHaveBeenCalled());
    for (const term of ['Wake on new messages', 'Harness sign-in', 'GitHub App']) {
      expect(screen.queryByText(term, { selector: 'dt' })).toBeNull();
    }
  });

  it('puts the wake switch, sign-in and GitHub App in the ⓘ Details sheet', async () => {
    const { InfoButton } = await import('./CompanionSession');
    const s = source();
    render(withSource(s, <InfoButton soul={luna} />));
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const sheet = screen.getByRole('dialog', { name: 'Details · luna' });
    expect(await within(sheet).findByText("Start luna when a message arrives, even if it's asleep.")).toBeTruthy();
    expect(await within(sheet).findByText('Signed in')).toBeTruthy();
    expect(within(sheet).getByText('Connected · luna-bot')).toBeTruthy();
    expect(within(sheet).queryByRole('button', { name: /Connect|Rotate/ })).toBeNull();
    fireEvent.click(within(sheet).getByRole('switch', { name: 'Wake luna on new messages' }));
    expect(s.setColdWake).toHaveBeenCalledWith(luna.agentId, false);
  });

  it('shows the expired sign-in banner above the chat only', async () => {
    const s = source({ population: vi.fn(async () => ({ ...record, harnessAuth: { status: 'expired' as const, harness: 'codex', since: null } })) });
    const chat = { entries: [], composer: emptyComposer, onDraft: () => {}, onSend: () => {} };
    render(withSource(s, <CompanionSession soul={luna} forest={forest} roster={sampleCensus} chat={chat} onOpen={() => {}} onClose={() => {}} />));
    expect((await screen.findByRole('alert')).textContent).toContain('codex sign-in expired');
    expect(screen.getByRole('textbox', { name: 'Message to luna' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(s.signIn).toHaveBeenCalledWith('codex', luna.agentId);
  });

  it('adds the Execution mode row: Safe Mode with its hint, switched to Auto-Pilot through agent-bot', async () => {
    const s = source({ mode: vi.fn(async () => 'safe' as const) });
    render(withSource(s, <CompanionDetails soul={luna} />));
    const toggle = await screen.findByRole('switch', { name: 'Auto-Pilot for luna' }) as HTMLInputElement;
    expect(field('Execution mode')).toBe('Safe ModeRisky and external actions wait for your approval.');
    expect(toggle.checked).toBe(false);
    expect(s.mode).toHaveBeenCalledWith(luna.agentId);
    fireEvent.click(toggle);
    expect(s.setMode).toHaveBeenCalledWith(luna.agentId, 'autopilot');
    await waitFor(() => expect(field('Execution mode')).toBe('Auto-Pilot'));
    expect(toggle.checked).toBe(true);
  });

  it('is not locked while the companion runs', async () => {
    vi.mocked(soulComms).mockResolvedValue({ ...stopped, running: true });
    render(withSource(source({ mode: vi.fn(async () => 'autopilot' as const) }), <CompanionDetails soul={luna} />));
    await screen.findByRole('switch', { name: 'Agent comms for luna' });
    const toggle = screen.getByRole('switch', { name: 'Auto-Pilot for luna' }) as HTMLInputElement;
    expect(toggle.disabled).toBe(false);
  });

  it('a refused mode change leaves the switch where it was and says why', async () => {
    const s = source({
      mode: vi.fn(async () => 'safe' as const),
      setMode: vi.fn(async () => { throw new BridgeError('soul-mode-failed', 'the owner did not approve'); }),
    });
    render(withSource(s, <CompanionDetails soul={luna} />));
    const toggle = await screen.findByRole('switch', { name: 'Auto-Pilot for luna' }) as HTMLInputElement;
    fireEvent.click(toggle);
    expect((await screen.findByRole('alert')).textContent).toBe('Execution mode unchanged: the owner did not approve');
    expect(toggle.checked).toBe(false);
    expect(field('Execution mode')).toContain('Safe Mode');
  });

  it('has no Execution mode row when agent-bot cannot say', async () => {
    const s = source();
    render(withSource(s, <CompanionDetails soul={luna} />));
    await screen.findByText('Wake on new messages', { selector: 'dt' });
    await waitFor(() => expect(s.mode).toHaveBeenCalled());
    expect(screen.queryByText('Execution mode', { selector: 'dt' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Auto-Pilot for luna' })).toBeNull();
  });

  it('puts the Execution mode switch in the ⓘ Details sheet, and the banner follows it', async () => {
    const { InfoButton } = await import('./CompanionSession');
    const { AutopilotBanner } = await import('./SoulNotices');
    const s = source({ mode: vi.fn(async () => 'safe' as const) });
    render(withSource(s, <><AutopilotBanner soul={luna} /><InfoButton soul={luna} /></>));
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const sheet = screen.getByRole('dialog', { name: 'Details · luna' });
    expect(await within(sheet).findByText('Execution mode')).toBeTruthy();
    expect(within(sheet).getByText('Risky and external actions wait for your approval.')).toBeTruthy();
    expect(screen.queryByText('Auto-Pilot is on — luna runs tools without asking.')).toBeNull();
    fireEvent.click(within(sheet).getByRole('switch', { name: 'Auto-Pilot for luna' }));
    expect(s.setMode).toHaveBeenCalledWith(luna.agentId, 'autopilot');
    expect(await screen.findByText('Auto-Pilot is on — luna runs tools without asking.')).toBeTruthy();
  });

  it('shows the Auto-Pilot banner above the chat', async () => {
    const s = source({ mode: vi.fn(async () => 'autopilot' as const) });
    const chat = { entries: [], composer: emptyComposer, onDraft: () => {}, onSend: () => {} };
    render(withSource(s, <CompanionSession soul={luna} forest={forest} roster={sampleCensus} chat={chat} onOpen={() => {}} onClose={() => {}} />));
    expect(await screen.findByText('Auto-Pilot is on — luna runs tools without asking.')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Message to luna' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(s.setMode).toHaveBeenCalledWith(luna.agentId, 'safe');
    await waitFor(() => expect(screen.queryByText('Auto-Pilot is on — luna runs tools without asking.')).toBeNull());
  });
});

describe('the model picker (#128)', () => {
  const listed: SoulModel = {
    model: 'opus', listedAt: '2026-10-05T00:00:00.000Z',
    available: [
      { modelId: 'opus', name: 'Opus', description: 'Most capable' },
      { modelId: 'sonnet', name: 'Sonnet', description: null },
    ],
  };
  function source(overrides: Partial<SoulSource> = {}): SoulSource {
    return {
      population: vi.fn(async () => null),
      coldWake: vi.fn(async () => null),
      setColdWake: vi.fn(),
      signedIn: vi.fn(async () => null),
      signIn: vi.fn(async () => true),
      mode: vi.fn(async () => null),
      setMode: vi.fn(),
      model: vi.fn(async () => listed),
      setModel: vi.fn(async (_id: string, model: string | null) => ({ ...listed, model })),
      ...overrides,
    };
  }
  const withSource = (s: SoulSource, ui: React.ReactElement) => <SoulSourceContext.Provider value={s}>{ui}</SoulSourceContext.Provider>;
  const options = (select: HTMLElement) => [...select.querySelectorAll('option')].map((o) => o.textContent);

  it('adds a Model choice row: the default, the harness list and Other…, with the hint', async () => {
    const s = source();
    render(withSource(s, <CompanionDetails soul={luna} />));
    const select = await screen.findByRole('combobox', { name: 'Model for luna' }) as HTMLSelectElement;
    expect(options(select)).toEqual(['Harness default', 'Opus', 'Sonnet', 'Other…']);
    expect(select.value).toBe('opus');
    expect((select.querySelector('option[value="opus"]') as HTMLOptionElement).title).toBe('Most capable');
    expect(field('Model choice')).toContain("Applies on luna's next turn.");
    expect(s.model).toHaveBeenCalledWith(luna.agentId);
  });

  it('keeps a chosen model the list lacks, and says when the harness has listed nothing', async () => {
    render(withSource(source({ model: vi.fn(async () => ({ model: 'my-model', available: null, listedAt: null })) }), <CompanionDetails soul={luna} />));
    const select = await screen.findByRole('combobox', { name: 'Model for luna' }) as HTMLSelectElement;
    expect(options(select)).toEqual(['Harness default', 'my-model', 'Other…']);
    expect(select.value).toBe('my-model');
    expect(field('Model choice')).toContain('The harness lists its models after the first turn.');
  });

  it('has no Model choice row when agent-bot cannot say', async () => {
    const s = source({ model: vi.fn(async () => null) });
    render(withSource(s, <CompanionDetails soul={luna} />));
    await waitFor(() => expect(s.model).toHaveBeenCalled());
    expect(screen.queryByText('Model choice', { selector: 'dt' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Model for luna' })).toBeNull();
  });

  it('sets a listed model, or the default, through agent-bot', async () => {
    const s = source();
    render(withSource(s, <CompanionDetails soul={luna} />));
    const select = await screen.findByRole('combobox', { name: 'Model for luna' }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'sonnet' } });
    expect(s.setModel).toHaveBeenCalledWith(luna.agentId, 'sonnet');
    await waitFor(() => expect(select.value).toBe('sonnet'));
    fireEvent.change(select, { target: { value: '__default' } });
    expect(s.setModel).toHaveBeenLastCalledWith(luna.agentId, null);
    await waitFor(() => expect(select.value).toBe('__default'));
  });

  it('a refused change leaves the model where it was and says why', async () => {
    const s = source({ setModel: vi.fn(async () => { throw new BridgeError('soul-model-failed', 'the owner did not approve'); }) });
    render(withSource(s, <CompanionDetails soul={luna} />));
    const select = await screen.findByRole('combobox', { name: 'Model for luna' }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'sonnet' } });
    expect((await screen.findByRole('alert')).textContent).toBe('Model unchanged: the owner did not approve');
    expect(select.value).toBe('opus');
  });

  it('takes any model id through Other…, on Enter or Use', async () => {
    const s = source();
    render(withSource(s, <CompanionDetails soul={luna} />));
    const select = await screen.findByRole('combobox', { name: 'Model for luna' }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '__other' } });
    expect(s.setModel).not.toHaveBeenCalled();
    const input = screen.getByRole('textbox', { name: 'Model ID' }) as HTMLInputElement;
    expect(input.maxLength).toBe(120);
    fireEvent.change(input, { target: { value: ' my-model ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use' }));
    expect(s.setModel).toHaveBeenCalledWith(luna.agentId, 'my-model');
    await waitFor(() => expect(select.value).toBe('my-model'));
    expect(screen.queryByRole('textbox', { name: 'Model ID' })).toBeNull();
    fireEvent.change(select, { target: { value: '__other' } });
    const again = screen.getByRole('textbox', { name: 'Model ID' });
    fireEvent.change(again, { target: { value: 'other-model' } });
    fireEvent.keyDown(again, { key: 'Enter' });
    expect(s.setModel).toHaveBeenLastCalledWith(luna.agentId, 'other-model');
  });

  it('puts the Model row in the ⓘ Details sheet, and the Details row follows it', async () => {
    const { InfoButton } = await import('./CompanionSession');
    const s = source();
    render(withSource(s, <><CompanionDetails soul={luna} /><InfoButton soul={luna} /></>));
    await screen.findByRole('combobox', { name: 'Model for luna' });
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const sheet = screen.getByRole('dialog', { name: 'Details · luna' });
    expect(await within(sheet).findByText('Model')).toBeTruthy();
    const select = within(sheet).getByRole('combobox', { name: 'Model for luna' });
    expect(within(sheet).getByText("Applies on luna's next turn.")).toBeTruthy();
    fireEvent.change(select, { target: { value: 'sonnet' } });
    expect(s.setModel).toHaveBeenCalledWith(luna.agentId, 'sonnet');
    await waitFor(() => expect(field('Model choice')).toBeTruthy());
    const details = screen.getAllByRole('combobox', { name: 'Model for luna' }).find((el) => !sheet.contains(el)) as HTMLSelectElement;
    await waitFor(() => expect(details.value).toBe('sonnet'));
  });

  describe('in the launch form', () => {
    const launcher = () => ({ state: { phase: 'idle' as const }, launch: vi.fn(async (_request: LaunchRequest) => {}), reset: vi.fn() });
    const scout = { ...luna, agentId: 'agent_s', name: 'scout' };
    const roster = [luna, scout, { ...child, harness: 'claude' }];

    it('offers the default, the lists of census souls on this harness once each, and Other…', async () => {
      const { LaunchForm } = await import('./LaunchForm');
      const s = source({
        model: vi.fn(async (agentId: string) => (agentId === 'agent_s'
          ? { ...listed, available: [{ modelId: 'sonnet', name: 'Sonnet', description: null }, { modelId: 'haiku', name: 'Haiku', description: null }] }
          : listed)),
      });
      render(withSource(s, <LaunchForm launcher={launcher()} accounts={['user']} harnesses={[]} soul={luna} roster={roster} />));
      const select = screen.getByRole('combobox', { name: 'Model' });
      expect(options(select)).toEqual(['Harness default', 'Other…']);
      await waitFor(() => expect(options(select)).toEqual(['Harness default', 'Opus', 'Sonnet', 'Haiku', 'Other…']));
      expect(vi.mocked(s.model).mock.calls.map(([id]) => id).sort()).toEqual(['agent_p', 'agent_s']);
    });

    it('sends no model for the harness default, and the chosen one otherwise', async () => {
      const { LaunchForm } = await import('./LaunchForm');
      const l = launcher();
      render(withSource(source(), <LaunchForm launcher={l} accounts={['user']} harnesses={[]} soul={luna} roster={roster} />));
      fireEvent.submit(screen.getByRole('form'));
      expect(l.launch.mock.calls[0][0]).not.toHaveProperty('model');
      const select = screen.getByRole('combobox', { name: 'Model' });
      await waitFor(() => expect(options(select)).toContain('Sonnet'));
      fireEvent.change(select, { target: { value: 'sonnet' } });
      fireEvent.submit(screen.getByRole('form'));
      expect(l.launch).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'sonnet' }));
    });

    it('takes any model through Other…, and starts over on another harness', async () => {
      const { LaunchForm } = await import('./LaunchForm');
      const l = launcher();
      render(withSource(source(), <LaunchForm launcher={l} accounts={['user']} harnesses={[]} soul={luna} roster={roster} />));
      fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: '__other' } });
      fireEvent.change(screen.getByRole('textbox', { name: 'Model ID' }), { target: { value: ' my-model ' } });
      fireEvent.submit(screen.getByRole('form'));
      expect(l.launch).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'my-model' }));
      fireEvent.change(screen.getByRole('combobox', { name: 'Harness' }), { target: { value: 'claude' } });
      expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe('__default');
      fireEvent.submit(screen.getByRole('form'));
      expect(l.launch.mock.calls.at(-1)?.[0]).not.toHaveProperty('model');
    });

    it('offers only the default and Other… without a roster or a listed harness', async () => {
      const { LaunchForm } = await import('./LaunchForm');
      const s = source({ model: vi.fn(async () => null) });
      render(withSource(s, <LaunchForm launcher={launcher()} accounts={['user']} harnesses={[]} />));
      expect(options(screen.getByRole('combobox', { name: 'Model' }))).toEqual(['Harness default', 'Other…']);
      expect(s.model).not.toHaveBeenCalled();
    });
  });
});

describe('Computer use row (#122, agent-bot soul computer-use)', () => {
  function source(computerUse: boolean | undefined): SoulSource & { record: SoulPopulation } {
    const holder = { record: { agentId: luna.agentId, appSlug: null, harnessAuth: null, ...(computerUse === undefined ? {} : { computerUse }) } as SoulPopulation };
    return {
      get record() { return holder.record; },
      set record(r: SoulPopulation) { holder.record = r; },
      population: vi.fn(async () => holder.record),
      coldWake: vi.fn(async () => null),
      setColdWake: vi.fn(),
      signedIn: vi.fn(async () => null),
      signIn: vi.fn(),
      mode: vi.fn(async () => 'safe' as const),
      setMode: vi.fn(async (_id: string, mode: SoulMode) => mode),
      model: vi.fn(async () => null),
      setModel: vi.fn(),
    };
  }
  function switchFor(s: { record: SoulPopulation }, overrides: Partial<ComputerUseSwitch> = {}): ComputerUseSwitch {
    return {
      supported: vi.fn(async () => true),
      read: vi.fn(async () => s.record.computerUse ?? null),
      set: vi.fn(async (agentId: string, on: boolean) => {
        s.record = { ...s.record, computerUse: on };
        return on ? { agentId, computerUse: on } : { agentId, computerUse: on, stopped: true };
      }),
      ...overrides,
    };
  }
  const withBoth = (s: SoulSource, sw: ComputerUseSwitch, ui: React.ReactElement) => (
    <SoulSourceContext.Provider value={s}><ComputerUseContext.Provider value={sw}>{ui}</ComputerUseContext.Provider></SoulSourceContext.Provider>
  );

  it('sits beside Execution mode, read from the census record, and switches off and on through agent-bot', async () => {
    const s = source(true);
    const sw = switchFor(s);
    render(withBoth(s, sw, <CompanionDetails soul={luna} />));
    const toggle = await screen.findByRole('switch', { name: 'Computer use for luna' }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(field('Computer use')).toBe('On');
    const terms = [...document.querySelectorAll('dt')].map((dt) => dt.textContent);
    expect(terms.indexOf('Computer use')).toBe(terms.indexOf('Execution mode') + 1);
    fireEvent.click(toggle);
    expect(sw.set).toHaveBeenCalledWith(luna.agentId, false);
    await waitFor(() => expect(toggle.checked).toBe(false));
    expect(field('Computer use')).toBe('OffOff: its requests to control the screen are denied.Its screen session was stopped.');
    await waitFor(() => expect(vi.mocked(s.population).mock.calls.length).toBeGreaterThan(1));
    fireEvent.click(toggle);
    expect(sw.set).toHaveBeenLastCalledWith(luna.agentId, true);
    await waitFor(() => expect(toggle.checked).toBe(true));
    expect(field('Computer use')).toBe('On');
  });

  it('a refused change leaves the switch where it was and says why', async () => {
    const s = source(true);
    const sw = switchFor(s, { set: vi.fn(async () => { throw new BridgeError('soul-computer-use-failed', 'the owner did not approve'); }) });
    render(withBoth(s, sw, <CompanionDetails soul={luna} />));
    const toggle = await screen.findByRole('switch', { name: 'Computer use for luna' }) as HTMLInputElement;
    fireEvent.click(toggle);
    expect((await screen.findByRole('alert')).textContent).toBe('Computer use unchanged: the owner did not approve');
    expect(toggle.checked).toBe(true);
  });

  it('is hidden when the bundled agent-bot has no soul computer-use', async () => {
    const s = source(true);
    const sw = switchFor(s, { supported: vi.fn(async () => false) });
    render(withBoth(s, sw, <CompanionDetails soul={luna} />));
    await screen.findByText('Execution mode', { selector: 'dt' });
    await waitFor(() => expect(sw.supported).toHaveBeenCalled());
    expect(screen.queryByText('Computer use', { selector: 'dt' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Computer use for luna' })).toBeNull();
  });

  it('is hidden when the census record does not say, and without a switch', async () => {
    const s = source(undefined);
    render(withBoth(s, switchFor(s), <CompanionDetails soul={luna} />));
    await screen.findByText('Execution mode', { selector: 'dt' });
    await waitFor(() => expect(s.population).toHaveBeenCalled());
    expect(screen.queryByText('Computer use', { selector: 'dt' })).toBeNull();
    cleanup();
    const t = source(true);
    render(<SoulSourceContext.Provider value={t}><CompanionDetails soul={luna} /></SoulSourceContext.Provider>);
    await screen.findByText('Execution mode', { selector: 'dt' });
    expect(screen.queryByText('Computer use', { selector: 'dt' })).toBeNull();
  });

  it('a bundle that turns out to lack the command hides the row instead of failing', async () => {
    const s = source(true);
    const sw = switchFor(s, { set: vi.fn(async () => { throw new BridgeError('soul-computer-use-unsupported', 'this agent-bot has no soul computer-use'); }) });
    render(withBoth(s, sw, <CompanionDetails soul={luna} />));
    fireEvent.click(await screen.findByRole('switch', { name: 'Computer use for luna' }));
    await waitFor(() => expect(screen.queryByRole('switch', { name: 'Computer use for luna' })).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('puts the switch in the ⓘ Details sheet after Execution mode', async () => {
    const { InfoButton } = await import('./CompanionSession');
    const s = source(false);
    const sw = switchFor(s);
    render(withBoth(s, sw, <InfoButton soul={luna} />));
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const sheet = screen.getByRole('dialog', { name: 'Details · luna' });
    const toggle = await within(sheet).findByRole('switch', { name: 'Computer use for luna' }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(within(sheet).getByText('Off: its requests to control the screen are denied.')).toBeTruthy();
    fireEvent.click(toggle);
    expect(sw.set).toHaveBeenCalledWith(luna.agentId, true);
    await waitFor(() => expect(toggle.checked).toBe(true));
  });
});

describe('Customize… in the ⓘ sheet (#64)', () => {
  const profiles = (profile: ProfileSource['profile']): ProfileSource => ({ profile: vi.fn(profile), file: vi.fn() });
  const sheet = async (s: ProfileSource | null) => {
    const { InfoButton } = await import('./CompanionSession');
    render(<ProfileSourceContext.Provider value={s}><InfoButton soul={luna} /></ProfileSourceContext.Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    return screen.getByRole('dialog', { name: 'Details · luna' });
  };

  it('offers Customize… once agent-bot answers soul profile, and opens the dialog in place of the sheet', async () => {
    const s = profiles(async () => sampleProfile);
    const details = await sheet(s);
    fireEvent.click(await within(details).findByRole('button', { name: 'Customize…' }));
    expect(screen.queryByRole('dialog', { name: 'Details · luna' })).toBeNull();
    const dialog = await screen.findByRole('dialog', { name: 'Luna' });
    expect(within(dialog).getByRole('tab', { name: 'Profile' })).toBeTruthy();
    // Asked when the sheet opened, and again when the dialog opened.
    expect(s.profile).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Details' }));
  });

  it('hides Customize… on an agent-bot without soul profile', async () => {
    const s = profiles(async () => { throw new BridgeError('soul-profile-unsupported', 'this agent-bot has no soul profile'); });
    const details = await sheet(s);
    await waitFor(() => expect(s.profile).toHaveBeenCalledWith(luna.agentId));
    await Promise.resolve();
    expect(within(details).queryByRole('button', { name: 'Customize…' })).toBeNull();
  });

  it('hides Customize… without a profile source, asking nothing', async () => {
    const details = await sheet(null);
    expect(within(details).queryByRole('button', { name: 'Customize…' })).toBeNull();
  });
});

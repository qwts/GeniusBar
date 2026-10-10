import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeError, type SoulEnvHistory, type SoulEnvironment } from '../bridge';
import { sampleCensus, sampleEnvHistory, sampleEnvironments } from '../model/fixtures';
import type { SoulDreamStatus } from '../model/soulDream';
import { EnvironmentSourceContext, type EnvironmentSource } from './EnvironmentSection';
import { HISTORY_LIMIT, MemoryPanel } from './MemoryPanel';

afterEach(cleanup);

const [luna] = sampleCensus;
const scout = { ...luna, agentId: 'agent_s', name: 'scout', harness: 'claude' };
const env = sampleEnvironments.agent_p;
const older = sampleEnvironments.agent_s;

const dreamState = (acknowledged = false, agentId = 'agent_p'): SoulDreamStatus => ({
  schemaVersion: 1, agentId, available: true, executorConfigured: false, started: true, closing: false,
  orphanRecovery: 'process-group-or-quarantine', fault: null, maintenanceCoverage: 'unverified', registration: null,
  flights: agentId === 'agent_p' ? [{ agentId, runId: '00000000-0000-4000-8000-000000000000', status: 'recovery-required' }] : [],
  notices: { schemaVersion: 1, agentId, lastRunId: agentId === 'agent_p' ? '00000000-0000-4000-8000-000000000000' : null, suppressed: 0, notices: agentId === 'agent_p' ? [{
    id: 'ntc_0123456789abcdef01234567', fingerprint: `sha256:${'a'.repeat(64)}`, kind: 'recovery', subject: {}, detail: 'recovery-required',
    claim: 'host-observed', state: acknowledged ? 'acknowledged' : 'open', delivery: acknowledged ? 'host-acknowledged' : 'pending-host-read',
    firstRunId: '00000000-0000-4000-8000-000000000000', lastRunId: '00000000-0000-4000-8000-000000000000',
    firstSeenAt: '2026-10-08T09:12:00.000Z', lastSeenAt: '2026-10-08T09:12:00.000Z', occurrences: 3,
    acknowledgedAt: acknowledged ? '2026-10-09T12:00:00.000Z' : null,
  }] : [] },
});

const unused = () => vi.fn(async (): Promise<never> => { throw new Error('not used by the Memory tab'); });

function source(overrides: Partial<EnvironmentSource> = {}): EnvironmentSource {
  return {
    environment: vi.fn(async () => env),
    installRuntime: unused(),
    migrate: unused(),
    clean: unused(),
    exportLife: unused(),
    importLife: unused(),
    history: vi.fn(async () => sampleEnvHistory),
    dreamStatus: unused(),
    ...overrides,
  };
}

const show = (s: EnvironmentSource, soul = luna, refresh = 0) =>
  render(<EnvironmentSourceContext.Provider value={s}><MemoryPanel soul={soul} refresh={refresh} /></EnvironmentSourceContext.Provider>);

const sessions = () => screen.getByRole('region', { name: 'Past conversations' });
const continuityLine = () => screen.getByText('Continuity:', { exact: false }).closest('p')?.textContent;

describe('the Memory tab (#268)', () => {
  it('lists the runs the engine reports, newest first, as kind, harness, duration, outcome and start time; no message counts or titles', async () => {
    // The engine's order is not relied on: the fixture reversed still lists the newest first.
    const reversed: SoulEnvHistory = { ...sampleEnvHistory, turns: { ...sampleEnvHistory.turns, records: [...sampleEnvHistory.turns.records].reverse() } };
    const s = source({ history: vi.fn(async () => reversed) });
    show(s);
    expect(await screen.findByText('6 of 6 runs')).toBeTruthy();
    expect(s.history).toHaveBeenCalledWith('agent_p', HISTORY_LIMIT);
    expect(screen.getByText('The current conversation stays in Chat.')).toBeTruthy();
    // The runs are the section's first list; the revisions fold in their own below it.
    const rows = within(within(sessions()).getAllByRole('list')[0]).getAllByRole('listitem');
    expect(rows.length).toBe(6);
    // 3 min 42 s → 4 min; a task of 68.5 min → 1 h 09 min; a run without an end → —.
    expect(rows[0].textContent).toContain('Turn');
    expect(rows[0].textContent).toContain('codex');
    expect(rows[0].textContent).toContain('4 min');
    expect(rows[0].textContent).toContain('OK');
    expect(rows[2].textContent).toContain('Task');
    expect(rows[2].textContent).toContain('1 h 09 min');
    expect(rows[2].textContent).toContain('Failed');
    expect(rows[3].textContent).toContain('—');
    expect(rows[3].textContent).toContain('Cancelled');
    expect(rows[4].textContent).toContain('Session');
    expect(rows[4].textContent).toContain('claude');
    expect(rows[5].textContent).toContain('Launch');
    // The start time is a <time> with the engine's instant, formatted by the app's formatter.
    const times = sessions().querySelectorAll('time');
    expect(times[0].getAttribute('datetime')).toBe('2026-10-08T09:12:00.000Z');
    expect(times[0].textContent).toBe(new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'medium' }).format(Date.parse('2026-10-08T09:12:00.000Z')));
    // The mirror holds no message counts or titles, so none are shown or invented.
    expect(document.body.textContent).not.toMatch(/messages/);
    expect(document.body.textContent).not.toMatch(/Triage open issues/);
    // The revisions fold under the runs: at · id · reason.
    const revisions = screen.getByText('Revisions (3)').closest('details')!;
    expect(revisions.hasAttribute('open')).toBe(false);
    expect(within(revisions).getAllByRole('listitem').length).toBe(3);
    expect(within(revisions).getByText(/2026\.10\.1 ·/).textContent).toContain('Customize: AGENTS.md');
    // Refresh reads the descriptor and the history again.
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(s.history).toHaveBeenCalledTimes(2));
    expect(s.environment).toHaveBeenCalledTimes(2);
  });

  it('says the engine cannot list past runs without env-history, and never asks it', async () => {
    const noHistory: SoulEnvironment = { ...env, engine: { ...env.engine, capabilities: env.engine.capabilities.filter((c) => c !== 'env-history') } };
    const s = source({ environment: vi.fn(async () => noHistory) });
    show(s);
    expect(await screen.findByText("This agent-bot can't list past runs yet.")).toBeTruthy();
    expect(s.history).not.toHaveBeenCalled();
    expect(within(sessions()).queryAllByRole('listitem').length).toBe(0);
    expect(screen.queryByText(/of \d+ runs/)).toBeNull();
    cleanup();
    // The older engine (scout's) has no `env-history` either.
    const older_ = source({ environment: vi.fn(async () => older) });
    show(older_, scout);
    expect(await screen.findByText("This agent-bot can't list past runs yet.")).toBeTruthy();
    expect(older_.history).not.toHaveBeenCalled();
  });

  it('shows the empty state, the unavailable hint when the folder cannot be reached, and the engine\'s failure', async () => {
    const none = { total: 0, listed: 0, limit: 50, skipped: 0, truncated: false, records: [] };
    const empty: SoulEnvHistory = { ...sampleEnvHistory, turns: none, revisions: none };
    show(source({ history: vi.fn(async () => empty) }));
    expect(await screen.findByText('No runs recorded yet.')).toBeTruthy();
    expect(screen.getByText('0 of 0 runs')).toBeTruthy();
    expect(screen.queryByText(/Revisions/)).toBeNull();
    cleanup();
    // The memory area unreadable: continuity unavailable, and the list says so instead of "no runs".
    const unreadable: SoulEnvironment = { ...env, errors: [{ area: 'memory', message: 'the Agent Space could not be read' }] };
    show(source({ environment: vi.fn(async () => unreadable), history: vi.fn(async () => empty) }));
    await screen.findByText('0 of 0 runs');
    expect(continuityLine()).toBe('Continuity: Unavailable');
    expect(within(sessions()).getByRole('listitem').textContent).toBe("The soul folder can't be reached right now, so nothing is restored. Nothing has been lost.");
    expect(screen.queryByText('No runs recorded yet.')).toBeNull();
    cleanup();
    // The engine refusing: its message, as an alert.
    show(source({ history: vi.fn(async () => { throw new BridgeError('soul-env-history-failed', 'the mirror could not be read'); }) }));
    expect((await screen.findByRole('alert')).textContent).toBe("Couldn't read past runs: the mirror could not be read");
  });

  it('maps continuity to the design\'s word and hint, and says where memory lives', async () => {
    // luna: the Agent Space still linked outside the soul.
    show(source());
    await screen.findByText('6 of 6 runs');
    expect(continuityLine()).toBe('Continuity: Needs migration');
    expect(screen.getAllByText('History is kept. It will be restored once the soul folder is migrated to the current format.').length).toBe(1);
    expect(screen.getByText('No memories saved yet.', { exact: false }).textContent).toBe('No memories saved yet. History is kept. It will be restored once the soul folder is migrated to the current format.');
    expect(screen.getByText('Memory lives', { selector: 'dt' }).nextElementSibling?.textContent).toBe('Linked/Users/user/space/luna');
    cleanup();
    // Inside the soul, nothing pending: ready.
    const ready: SoulEnvironment = {
      ...env, errors: [], migration: { status: 'none', journal: null, steps: [] },
      components: env.components.map((c) => (c.id === 'memory' ? { ...c, location: 'inside', target: null, contained: true } : c)),
    };
    show(source({ environment: vi.fn(async () => ready) }));
    await screen.findByText('6 of 6 runs');
    expect(continuityLine()).toBe('Continuity: Ready');
    expect(screen.getAllByText('Retained history and memories are restored into the next run.').length).toBe(1);
    expect(screen.getByText('Memory lives', { selector: 'dt' }).nextElementSibling?.textContent).toBe(`Inside the soul${env.root.soulDir}/.soul-state/space`);
    cleanup();
    // scout's older engine has no `memory` capability: not supported.
    show(source({ environment: vi.fn(async () => older) }), scout);
    await screen.findByText("This agent-bot can't list past runs yet.");
    expect(continuityLine()).toBe('Continuity: Not supported');
    expect(screen.getAllByText("This harness can't receive restored context. History is kept and readable here.").length).toBe(1);
    cleanup();
    // No descriptor at all: an engine without `soul env` is not supported; any other failure is unavailable, never loss.
    show(source({ environment: vi.fn(async () => { throw new BridgeError('soul-env-unsupported', 'no soul env'); }) }));
    await waitFor(() => expect(continuityLine()).toBe('Continuity: Not supported'));
    expect(screen.getByText("This agent-bot can't list past runs yet.")).toBeTruthy();
    cleanup();
    show(source({ environment: vi.fn(async () => { throw new BridgeError('soul-env-unavailable', 'no app'); }) }));
    await waitFor(() => expect(continuityLine()).toBe('Continuity: Unavailable'));
    expect(screen.queryByText('Memory lives')).toBeNull();
    // The design's hint is the only mention of loss, and it denies it.
    expect(document.body.textContent?.match(/\blost\b/g)?.length).toBe((document.body.textContent?.match(/Nothing has been lost/g) ?? []).length);
  });

  it('gates dream status on its exact advertised capability and reports real per-soul quarantine and ledger claims', async () => {
    const noDream = source();
    show(noDream);
    expect(await screen.findByText("The installed engine doesn't report maintenance notices, so none can be shown here.")).toBeTruthy();
    expect(noDream.dreamStatus).not.toHaveBeenCalled();
    cleanup();

    const dreamEnv: SoulEnvironment = { ...env, engine: { ...env.engine, capabilities: [...env.engine.capabilities, 'dream-status'] } };
    const s = source({ environment: vi.fn(async () => dreamEnv), dreamStatus: vi.fn(async () => dreamState()) });
    show(s);
    expect(await screen.findByText('Maintenance run quarantined — recovery required')).toBeTruthy();
    expect(screen.getByText('Reported 3×')).toBeTruthy();
    expect(screen.getByText('Observed by this Mac')).toBeTruthy();
    expect(screen.getByText('Coverage unverified')).toBeTruthy();
    expect(screen.getByText('No owner recovery procedure is available yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
    expect(s.dreamStatus).toHaveBeenCalledWith('agent_p');
  });

  it('keeps quarantine visible when the authoritative ledger already says acknowledged and distinguishes daemon unavailability', async () => {
    const dreamEnv: SoulEnvironment = { ...env, engine: { ...env.engine, capabilities: [...env.engine.capabilities, 'dream-status'] } };
    const s = source({ environment: vi.fn(async () => dreamEnv), dreamStatus: vi.fn(async () => dreamState(true)) });
    show(s);
    expect(await screen.findByText('Acknowledged')).toBeTruthy();
    expect(screen.getByText('Maintenance run quarantined — recovery required')).toBeTruthy();
    cleanup();

    const down = source({ environment: vi.fn(async () => dreamEnv), dreamStatus: vi.fn(async () => { throw new BridgeError('dream-daemon-unavailable', 'daemon is down'); }) });
    show(down);
    expect(await screen.findByText("Can't reach the engine — maintenance status is unknown right now.")).toBeTruthy();
    expect(screen.queryByText('No maintenance notices.')).toBeNull();
  });

  it('does not show an empty healthy ledger when the engine reports unavailable or faulted status', async () => {
    const dreamEnv: SoulEnvironment = { ...env, engine: { ...env.engine, capabilities: [...env.engine.capabilities, 'dream-status'] } };
    const unavailable = source({ environment: vi.fn(async () => dreamEnv), dreamStatus: vi.fn(async () => ({ ...dreamState(), available: false, fault: 'dream-service-unavailable', notices: null })) });
    show(unavailable);
    expect(await screen.findByText("Can't reach the engine — maintenance status is unknown right now.")).toBeTruthy();
    expect(screen.getByText('Engine status: dream-service-unavailable')).toBeTruthy();
    expect(screen.queryByText('No maintenance notices.')).toBeNull();
    cleanup();

    const faulted = source({ environment: vi.fn(async () => dreamEnv), dreamStatus: vi.fn(async () => ({ ...dreamState(), fault: 'dream-store-conflict', notices: null })) });
    show(faulted);
    expect(await screen.findByText("Can't reach the engine — maintenance status is unknown right now.")).toBeTruthy();
    expect(screen.queryByText('No maintenance notices.')).toBeNull();
  });

  it('reflects the engine registration paused flag when describing whether a schedule is active', async () => {
    const dreamEnv: SoulEnvironment = { ...env, engine: { ...env.engine, capabilities: [...env.engine.capabilities, 'dream-status'] } };
    const registration = { agentId: 'agent_p', soulDir: '/souls/luna.soul', generation: '00000000-0000-4000-8000-000000000000',
      intervalHours: 24, paused: false, nextDueAt: '2026-10-10T12:00:00.000Z', createdAt: '2026-10-08T09:12:00.000Z',
      updatedAt: '2026-10-09T12:00:00.000Z', lastRun: null };
    show(source({ environment: vi.fn(async () => dreamEnv), dreamStatus: vi.fn(async () => ({ ...dreamState(), registration })) }));
    expect(await screen.findByText('Scheduled')).toBeTruthy();
    cleanup();
    show(source({ environment: vi.fn(async () => dreamEnv), dreamStatus: vi.fn(async () => ({ ...dreamState(), registration: { ...registration, paused: true, nextDueAt: null } })) }));
    expect(await screen.findByText('Not scheduled')).toBeTruthy();
  });

  it('keys dream reads by soul and ignores a deferred result after switching souls', async () => {
    const dreamEnv = (agentId: string): SoulEnvironment => ({
      ...env, identity: { ...env.identity, agentId }, engine: { ...env.engine, capabilities: [...env.engine.capabilities, 'dream-status'] },
    });
    let resolveOld!: (status: SoulDreamStatus) => void;
    const oldRead = new Promise<SoulDreamStatus>((resolve) => { resolveOld = resolve; });
    const s = source({
      environment: vi.fn(async (agentId: string) => dreamEnv(agentId)),
      dreamStatus: vi.fn((agentId: string) => agentId === 'agent_p' ? oldRead : Promise.resolve(dreamState(false, agentId))),
    });
    const view = show(s, luna);
    await waitFor(() => expect(s.dreamStatus).toHaveBeenCalledWith('agent_p'));

    view.rerender(<EnvironmentSourceContext.Provider value={s}><MemoryPanel soul={scout} /></EnvironmentSourceContext.Provider>);
    expect(screen.queryByText('Maintenance run quarantined — recovery required')).toBeNull();
    expect(await screen.findByText('No maintenance notices.')).toBeTruthy();
    expect(s.dreamStatus).toHaveBeenCalledWith('agent_s');

    await act(async () => { resolveOld(dreamState()); await oldRead; });
    expect(screen.queryByText('Maintenance run quarantined — recovery required')).toBeNull();
    expect(screen.getByText('No maintenance notices.')).toBeTruthy();
  });
});

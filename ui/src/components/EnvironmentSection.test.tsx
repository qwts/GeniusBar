import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeError, type EnvironmentMigration, type RuntimeInstall, type SoulCleanRow, type SoulEnvironment, type SoulEnvironmentClean } from '../bridge';
import { sampleCensus, sampleEnvironments } from '../model/fixtures';
import { EnvironmentSection, EnvironmentSourceContext, type EnvironmentSource } from './EnvironmentSection';

afterEach(cleanup);

const [luna] = sampleCensus;
const scout = { ...luna, agentId: 'agent_s', name: 'scout', harness: 'claude' };
const env = sampleEnvironments.agent_p;
const older = sampleEnvironments.agent_s;

const report = (overrides: Partial<RuntimeInstall> = {}): RuntimeInstall => ({ agentId: 'agent_p', ready: true, installed: ['node'], skipped: [], runtimes: [], harnesses: [], ...overrides });

// agent-bot 0.10.54's `soul env clean agent_p --plan --json`, shortened: two cache entries and a runtime cache removable, a fresh revision staging kept.
const cleanRow = (component: string, relative: string, kind: string, files: number | null, bytes: number | null, extra: Partial<SoulCleanRow> = {}): SoulCleanRow =>
  ({ component, relative, path: `/s/${relative}`, classification: component === 'runtimes' ? 'runtime' : component, retention: component === 'temp' ? 'disposable' : 'reconstructible', kind, files, bytes, reason: null, error: null, ...extra });
const cleanPlan: SoulEnvironmentClean = {
  agentId: 'agent_p', soulDir: '/s', applied: false, decision: 'planned', components: ['cache', 'temp', 'runtimes'],
  removable: [cleanRow('cache', '.soul-state/cache/index.db', 'cache-entry', 1, 12), cleanRow('cache', '.soul-state/cache/nested', 'cache-entry', 1, 17), cleanRow('runtimes', '.soul-state/runtimes/node/npm-cache', 'runtime-cache', 1, 9)],
  removed: [], failed: [],
  kept: [cleanRow('temp', '.soul-state/tmp/revision-00000000-0000-4000-8000-000000000001', 'revision-staging', null, null, { reason: "a revision staging within its 24-hour window may be a host's edit in progress; agent-bot soul revision prepare --discard removes it" })],
  files: 3, bytes: 38,
};
const cleaned: SoulEnvironmentClean = { ...cleanPlan, applied: true, decision: 'cleaned', removed: cleanPlan.removable };
// `--complete --plan` as the engine lists luna's two pending steps, and the report after the apply.
const completePlan: EnvironmentMigration = { agentId: 'agent_p', operation: 'complete', decision: 'planned', steps: [
  { id: 'space-into-soul', status: 'copying', note: 'interrupted while copying; resumed', from: '/Users/user/space/luna', to: '/s/.soul-state/space' },
  { id: 'adopt-host-signin:codex', status: 'pending', note: 'not started', from: '/Users/user/.codex', to: '/s/.soul-state/tools/codex' },
] };
const completed: EnvironmentMigration = { ...completePlan, decision: 'completed', steps: completePlan.steps.map((s) => ({ ...s, status: 'done', note: s.id === 'space-into-soul' ? 'copied 2 file(s), 0 link(s); source retired' : 'copied auth.json' })) };

function source(overrides: Partial<EnvironmentSource> = {}): EnvironmentSource {
  return {
    environment: vi.fn(async () => env),
    installRuntime: vi.fn(async () => report()),
    migrate: vi.fn(async (agentId: string, kind: string, _harness: string | null, plan = false): Promise<EnvironmentMigration> =>
      (kind === 'complete' ? (plan ? completePlan : completed) : { agentId, operation: kind, decision: kind === 'space-into-soul' ? 'migrated' : 'adopted', steps: [] })),
    clean: vi.fn(async (_agentId: string, { plan }: { plan: boolean }) => (plan ? cleanPlan : cleaned)),
    ...overrides,
  };
}

const show = (s: EnvironmentSource, soul = luna, refresh = 0) =>
  render(<EnvironmentSourceContext.Provider value={s}><EnvironmentSection soul={soul} refresh={refresh} /></EnvironmentSourceContext.Provider>);

const section = () => screen.getByRole('region', { name: 'Environment' });

describe('the Environment section (#268)', () => {
  it('shows the Agent ID as the census carries it, and the descriptor rows, nothing inferred', async () => {
    const s = source();
    show(s);
    await screen.findByText('Components');
    expect(s.environment).toHaveBeenCalledWith('agent_p');
    expect(within(section()).getByText('agent_p')).toBeTruthy();
    // Every component row, both dimensions.
    for (const id of env.components.map((c) => c.id)) expect(within(section()).getAllByText(id).length).toBeGreaterThan(0);
    expect(screen.getAllByText('reconstructible').length).toBeGreaterThan(0);
    expect(screen.getAllByText('private-home').length).toBeGreaterThan(0);
    // Declared versus installed.
    expect(screen.getByText('Harnesses and runtimes')).toBeTruthy();
    expect(screen.getAllByText('Missing').length).toBeGreaterThan(0);
    expect(screen.getByText('selected', { exact: false })).toBeTruthy();
    // Problems from the engine, with the recovery command shown as text.
    expect(screen.getByText('agent-bot soul secret agent_p set openai-key', { selector: 'code' })).toBeTruthy();
    expect(screen.getAllByText('Blocks the next run').length).toBe(1);
    expect(screen.getAllByText('Warning').length).toBe(3);
  });

  it('shows secret status only: the word, never a value', async () => {
    const leaky: SoulEnvironment = { ...env, providers: { ...env.providers, secrets: [{ name: 'openai-key', store: 'keychain', status: 'present', value: 'sk-NEVER-IN-THE-DOM', usedBy: ['codex'] }] } };
    const { container } = show(source({ environment: vi.fn(async () => leaky) }));
    expect(await screen.findByText('Set — value hidden')).toBeTruthy();
    expect(container.innerHTML).not.toContain('NEVER-IN-THE-DOM');
    expect(screen.getByText('openai-key')).toBeTruthy();
  });

  it('keeps the five states distinct, with no loss claimed in any', async () => {
    const offline = source({ environment: vi.fn(async () => { throw new BridgeError('soul-env-unavailable', 'no sidecar'); }) });
    const { unmount } = show(offline);
    expect(await screen.findByText("agent-bot isn't reachable, so this can't be checked right now. That doesn't mean anything was lost.")).toBeTruthy();
    expect(screen.queryByText('Components')).toBeNull();
    unmount();

    const unsupported = source({ environment: vi.fn(async () => { throw new BridgeError('soul-env-unsupported', 'old'); }) });
    const second = show(unsupported);
    expect(await screen.findByText("This agent-bot can't describe luna's environment yet. That doesn't mean anything was lost.")).toBeTruthy();
    second.unmount();

    const third = show(source());
    expect(await screen.findByText("Some of this couldn't be read; the rest is complete. Unavailable information doesn't mean anything was lost.")).toBeTruthy();
    expect(screen.getByText('generated: Generated output could not be checked: AGENTS.md is not UTF-8 text')).toBeTruthy();
    third.unmount();

    const migration = show(source({ environment: vi.fn(async () => ({ ...env, errors: [] })) }));
    expect((await screen.findAllByText('Needs migration')).length).toBe(2); // state card and continuity
    expect(screen.getByText('A migration step is pending or stopped short. Nothing was lost; the steps are listed below.')).toBeTruthy();
    expect(screen.getByText(/space-into-soul — pending/)).toBeTruthy();
    migration.unmount();

    const ready: SoulEnvironment = { ...older, migration: { status: 'none', journal: null, steps: [] } };
    show(source({ environment: vi.fn(async () => ready) }), scout);
    expect(await screen.findByText('Ready — agent-bot reports nothing blocking the next run.')).toBeTruthy();
    const page = document.body.textContent ?? '';
    expect(page).not.toMatch(/\blost\b(?! anything| nothing)/);
  });

  it('says what memory continuity the engine reports, with the transcript caution', async () => {
    show(source());
    await screen.findByText('Memory and history');
    expect(screen.getByText('Continuity:', { exact: false }).closest('p')?.textContent).toBe('Continuity: Needs migration');
    expect(screen.getByText("A visible transcript doesn't by itself mean the next run will remember it.")).toBeTruthy();
    expect(screen.getByText('42 turns · 3 revisions mirrored in the soul')).toBeTruthy();
    cleanup();
    show(source({ environment: vi.fn(async () => older) }), scout);
    await screen.findByText('Memory and history');
    expect(screen.getByText('Continuity:', { exact: false }).closest('p')?.textContent).toBe('Continuity: Not supported');
  });

  it('keeps export and import visible but disabled, and the clean too until the engine lists env-clean', async () => {
    // The older engine: all three gated, the original copy.
    show(source({ environment: vi.fn(async () => older) }), scout);
    await screen.findByText('Components');
    for (const name of ['Export', 'Import', 'Clean up cache']) {
      const button = screen.getByRole('button', { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    }
    expect(screen.getByText("Export, import and cache clean-up aren't available yet.")).toBeTruthy();
    cleanup();
    // The same descriptor without the capability, whatever the version says: still gated.
    const noClean: SoulEnvironment = { ...env, engine: { ...env.engine, version: '99.0.0', capabilities: env.engine.capabilities.filter((c) => c !== 'env-clean') } };
    show(source({ environment: vi.fn(async () => noClean) }));
    await screen.findByText('Components');
    expect((screen.getByRole('button', { name: 'Clean up cache' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Export, import and cache clean-up aren't available yet.")).toBeTruthy();
    cleanup();
    // With env-clean the clean is live and the note names only the two that are not.
    show(source());
    await screen.findByText('Components');
    expect((screen.getByRole('button', { name: 'Clean up cache' }) as HTMLButtonElement).disabled).toBe(false);
    for (const name of ['Export', 'Import']) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Export and import aren't available yet.")).toBeTruthy();
    expect(screen.queryByText("Export, import and cache clean-up aren't available yet.")).toBeNull();
  });

  it('re-checks on request and on refresh, and shows the sign-in per harness', async () => {
    const s = source();
    const { rerender } = show(s);
    await screen.findByText('Components');
    expect(screen.getByText('In the soul: Not signed in')).toBeTruthy();
    expect(screen.getByText('On this Mac: Signed in')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Re-check environment' }));
    await waitFor(() => expect(s.environment).toHaveBeenCalledTimes(2));
    rerender(<EnvironmentSourceContext.Provider value={s}><EnvironmentSection soul={luna} refresh={1} /></EnvironmentSourceContext.Provider>);
    await waitFor(() => expect(s.environment).toHaveBeenCalledTimes(3));
  });
});

describe('the install flow (#268)', () => {
  it('needs the runtimes capability and the engine-listed action: the older engine offers no plan', async () => {
    show(source({ environment: vi.fn(async () => older) }), scout);
    await screen.findByText('Components');
    expect(screen.queryByRole('button', { name: 'Review install plan' })).toBeNull();
    expect(screen.queryByRole('button', { name: /sign-in/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Migrate' })).toBeNull();
  });

  it('reviews the plan, starts nothing until confirmed, then reports progress and the verified result', async () => {
    const s = source({ installRuntime: vi.fn(async () => report({ ready: true })), environment: vi.fn(async () => env) });
    show(s);
    const review = await screen.findByRole('button', { name: 'Review install plan' });
    expect(screen.getByText("node isn't installed for this soul. agent-bot can install it.")).toBeTruthy();
    fireEvent.click(review);
    const dialog = screen.getByRole('dialog', { name: 'Install what luna needs?' });
    expect(within(dialog).getByText('agent-bot will run these steps. Nothing starts until you confirm.')).toBeTruthy();
    expect(within(dialog).getByText('Not started')).toBeTruthy();
    expect(s.installRuntime).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Confirm and install' }));
    // Escape before anything runs is Cancel: nothing started, focus back on the trigger.
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(s.installRuntime).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(review);

    fireEvent.click(review);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and install' }));
    expect(s.installRuntime).toHaveBeenCalledWith('agent_p', 'node');
    await screen.findByText('Done. agent-bot reports luna is ready.');
    expect(screen.getByText('Completed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    // The descriptor is read again afterwards.
    await waitFor(() => expect(s.environment).toHaveBeenCalledTimes(2));
    // The Agent ID did not change across the run.
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(section()).getByText('agent_p')).toBeTruthy();
  });

  it('shows progress with aria-live and no Cancel while a step runs, ignoring Escape', async () => {
    let finish: (value: RuntimeInstall) => void = () => {};
    const s = source({ installRuntime: vi.fn(() => new Promise<RuntimeInstall>((resolve) => { finish = resolve; })) });
    show(s);
    fireEvent.click(await screen.findByRole('button', { name: 'Review install plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and install' }));
    const dialog = screen.getByRole('dialog');
    const status = within(dialog).getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('Installing… step 1 of 1');
    expect(within(dialog).getByText("This step can't be cancelled once started.")).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Cancel' })).toBeNull();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    await act(async () => { finish(report()); });
    await screen.findByText('Done. agent-bot reports luna is ready.');
  });

  it('on failure shows the engine message, the partial state, focuses Retry, and Retry re-runs the failed step', async () => {
    const twoMissing: SoulEnvironment = { ...env, runtimes: { ...env.runtimes, missing: [{ name: 'uv', version: '0.12.23', reason: 'not provisioned' }, { name: 'python', version: '3.12.15', reason: 'not provisioned' }] } };
    const install = vi.fn<(agentId: string, runtime: string) => Promise<RuntimeInstall>>()
      .mockRejectedValueOnce(new BridgeError('runtime-download-failed', 'uv: could not download; check the network and retry'))
      .mockResolvedValueOnce(report({ installed: ['uv'], ready: false }))
      .mockResolvedValueOnce(report({ installed: ['python'], ready: false }));
    const s = source({ environment: vi.fn(async () => twoMissing), installRuntime: install });
    show(s);
    fireEvent.click(await screen.findByRole('button', { name: 'Review install plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and install' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe("Step “uv” failed: uv: could not download; check the network and retry. Steps below show what is known; agent-bot's report is the source of truth for partial state.");
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Failed: uv: could not download; check the network and retry')).toBeTruthy();
    expect(within(dialog).getByText('Not started')).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/roll(ed)? back/i);
    const retry = within(dialog).getByRole('button', { name: 'Retry' });
    await waitFor(() => expect(document.activeElement).toBe(retry));
    expect(install).toHaveBeenCalledTimes(1);
    fireEvent.click(retry);
    await waitFor(() => expect(install).toHaveBeenCalledTimes(3));
    expect(install.mock.calls.map(([, runtime]) => runtime)).toEqual(['uv', 'uv', 'python']);
    // Every step completed, but the engine did not report ready: no success claimed.
    await screen.findByText("Installed. agent-bot still reports something blocking luna's next run.");
  });

  it('reports an unknown outcome as such when the engine does not say how the install ended', async () => {
    const s = source({ installRuntime: vi.fn(async () => report({ installed: [], ready: null })) });
    show(s);
    fireEvent.click(await screen.findByRole('button', { name: 'Review install plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and install' }));
    await screen.findByText("agent-bot didn't report how the install ended.");
    expect(screen.getByText('Result unknown')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('sign-in adoption and the space migration (#268)', () => {
  it('offers the adopt button only with tool-homes and the engine-listed action, and runs the engine migration', async () => {
    const s = source();
    show(s);
    const adopt = await screen.findByRole('button', { name: 'Use existing codex sign-in' });
    fireEvent.click(adopt);
    expect(s.migrate).toHaveBeenCalledWith('agent_p', 'adopt-host-signin', 'codex');
    await screen.findByText('adopt-host-signin: adopted');
    await waitFor(() => expect(s.environment).toHaveBeenCalledTimes(2));
  });

  it('hides the adopt button without the capability, even with the problem listed', async () => {
    const gated: SoulEnvironment = { ...env, engine: { ...env.engine, capabilities: env.engine.capabilities.filter((c) => c !== 'tool-homes') } };
    show(source({ environment: vi.fn(async () => gated) }));
    await screen.findByText('Components');
    expect(screen.queryByRole('button', { name: 'Use existing codex sign-in' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Migrate' })).toBeTruthy();
  });

  it('migrates the Agent Space behind the memory capability and shows the engine refusal', async () => {
    const s = source({ migrate: vi.fn(async () => { throw new BridgeError('space-migrate-busy', 'agent_p is running; stop it before moving its Agent Space'); }) });
    show(s);
    fireEvent.click(await screen.findByRole('button', { name: 'Migrate' }));
    expect(s.migrate).toHaveBeenCalledWith('agent_p', 'space-into-soul', null);
    await screen.findByText('Not migrated: agent_p is running; stop it before moving its Agent Space');
    const noMemory: SoulEnvironment = { ...env, engine: { ...env.engine, capabilities: ['env', 'runtimes', 'tool-homes'] } };
    cleanup();
    show(source({ environment: vi.fn(async () => noMemory) }));
    await screen.findByText('Components');
    expect(screen.queryByRole('button', { name: 'Migrate' })).toBeNull();
  });
});

describe('the cache clean-up (#268, agent-bot-identity #583 slice 6)', () => {
  const openClean = async () => {
    const trigger = await screen.findByRole('button', { name: 'Clean up cache' });
    fireEvent.click(trigger);
    return trigger;
  };

  it('reads the plan, lists what would go by component with sizes and what stays with its reason, and removes nothing until confirmed', async () => {
    const s = source();
    show(s);
    const trigger = await openClean();
    const dialog = screen.getByRole('dialog', { name: "Clean up luna's cache?" });
    expect(s.clean).toHaveBeenCalledWith('agent_p', { plan: true, components: null });
    expect(await within(dialog).findByText('agent-bot will remove these reconstructible files. Nothing starts until you confirm.')).toBeTruthy();
    expect(within(dialog).getByText('cache · 2 files (29 B)')).toBeTruthy();
    expect(within(dialog).getByText('runtimes · 1 files (9 B)')).toBeTruthy();
    expect(within(dialog).getByText('.soul-state/cache/nested')).toBeTruthy();
    expect(within(dialog).getByText('Kept')).toBeTruthy();
    expect(within(dialog).getByText(/within its 24-hour window/)).toBeTruthy();
    // Nothing of durable data is claimed either way.
    expect(dialog.textContent).not.toMatch(/durable|memory|history/i);
    expect(s.clean).toHaveBeenCalledTimes(1);
    const confirm = within(dialog).getByRole('button', { name: 'Confirm and clean' });
    await waitFor(() => expect(document.activeElement).toBe(confirm));
    // Escape before confirming is Cancel: nothing removed, focus back on the trigger.
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(s.clean).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and clean' }));
    expect(s.clean).toHaveBeenLastCalledWith('agent_p', { plan: false, components: null });
    await screen.findByText('Done. agent-bot removed 3 files (38 B).');
    expect(screen.queryByRole('button', { name: 'Confirm and clean' })).toBeNull();
    // The descriptor is read again afterwards.
    await waitFor(() => expect(s.environment).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('says "Nothing to clean." for an empty plan, with no Confirm, and when the engine removed nothing', async () => {
    const empty: SoulEnvironmentClean = { ...cleanPlan, removable: [], kept: [], files: 0, bytes: 0 };
    const s = source({ clean: vi.fn(async (_agentId: string, { plan }: { plan: boolean }) => (plan ? empty : { ...empty, applied: true, decision: 'nothing' })) });
    show(s);
    await openClean();
    expect(await screen.findByText('Nothing to clean.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm and clean' })).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!);
    cleanup();
    const nothing = vi.fn(async (_agentId: string, { plan }: { plan: boolean }) => (plan ? cleanPlan : { ...cleanPlan, applied: true, decision: 'nothing', files: 0, bytes: 0 }));
    show(source({ clean: nothing }));
    await openClean();
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and clean' }));
    const status = await screen.findByText('Nothing to clean.');
    expect(status.getAttribute('aria-live')).toBe('polite');
  });

  it('on a failed removal lists the paths not removed with their error, focuses Retry, and Retry applies again', async () => {
    const failed: SoulEnvironmentClean = { ...cleanPlan, applied: true, decision: 'failed', removed: cleanPlan.removable.slice(1), failed: [{ ...cleanPlan.removable[0], error: 'EACCES' }], files: 2, bytes: 26 };
    const clean = vi.fn<(agentId: string, options: { plan: boolean }) => Promise<SoulEnvironmentClean>>()
      .mockResolvedValueOnce(cleanPlan).mockResolvedValueOnce(failed).mockResolvedValueOnce(cleaned);
    const s = source({ clean });
    show(s);
    await openClean();
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and clean' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe("Some paths weren't removed. Paths below show what is known; agent-bot's report is the source of truth for what remains.");
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('.soul-state/cache/index.db')).toBeTruthy();
    expect(within(dialog).getByText('Not removed: EACCES')).toBeTruthy();
    expect(within(dialog).getByText('Done. agent-bot removed 2 files (26 B).')).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/roll(ed)? back/i);
    const retry = within(dialog).getByRole('button', { name: 'Retry' });
    await waitFor(() => expect(document.activeElement).toBe(retry));
    fireEvent.click(retry);
    await screen.findByText('Done. agent-bot removed 3 files (38 B).');
    expect(clean.mock.calls.map(([, o]) => o.plan)).toEqual([true, false, false]);
  });

  it("shows the engine's refusal while the soul runs, with its command as text, and runs nothing itself", async () => {
    const clean = vi.fn<(agentId: string, options: { plan: boolean }) => Promise<SoulEnvironmentClean>>()
      .mockResolvedValueOnce(cleanPlan)
      .mockRejectedValueOnce(new BridgeError('soul-running', 'agent_p is running (a turn in flight or a warm harness); stop it before cleaning its environment', 'agent-bot soul stop agent_p'));
    const s = source({ clean });
    show(s);
    await openClean();
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and clean' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Not cleaned: agent_p is running (a turn in flight or a warm harness); stop it before cleaning its environment');
    expect(screen.getByText('agent-bot soul stop agent_p', { selector: 'code' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /stop/i })).toBeNull();
    expect(clean).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    // A plan that cannot be read is shown the same way, with Close.
    cleanup();
    show(source({ clean: vi.fn(async () => { throw new BridgeError('soul-state-missing', '/s has no .soul-state yet; spawn or launch the soul first'); }) }));
    await openClean();
    expect((await screen.findByRole('alert')).textContent).toContain('Not cleaned: /s has no .soul-state yet; spawn or launch the soul first');
    expect(screen.getAllByRole('button', { name: 'Close' }).length).toBe(2);
  });

  it('while agent-bot asks for approval shows the gate line with aria-live, no Cancel, and ignores Escape', async () => {
    let finish: (value: SoulEnvironmentClean) => void = () => {};
    const clean = vi.fn<(agentId: string, options: { plan: boolean }) => Promise<SoulEnvironmentClean>>()
      .mockResolvedValueOnce(cleanPlan)
      .mockImplementationOnce(() => new Promise<SoulEnvironmentClean>((resolve) => { finish = resolve; }));
    const s = source({ clean });
    show(s);
    await openClean();
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and clean' }));
    const dialog = screen.getByRole('dialog');
    const status = within(dialog).getByText('Cleaning… agent-bot asks for your approval (Touch ID or your login password).');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(within(dialog).queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(within(dialog).getByText("This step can't be cancelled once started.")).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    await act(async () => { finish(cleaned); });
    await screen.findByText('Done. agent-bot removed 3 files (38 B).');
  });
});

describe('completing the migration (#268, agent-bot-identity #583 slice 6)', () => {
  it('offers the button only with migrate-complete and a step still to finish', async () => {
    show(source());
    expect(await screen.findByRole('button', { name: 'Complete migration' })).toBeTruthy();
    cleanup();
    const noCap: SoulEnvironment = { ...env, engine: { ...env.engine, capabilities: env.engine.capabilities.filter((c) => c !== 'migrate-complete') } };
    show(source({ environment: vi.fn(async () => noCap) }));
    await screen.findByText('Components');
    expect(screen.queryByRole('button', { name: 'Complete migration' })).toBeNull();
    cleanup();
    const done: SoulEnvironment = { ...env, migration: { ...env.migration, status: 'none', steps: env.migration.steps.map((s) => ({ ...s, status: 'done' })) } };
    show(source({ environment: vi.fn(async () => done) }));
    await screen.findByText('Components');
    expect(screen.queryByRole('button', { name: 'Complete migration' })).toBeNull();
  });

  it('reads the plan with its notes, confirms, then shows each step as the engine reported it and re-reads the descriptor', async () => {
    const s = source();
    show(s);
    const trigger = await screen.findByRole('button', { name: 'Complete migration' });
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: "Complete luna's migration?" });
    expect(s.migrate).toHaveBeenCalledWith('agent_p', 'complete', null, true);
    expect(await within(dialog).findByText('agent-bot will finish these steps. Nothing starts until you confirm.')).toBeTruthy();
    expect(within(dialog).getByText('interrupted while copying; resumed')).toBeTruthy();
    expect(within(dialog).getByText('not started')).toBeTruthy();
    expect(within(dialog).getByText('copying')).toBeTruthy();
    expect(s.migrate).toHaveBeenCalledTimes(1);
    const confirm = within(dialog).getByRole('button', { name: 'Confirm and complete' });
    await waitFor(() => expect(document.activeElement).toBe(confirm));
    fireEvent.click(confirm);
    expect(s.migrate).toHaveBeenLastCalledWith('agent_p', 'complete', null, false);
    await screen.findByText('Done. agent-bot reports the migration completed.');
    expect(within(dialog).getAllByText('Completed').length).toBe(2);
    expect(within(dialog).getByText('copied auth.json')).toBeTruthy();
    await waitFor(() => expect(s.environment).toHaveBeenCalledTimes(2));
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' }).at(-1)!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('on a failed step shows completed, failed and not started rows, focuses Retry, and shows a soul-running refusal as text', async () => {
    const failed: EnvironmentMigration = { ...completePlan, decision: 'failed', steps: [
      { ...completePlan.steps[0], status: 'failed', note: 'space-migrate-source-missing: /Users/user/space/luna is gone' },
      { ...completePlan.steps[1], status: 'pending', note: 'not started' },
    ] };
    const migrate = vi.fn<(agentId: string, kind: string, harness: string | null, plan?: boolean) => Promise<EnvironmentMigration>>()
      .mockResolvedValueOnce(completePlan).mockResolvedValueOnce(failed)
      .mockRejectedValueOnce(new BridgeError('soul-running', 'agent_p is running; stop it before completing its migration', 'agent-bot soul stop agent_p'));
    show(source({ migrate }));
    fireEvent.click(await screen.findByRole('button', { name: 'Complete migration' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and complete' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe("A step failed. Steps below show what is known; agent-bot's report is the source of truth for partial state.");
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Failed')).toBeTruthy();
    expect(within(dialog).getByText('Not started')).toBeTruthy();
    expect(within(dialog).getByText('space-migrate-source-missing: /Users/user/space/luna is gone')).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/roll(ed)? back/i);
    const retry = within(dialog).getByRole('button', { name: 'Retry' });
    await waitFor(() => expect(document.activeElement).toBe(retry));
    fireEvent.click(retry);
    expect((await screen.findByText(/Not completed: agent_p is running/)).textContent).toBe('Not completed: agent_p is running; stop it before completing its migration');
    expect(screen.getByText('agent-bot soul stop agent_p', { selector: 'code' })).toBeTruthy();
    expect(migrate.mock.calls.map(([, kind, , plan]) => [kind, plan])).toEqual([['complete', true], ['complete', false], ['complete', false]]);
  });
});

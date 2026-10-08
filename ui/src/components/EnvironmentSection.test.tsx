import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeError, type EnvironmentMigration, type ImportIdentity, type RuntimeInstall, type SoulCleanRow, type SoulEnvironment, type SoulEnvironmentClean, type SoulEnvironmentImport } from '../bridge';
import { sampleCensus, sampleEnvHistory, sampleEnvironments, sampleLifeExport, sampleLifeImport } from '../model/fixtures';
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
    exportLife: vi.fn(async (_agentId: string, { plan, to }: { plan: boolean; to: string | null }) => (plan ? sampleLifeExport : { ...sampleLifeExport, applied: true, decision: 'exported', file: to })),
    importLife: vi.fn(async (archive: string, { plan }: { plan: boolean; identity: ImportIdentity; name: string | null }) => (plan ? { ...sampleLifeImport, archive } : { ...sampleLifeImport, archive, applied: true, decision: 'imported', journal: 'restored' })),
    history: vi.fn(async () => sampleEnvHistory),
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

  it('keeps export, import and the clean visible but disabled until the engine lists each capability', async () => {
    // The older engine: all three gated, the original copy.
    show(source({ environment: vi.fn(async () => older) }), scout);
    await screen.findByText('Components');
    for (const name of ['Export', 'Import', 'Clean up cache']) {
      const button = screen.getByRole('button', { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    }
    expect(screen.getByText("Export, import and cache clean-up aren't available yet.")).toBeTruthy();
    cleanup();
    // The same descriptor without env-clean, whatever the version says: the clean alone stays gated.
    const noClean: SoulEnvironment = { ...env, engine: { ...env.engine, version: '99.0.0', capabilities: env.engine.capabilities.filter((c) => c !== 'env-clean') } };
    show(source({ environment: vi.fn(async () => noClean) }));
    await screen.findByText('Components');
    expect((screen.getByRole('button', { name: 'Clean up cache' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Export life…' })).toBeTruthy();
    expect(screen.getByText('Not available yet: Clean up cache.')).toBeTruthy();
    cleanup();
    // Without env-export and env-import (agent-bot 0.10.54): the clean is live and the note names the two that are not.
    const noLife: SoulEnvironment = { ...env, engine: { ...env.engine, capabilities: env.engine.capabilities.filter((c) => c !== 'env-export' && c !== 'env-import') } };
    show(source({ environment: vi.fn(async () => noLife) }));
    await screen.findByText('Components');
    expect((screen.getByRole('button', { name: 'Clean up cache' }) as HTMLButtonElement).disabled).toBe(false);
    for (const name of ['Export', 'Import']) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Export and import aren't available yet.")).toBeTruthy();
    expect(screen.queryByText("Export, import and cache clean-up aren't available yet.")).toBeNull();
    cleanup();
    // One of the two alone: that one gated, the other live.
    const noImport: SoulEnvironment = { ...env, engine: { ...env.engine, capabilities: env.engine.capabilities.filter((c) => c !== 'env-import') } };
    show(source({ environment: vi.fn(async () => noImport) }));
    await screen.findByText('Components');
    expect(screen.getByRole('button', { name: 'Export life…' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Not available yet: Import.')).toBeTruthy();
    cleanup();
    // All three listed: every button live and no gated copy at all.
    show(source());
    await screen.findByText('Components');
    for (const name of ['Export life…', 'Import life…', 'Clean up cache']) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/available yet/)).toBeNull();
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

describe("exporting a soul's life (#268, agent-bot-identity #583 slice 7)", () => {
  const openExport = async () => {
    const trigger = await screen.findByRole('button', { name: 'Export life…' });
    fireEvent.click(trigger);
    return trigger;
  };

  it('reads the manifest, lists what travels, what is left out and the pointers, writes nothing until confirmed, then names the file', async () => {
    const s = source();
    show(s);
    const trigger = await openExport();
    const dialog = screen.getByRole('dialog', { name: "Export luna's life?" });
    expect(s.exportLife).toHaveBeenCalledWith('agent_p', { plan: true, to: null });
    expect(await within(dialog).findByText("agent-bot will write luna's life as one file: what is durable and the soul's own. Nothing is written until you confirm.")).toBeTruthy();
    // The engine's totals and its rows per classification, nothing recounted from the filesystem.
    expect(within(dialog).getByText('17 files (196 KB)')).toBeTruthy();
    expect(within(dialog).getByText('definition · 4 files (6.1 KB)')).toBeTruthy();
    expect(within(dialog).getByText('private-home · 4 files (48 KB)')).toBeTruthy();
    expect(within(dialog).getByText('Memory: linked (/Users/user/space/luna) · revision journal: 3 entries')).toBeTruthy();
    expect(within(dialog).getByText('Left out')).toBeTruthy();
    expect(within(dialog).getByText('.soul-state/credentials')).toBeTruthy();
    expect(within(dialog).getByText('credentials never travel: GitHub App keys and file-store secrets stay on this Mac')).toBeTruthy();
    expect(within(dialog).getByText('Linked workspaces')).toBeTruthy();
    expect(within(dialog).getByText('site → /Users/user/code/site')).toBeTruthy();
    expect(within(dialog).getByText('feature/landing 4f2c9a1b7e3d · uncommitted changes as a patch · 2 untracked files')).toBeTruthy();
    expect(within(dialog).getByText('Links recorded, not followed')).toBeTruthy();
    expect(within(dialog).getByText('.soul-state/space → /Users/user/space/luna')).toBeTruthy();
    // The destination defaults to the Desktop, named after the soul; a plain field, no file dialog.
    const to = within(dialog).getByLabelText('Save to') as HTMLInputElement;
    expect(to.value).toBe('~/Desktop/luna.soul-life.tar.gz');
    expect(s.exportLife).toHaveBeenCalledTimes(1);
    const confirm = within(dialog).getByRole('button', { name: 'Confirm and export' });
    await waitFor(() => expect(document.activeElement).toBe(confirm));
    // No loss claimed, no secret value anywhere: the manifest holds names and hashes only.
    expect(dialog.textContent).not.toMatch(/\blost\b|roll(ed)? back/i);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(s.exportLife).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    const field = await screen.findByLabelText('Save to');
    fireEvent.change(field, { target: { value: '/Volumes/T7/luna.soul-life.tar.gz' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and export' }));
    expect(s.exportLife).toHaveBeenLastCalledWith('agent_p', { plan: false, to: '/Volumes/T7/luna.soul-life.tar.gz' });
    const status = await screen.findByText('Done. agent-bot wrote /Volumes/T7/luna.soul-life.tar.gz (17 files, 196 KB).');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(screen.getByText('5 paths left out · 1 linked workspaces as pointers. The manifest inside the file holds the detail.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm and export' })).toBeNull();
    await waitFor(() => expect(s.environment).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps the destination field after a target refusal so another path can be tried, and shows soul-running with its command as text', async () => {
    const exportLife = vi.fn<(agentId: string, options: { plan: boolean; to: string | null }) => Promise<typeof sampleLifeExport>>()
      .mockResolvedValueOnce(sampleLifeExport)
      .mockRejectedValueOnce(new BridgeError('export-target-exists', '/Users/user/Desktop/luna.soul-life.tar.gz already exists; choose another path', 'pick a file that does not exist yet'))
      .mockRejectedValueOnce(new BridgeError('soul-running', 'agent_p is running (a turn in flight or a warm harness); stop it before exporting its life', 'agent-bot soul stop agent_p'));
    const s = source({ exportLife });
    show(s);
    await openExport();
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and export' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Not exported: /Users/user/Desktop/luna.soul-life.tar.gz already exists; choose another path');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Pick another path and retry.')).toBeTruthy();
    const field = within(dialog).getByLabelText('Save to');
    fireEvent.change(field, { target: { value: '~/Desktop/luna-2.soul-life.tar.gz' } });
    const retry = within(dialog).getByRole('button', { name: 'Retry' });
    await waitFor(() => expect(document.activeElement).toBe(retry));
    fireEvent.click(retry);
    expect(exportLife).toHaveBeenLastCalledWith('agent_p', { plan: false, to: '~/Desktop/luna-2.soul-life.tar.gz' });
    expect((await screen.findByText(/Not exported: agent_p is running/)).textContent).toBe('Not exported: agent_p is running (a turn in flight or a warm harness); stop it before exporting its life');
    expect(screen.getByText('agent-bot soul stop agent_p', { selector: 'code' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /stop/i })).toBeNull();
    expect(exportLife.mock.calls.map(([, o]) => o.plan)).toEqual([true, false, false]);
  });

  it('while agent-bot asks for approval shows the gate line, no Cancel, and ignores Escape', async () => {
    let finish: (value: typeof sampleLifeExport) => void = () => {};
    const exportLife = vi.fn<(agentId: string, options: { plan: boolean; to: string | null }) => Promise<typeof sampleLifeExport>>()
      .mockResolvedValueOnce(sampleLifeExport)
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    show(source({ exportLife }));
    await openExport();
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and export' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Exporting… agent-bot asks for your approval (Touch ID or your login password).').getAttribute('aria-live')).toBe('polite');
    expect(within(dialog).queryByRole('button', { name: 'Cancel' })).toBeNull();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    await act(async () => { finish({ ...sampleLifeExport, applied: true, decision: 'exported', file: '/x.tgz' }); });
    await screen.findByText('Done. agent-bot wrote /x.tgz (17 files, 196 KB).');
  });
});

describe("importing a soul's life (#268, agent-bot-identity #583 slice 7)", () => {
  const archive = '/Users/user/Desktop/luna.soul-life.tar.gz';
  const openImport = async () => {
    const trigger = await screen.findByRole('button', { name: 'Import life…' });
    fireEvent.click(trigger);
    return trigger;
  };
  const readArchive = async (path = archive) => {
    const field = await screen.findByLabelText('Archive');
    fireEvent.change(field, { target: { value: path } });
    fireEvent.click(screen.getByRole('button', { name: 'Read archive' }));
  };

  it('asks for the archive first, reads its plan, keeps an unknown ID as a moved life, restores nothing until confirmed, then reports the root', async () => {
    const s = source();
    show(s);
    const trigger = await openImport();
    const dialog = screen.getByRole('dialog', { name: 'Import a life?' });
    expect(s.importLife).not.toHaveBeenCalled();
    expect((within(dialog).getByRole('button', { name: 'Read archive' }) as HTMLButtonElement).disabled).toBe(true);
    await readArchive();
    expect(s.importLife).toHaveBeenCalledWith(archive, { plan: true, identity: 'keep', name: null });
    expect(await within(dialog).findByText('agent-bot will restore this life. Nothing starts until you confirm.')).toBeTruthy();
    expect(within(dialog).getByText('Keeps its Agent ID agent_p: a moved life.')).toBeTruthy();
    expect(within(dialog).getByText('Destination:', { exact: false }).closest('p')?.textContent).toBe('Destination: /Users/user/Souls/luna.soul');
    expect(within(dialog).getByText('Would restore')).toBeTruthy();
    expect(within(dialog).getByText('17 files (196 KB)')).toBeTruthy();
    expect(within(dialog).getByText('history · 2 files (130 KB)')).toBeTruthy();
    expect(within(dialog).getByText('Links recorded, not recreated')).toBeTruthy();
    expect(within(dialog).getByText('.soul-state/space → /Users/user/space/luna')).toBeTruthy();
    expect(within(dialog).getByText('Workspaces to link again')).toBeTruthy();
    expect(within(dialog).getByText('site → /Users/user/code/site')).toBeTruthy();
    expect(within(dialog).getByText('Check the repository out, link it, apply the patch and copy the untracked files from .soul-state/imports/site.')).toBeTruthy();
    // An unknown ID offers no choice and no name.
    expect(within(dialog).queryByRole('radio')).toBeNull();
    expect(within(dialog).queryByLabelText('Display name')).toBeNull();
    expect(s.importLife).toHaveBeenCalledTimes(1);
    const confirm = within(dialog).getByRole('button', { name: 'Confirm and import' });
    await waitFor(() => expect(document.activeElement).toBe(confirm));
    fireEvent.click(confirm);
    expect(s.importLife).toHaveBeenLastCalledWith(archive, { plan: false, identity: 'keep', name: null });
    const status = await screen.findByText('Done. agent-bot restored Luna at /Users/user/Souls/luna.soul (17 files, 196 KB).');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(within(dialog).getByText('Agent ID: agent_p')).toBeTruthy();
    expect(within(dialog).getByText('Revision journal: restored from the archive.')).toBeTruthy();
    expect(within(dialog).queryByText(/moved aside/)).toBeNull();
    expect(dialog.textContent).not.toMatch(/\blost\b|roll(ed)? back/i);
    // The descriptor is read again afterwards.
    await waitFor(() => expect(s.environment).toHaveBeenCalledTimes(2));
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' }).at(-1)!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("turns the engine's import-id-active into the replace-or-fork choice, re-plans on each, says the previous root is moved aside, and names a fork", async () => {
    const existing = { status: 'active', soulDir: '/Users/user/Souls/Luna.soul' };
    const importLife = vi.fn(async (path: string, { plan, identity, name }: { plan: boolean; identity: ImportIdentity; name: string | null }): Promise<SoulEnvironmentImport> => {
      if (identity === 'keep') throw new BridgeError('import-id-active', 'agent_p is an active soul here (/Users/user/Souls/Luna.soul)', 'add --replace to overwrite its life, or --fork to import as a new soul');
      const base = { ...sampleLifeImport, archive: path, displayName: name ?? 'Luna' };
      if (identity === 'fork') {
        const planned = { ...base, identity: { decision: 'fork', agentId: null, importedFrom: 'agent_p', existing }, soulDir: '/Users/user/Souls/luna-<agent id tail>.soul', name: null };
        return plan ? planned : { ...planned, applied: true, decision: 'forked', identity: { ...planned.identity, agentId: 'agent_f' }, soulDir: '/Users/user/Souls/luna-6e3a9c1d.soul', journal: 'adopted' };
      }
      const planned = { ...base, identity: { decision: 'replace', agentId: 'agent_p', importedFrom: 'agent_p', existing }, soulDir: existing.soulDir, replaced: existing.soulDir };
      return plan ? planned : { ...planned, applied: true, decision: 'replaced', replaced: `${existing.soulDir}.replaced-2026-10-08T10-00-00-000Z`, journal: 'kept-local' };
    });
    const s = source({ importLife });
    show(s);
    await openImport();
    await readArchive();
    const dialog = screen.getByRole('dialog');
    // The engine's message as it came, then the choice; no Retry: the choice is the answer.
    expect(await within(dialog).findByText('agent_p is an active soul here (/Users/user/Souls/Luna.soul)')).toBeTruthy();
    expect(within(dialog).getByText('This Agent ID is already here')).toBeTruthy();
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Confirm and import' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Replace the soul here' }));
    expect(importLife).toHaveBeenLastCalledWith(archive, { plan: true, identity: 'replace', name: null });
    expect(await within(dialog).findByText('Replaces the soul here (/Users/user/Souls/Luna.soul). Its current folder is moved aside, not deleted.')).toBeTruthy();
    expect((within(dialog).getByRole('radio', { name: 'Replace the soul here' }) as HTMLInputElement).checked).toBe(true);
    expect(within(dialog).queryByLabelText('Display name')).toBeNull();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Import as a new soul (fork)' }));
    expect(importLife).toHaveBeenLastCalledWith(archive, { plan: true, identity: 'fork', name: null });
    expect(await within(dialog).findByText('Imports as a new soul: agent-bot mints a new Agent ID when it applies (from agent_p).')).toBeTruthy();
    expect(within(dialog).getByText('Destination:', { exact: false }).closest('p')?.textContent).toBe('Destination: /Users/user/Souls/luna-<agent id tail>.soul');
    fireEvent.change(within(dialog).getByLabelText('Display name'), { target: { value: 'Luna II' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm and import' }));
    expect(importLife).toHaveBeenLastCalledWith(archive, { plan: false, identity: 'fork', name: 'Luna II' });
    await screen.findByText('Done. agent-bot restored Luna II at /Users/user/Souls/luna-6e3a9c1d.soul (17 files, 196 KB).');
    expect(within(dialog).getByText('Agent ID: agent_f')).toBeTruthy();
    expect(within(dialog).getByText('Revision journal: a new chain starts from the restored package.')).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/\blost\b|roll(ed)? back/i);
    cleanup();

    // A replace, applied: the previous root is moved aside, never deleted, and the local journal kept.
    show(source({ importLife }));
    await openImport();
    await readArchive();
    fireEvent.click(await screen.findByRole('radio', { name: 'Replace the soul here' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and import' }));
    expect(importLife).toHaveBeenLastCalledWith(archive, { plan: false, identity: 'replace', name: null });
    await screen.findByText('Done. agent-bot restored Luna at /Users/user/Souls/Luna.soul (17 files, 196 KB).');
    expect(screen.getByText('The previous folder was moved aside, not deleted: /Users/user/Souls/Luna.soul.replaced-2026-10-08T10-00-00-000Z')).toBeTruthy();
    expect(screen.getByText('Revision journal: the local chain is kept.')).toBeTruthy();
  });

  it('offers fork only for a retired ID', async () => {
    const importLife = vi.fn(async (path: string, { plan, identity }: { plan: boolean; identity: ImportIdentity; name: string | null }): Promise<SoulEnvironmentImport> => {
      if (identity !== 'fork') throw new BridgeError('import-id-retired', 'agent_p is retired here; a retired soul never comes back under its ID', 'add --fork to import it as a new soul');
      const planned = { ...sampleLifeImport, archive: path, identity: { decision: 'fork', agentId: null, importedFrom: 'agent_p', existing: { status: 'retired', soulDir: null } }, soulDir: '/Users/user/Souls/luna.soul', name: null };
      return plan ? planned : { ...planned, applied: true, decision: 'forked', identity: { ...planned.identity, agentId: 'agent_f' }, journal: 'adopted' };
    });
    show(source({ importLife }));
    await openImport();
    await readArchive();
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByText('agent_p is retired here; a retired soul never comes back under its ID')).toBeTruthy();
    expect(within(dialog).getByRole('radio', { name: 'Import as a new soul (fork)' })).toBeTruthy();
    expect(within(dialog).queryByRole('radio', { name: 'Replace the soul here' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Import as a new soul (fork)' }));
    expect(importLife).toHaveBeenLastCalledWith(archive, { plan: true, identity: 'fork', name: null });
    await within(dialog).findByText('Imports as a new soul: agent-bot mints a new Agent ID when it applies (from agent_p).');
    // Still fork only: the engine says the ID is a tombstone.
    expect(within(dialog).queryByRole('radio', { name: 'Replace the soul here' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Confirm and import' })).toBeTruthy();
  });

  it("shows the archive's own refusal with Retry and the field, and a soul-running refusal on apply with its command as text", async () => {
    const importLife = vi.fn<(archive: string, options: { plan: boolean; identity: ImportIdentity; name: string | null }) => Promise<SoulEnvironmentImport>>()
      .mockRejectedValueOnce(new BridgeError('import-checksum-mismatch', 'life/soul.json does not match the manifest'))
      .mockResolvedValueOnce(sampleLifeImport)
      .mockRejectedValueOnce(new BridgeError('soul-running', 'agent_p is running (a turn in flight or a warm harness); stop it before replacing its life', 'agent-bot soul stop agent_p'));
    show(source({ importLife }));
    await openImport();
    await readArchive('/Users/user/Desktop/broken.tar.gz');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Not imported: life/soul.json does not match the manifest');
    const dialog = screen.getByRole('dialog');
    const retry = within(dialog).getByRole('button', { name: 'Retry' });
    await waitFor(() => expect(document.activeElement).toBe(retry));
    // The field stays: another archive can be named and read.
    fireEvent.change(within(dialog).getByLabelText('Archive'), { target: { value: archive } });
    fireEvent.click(retry);
    expect(importLife).toHaveBeenLastCalledWith(archive, { plan: true, identity: 'keep', name: null });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Confirm and import' }));
    expect((await screen.findByText(/Not imported: agent_p is running/)).textContent).toBe('Not imported: agent_p is running (a turn in flight or a warm harness); stop it before replacing its life');
    expect(screen.getByText('agent-bot soul stop agent_p', { selector: 'code' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /stop/i })).toBeNull();
    expect(importLife.mock.calls.map(([, o]) => o.plan)).toEqual([true, true, false]);
  });
});

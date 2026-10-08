import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeError, type EnvironmentMigration, type RuntimeInstall, type SoulEnvironment } from '../bridge';
import { sampleCensus, sampleEnvironments } from '../model/fixtures';
import { EnvironmentSection, EnvironmentSourceContext, type EnvironmentSource } from './EnvironmentSection';

afterEach(cleanup);

const [luna] = sampleCensus;
const scout = { ...luna, agentId: 'agent_s', name: 'scout', harness: 'claude' };
const env = sampleEnvironments.agent_p;
const older = sampleEnvironments.agent_s;

const report = (overrides: Partial<RuntimeInstall> = {}): RuntimeInstall => ({ agentId: 'agent_p', ready: true, installed: ['node'], skipped: [], runtimes: [], harnesses: [], ...overrides });

function source(overrides: Partial<EnvironmentSource> = {}): EnvironmentSource {
  return {
    environment: vi.fn(async () => env),
    installRuntime: vi.fn(async () => report()),
    migrate: vi.fn(async (agentId: string, kind: string): Promise<EnvironmentMigration> => ({ agentId, operation: kind, decision: kind === 'space-into-soul' ? 'migrated' : 'adopted', steps: [] })),
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

  it('keeps export, import and cache clean-up visible but disabled with the gated copy', async () => {
    show(source());
    await screen.findByText('Components');
    for (const name of ['Export', 'Import', 'Clean up cache']) {
      const button = screen.getByRole('button', { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    }
    expect(screen.getByText("Export, import and cache clean-up aren't available yet.")).toBeTruthy();
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

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../lib/i18n';
import type { CensusRow } from '../model/census';
import { BridgeError, type SoulEnvironment, type SoulMode, type SoulTemplateList } from '../bridge';
import { sampleCensus, sampleTemplates } from '../model/fixtures';
import type { LaunchState } from '../model/launch';
import type { LaunchApi } from '../useLaunch';
import { LaunchForm } from './LaunchForm';
import { SoulSourceContext, type SoulSource } from './SoulNotices';

afterEach(cleanup);

const launcherIn = (state: LaunchState): LaunchApi => ({ state, launch: vi.fn(async () => {}), reset: vi.fn() });

function form(launcher: LaunchApi, extra: Partial<Parameters<typeof LaunchForm>[0]> = {}) {
  return (
    <I18nProvider>
      <LaunchForm launcher={launcher} accounts={['user']} harnesses={['claude']} defaultHarness="claude" onCancel={() => {}} {...extra} />
    </I18nProvider>
  );
}

function soulSource(signIn: SoulSource['signIn'] = async () => true): SoulSource {
  return {
    population: async () => null,
    coldWake: async () => null,
    setColdWake: async () => ({ on: false, lane: null }),
    signedIn: async () => null,
    signIn,
    mode: async () => null,
    setMode: async (_id: string, mode: SoulMode) => mode,
    model: async () => null,
    setModel: async () => { throw new Error('unused'); },
  };
}
const launchButton = () => screen.getByRole('button', { name: 'Launch' }) as HTMLButtonElement;

describe('LaunchForm progress stages (agent-bot-identity#536)', () => {
  it('moves the progress list with the daemon\'s stage and shows the stage next to the request id', () => {
    const idle = launcherIn({ phase: 'idle' });
    const { rerender } = render(form(idle, { initialPackagePath: '/souls/helper.soul' }));
    fireEvent.submit(screen.getByRole('form'));
    rerender(form({ ...idle, state: { phase: 'pending', requestId: 'r1', note: null, stage: 'account' } }, { initialPackagePath: '/souls/helper.soul' }));
    let items = within(screen.getByRole('list', { name: 'Launch progress' })).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(['Request sentdone', 'Daemon starting itin progress', 'Joined']);
    expect(screen.getByText('· account')).toBeTruthy();
    rerender(form({ ...idle, state: { phase: 'pending', requestId: 'r1', note: null, stage: 'joining' } }, { initialPackagePath: '/souls/helper.soul' }));
    items = within(screen.getByRole('list', { name: 'Launch progress' })).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(['Request sentdone', 'Daemon starting itdone', 'Joinedin progress']);
    expect(screen.getByText('· joining')).toBeTruthy();
  });
});

describe('LaunchForm after a launch (#116)', () => {
  it('reports the launched agent once and never arms Launch again in the dialog', () => {
    const onLaunched = vi.fn();
    const idle = launcherIn({ phase: 'idle' });
    const { rerender } = render(form(idle, { initialPackagePath: '/souls/helper.soul', onLaunched }));
    fireEvent.submit(screen.getByRole('form'));
    expect(idle.launch).toHaveBeenCalledOnce();
    rerender(form({ ...idle, state: { phase: 'pending', requestId: 'r1', note: null, stage: null } }, { initialPackagePath: '/souls/helper.soul', onLaunched }));
    // While it runs, the design shows only the progress: no Launch to press again.
    expect(screen.queryByRole('button', { name: 'Launch' })).toBeNull();
    expect(screen.getByRole('list', { name: 'Launch progress' }).textContent).toContain('Daemon starting it');
    expect(onLaunched).not.toHaveBeenCalled();
    const done = { ...idle, state: { phase: 'launched', requestId: 'r1', agentId: 'agent_new' } as LaunchState };
    rerender(form(done, { initialPackagePath: '/souls/helper.soul', onLaunched }));
    rerender(form({ ...done }, { initialPackagePath: '/souls/helper.soul', onLaunched }));
    expect(onLaunched).toHaveBeenCalledOnce();
    expect(onLaunched).toHaveBeenCalledWith('agent_new');
    expect(launchButton().disabled).toBe(true);
    fireEvent.submit(screen.getByRole('form'));
    expect(idle.launch).toHaveBeenCalledOnce();
  });

  it('does not report a launch it did not start', () => {
    const onLaunched = vi.fn();
    render(form(launcherIn({ phase: 'launched', requestId: 'r0', agentId: 'agent_old' }), { onLaunched }));
    expect(onLaunched).not.toHaveBeenCalled();
    expect(launchButton().disabled).toBe(false);
  });
});

describe('LaunchForm package path (#116)', () => {
  it('drops the trailing slash Finder gives an opened .soul', () => {
    const launcher = launcherIn({ phase: 'idle' });
    render(form(launcher, { initialPackagePath: '/Users/admin/Desktop/VMShare.soul/' }));
    expect((screen.getByLabelText('Path to soul, ending with .soul') as HTMLInputElement).value).toBe('/Users/admin/Desktop/VMShare.soul');
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ target: { package: '/Users/admin/Desktop/VMShare.soul' } }));
  });

  it('drops a pasted trailing slash when the field is left or the form is sent', () => {
    const launcher = launcherIn({ phase: 'idle' });
    render(form(launcher));
    const path = screen.getByLabelText('Path to soul, ending with .soul') as HTMLInputElement;
    fireEvent.change(path, { target: { value: '/souls/a.soul//' } });
    // Typing a folder path keeps its slash until the field is left.
    expect(path.value).toBe('/souls/a.soul//');
    fireEvent.blur(path);
    expect(path.value).toBe('/souls/a.soul');
    fireEvent.change(path, { target: { value: '/souls/b.soul/' } });
    fireEvent.submit(screen.getByRole('form'));
    expect(path.value).toBe('/souls/b.soul');
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ target: { package: '/souls/b.soul' } }));
  });
});

describe('LaunchForm role (agent-bot-identity#535)', () => {
  it('sends a typed role, trimmed, with a package launch and nothing when blank', () => {
    const launcher = launcherIn({ phase: 'idle' });
    render(form(launcher, { initialPackagePath: '/souls/helper.soul' }));
    const role = screen.getByLabelText('What should it help with?') as HTMLInputElement;
    expect(role.maxLength).toBe(60);
    fireEvent.submit(screen.getByRole('form'));
    expect(Object.hasOwn(vi.mocked(launcher.launch).mock.calls[0][0], 'role')).toBe(false);
    fireEvent.change(role, { target: { value: '  Researcher ' } });
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).toHaveBeenLastCalledWith(expect.objectContaining({ target: { package: '/souls/helper.soul' }, role: 'Researcher' }));
  });
});

const starter: CensusRow = { account: 'user', agentId: 'agent_s', name: 'Genius', harness: 'claude', parent: null, presence: 'left', unacked: 0, lastWake: null };

describe('LaunchForm relaunching an existing companion (#79)', () => {
  it('has no Name field and sends no name', () => {
    const launcher = launcherIn({ phase: 'idle' });
    render(form(launcher, { soul: starter }));
    expect(screen.queryByText('Name')).toBeNull();
    expect(screen.queryByPlaceholderText('Optional')).toBeNull();
    expect(screen.queryByLabelText('What should it help with?')).toBeNull();
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ target: { soul: 'agent_s' }, name: '' }));
    expect(Object.hasOwn(vi.mocked(launcher.launch).mock.calls[0][0], 'role')).toBe(false);
  });

  it('ignores a package name and harness preference for an existing soul', () => {
    const launcher = launcherIn({ phase: 'idle' });
    render(form(launcher, { soul: starter, packageName: 'Scott - Starter', preferredHarnesses: ['opencode'] }));
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ name: '', harness: 'claude' }));
  });
});

describe('LaunchForm pre-launch harness sign-in recovery (#338)', () => {
  it.each([
    ['structured code', { code: 'harness-signed-out', detail: 'harness-signed-out: codex is signed out for this soul; sign in and launch again' }],
    ['legacy detail prefix', { detail: 'harness-signed-out: codex is signed out for this soul; sign in and launch again' }],
  ])('offers the existing sign-in recovery for an existing soul with %s and leaves retry explicit', async (_label, failure) => {
    const initial = launcherIn({ phase: 'idle' });
    const signIn = vi.fn(async () => true);
    const source = soulSource(signIn);
    const extra = { soul: starter, harnesses: ['claude', 'codex', 'opencode'] };
    const { rerender } = render(<SoulSourceContext.Provider value={source}>{form(initial, extra)}</SoulSourceContext.Provider>);
    const harness = screen.getByLabelText('Harness') as HTMLInputElement;
    fireEvent.change(harness, { target: { value: 'codex' } });
    fireEvent.submit(screen.getByRole('form'));
    expect(initial.launch).toHaveBeenCalledWith(expect.objectContaining({ harness: 'codex', target: { soul: starter.agentId } }));

    const refused = launcherIn({ phase: 'failed', requestId: 'r1', agentId: null, ...failure });
    rerender(<SoulSourceContext.Provider value={source}>{form(refused, extra)}</SoulSourceContext.Provider>);
    const editableHarness = screen.getByLabelText('Harness') as HTMLSelectElement;
    fireEvent.change(editableHarness, { target: { value: 'opencode' } });
    expect(screen.getByText(/harness-signed-out: codex is signed out for this soul; sign in and launch again/)).toBeTruthy();
    expect(screen.getByText('codex is signed out')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    await screen.findByText('Signed in');
    expect(signIn).toHaveBeenCalledWith('codex', starter.agentId);
    expect(refused.launch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    expect(refused.launch).toHaveBeenCalledOnce();
    expect(refused.launch).toHaveBeenCalledWith(expect.objectContaining({ harness: 'opencode', target: { soul: starter.agentId } }));
  });

  it('does not offer sign-in for unknown probes or generic launch failures', () => {
    for (const failure of [
      { code: 'harness-unknown', detail: 'harness-unknown: status failed' },
      { detail: 'could not join the soul' },
      { code: 'other', detail: 'harness-signed-out: conflicting legacy detail' },
    ]) {
      cleanup();
      const launcher = launcherIn({ phase: 'failed', requestId: 'r1', agentId: null, ...failure });
      render(form(launcher, { soul: starter }));
      fireEvent.submit(screen.getByRole('form'));
      expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull();
    }

    cleanup();
    const launcher = launcherIn({ phase: 'failed', requestId: 'r1', agentId: null,
      code: 'harness-signed-out', detail: 'harness-signed-out: new souls are not refused' });
    render(form(launcher, { initialPackagePath: '/souls/new.soul' }));
    fireEvent.submit(screen.getByRole('form'));
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull();
  });

  it('keeps a cancelled or failed sign-in visible and retryable without relaunching', async () => {
    const attempts: { signIn: SoulSource['signIn']; message: string }[] = [
      { signIn: vi.fn(async () => false), message: 'Signed out' },
      { signIn: vi.fn(async () => { throw new Error('browser sign-in was cancelled'); }), message: 'browser sign-in was cancelled' },
    ];
    for (const { signIn, message } of attempts) {
      cleanup();
      const source = soulSource(signIn);
      const initial = launcherIn({ phase: 'idle' });
      const { rerender } = render(<SoulSourceContext.Provider value={source}>{form(initial, { soul: starter })}</SoulSourceContext.Provider>);
      fireEvent.submit(screen.getByRole('form'));
      expect(initial.launch).toHaveBeenCalledOnce();
      const launcher = launcherIn({ phase: 'failed', requestId: 'r1', agentId: null, code: 'harness-signed-out',
        detail: 'harness-signed-out: claude is signed out' });
      rerender(<SoulSourceContext.Provider value={source}>{form(launcher, { soul: starter })}</SoulSourceContext.Provider>);
      fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
      await screen.findByText(`Sign-in did not finish: ${message}`);
      expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy();
      expect(launcher.launch).not.toHaveBeenCalled();
    }
  });

  it('keeps a later refusal visible when sign-in from an earlier attempt completes late', async () => {
    let finish: (loggedIn: boolean) => void = () => {};
    const signIn = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const source = soulSource(signIn);
    const extra = { soul: starter, harnesses: ['claude', 'codex', 'opencode'] };
    const initial = launcherIn({ phase: 'idle' });
    const { rerender } = render(<SoulSourceContext.Provider value={source}>{form(initial, extra)}</SoulSourceContext.Provider>);
    fireEvent.change(screen.getByLabelText('Harness'), { target: { value: 'codex' } });
    fireEvent.submit(screen.getByRole('form'));
    const firstFailure = launcherIn({ phase: 'failed', requestId: 'r1', agentId: null, code: 'harness-signed-out',
      detail: 'harness-signed-out: codex is signed out' });
    rerender(<SoulSourceContext.Provider value={source}>{form(firstFailure, extra)}</SoulSourceContext.Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect((screen.getByRole('button', { name: 'Opening codex sign-in…' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Harness'), { target: { value: 'opencode' } });
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    expect(firstFailure.launch).toHaveBeenCalledWith(expect.objectContaining({ harness: 'opencode' }));
    rerender(<SoulSourceContext.Provider value={source}>{form(launcherIn({ phase: 'pending', requestId: 'r2', note: null, stage: null }), extra)}</SoulSourceContext.Provider>);
    rerender(<SoulSourceContext.Provider value={source}>{form(launcherIn({ phase: 'failed', requestId: 'r2', agentId: null,
      code: 'harness-signed-out', detail: 'harness-signed-out: opencode is signed out' }), extra)}</SoulSourceContext.Provider>);

    finish(true);
    expect(await screen.findByRole('button', { name: 'Sign in again' })).toBeTruthy();
    expect(screen.queryByText('Signed in')).toBeNull();
    expect(signIn).toHaveBeenCalledWith('codex', starter.agentId);
  });
});

describe('LaunchForm for a copied soul folder (#110)', () => {
  const copyOf = { name: 'luna', agentId: 'agent_p' };
  it('requires a name before Launch and explains the copy', () => {
    const launcher = launcherIn({ phase: 'idle' });
    render(form(launcher, { initialPackagePath: '/souls/luna copy.soul', copyOf }));
    expect(screen.getByText(/new companion copied from luna/)).toBeTruthy();
    const name = screen.getByPlaceholderText('Required') as HTMLInputElement;
    expect(name.value).toBe('');
    expect(launchButton().disabled).toBe(true);
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: '   ' } });
    expect(launchButton().disabled).toBe(true);
    fireEvent.change(name, { target: { value: 'Nova' } });
    expect(launchButton().disabled).toBe(false);
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ target: { package: '/souls/luna copy.soul' }, name: 'Nova' }));
  });

  it('falls back to the original agent id when it has no name', () => {
    render(form(launcherIn({ phase: 'idle' }), { initialPackagePath: '/souls/x.soul', copyOf: { name: null, agentId: 'agent_x' } }));
    expect(screen.getByText(/copied from agent_x/)).toBeTruthy();
  });
});

describe('LaunchForm prefill from an opened package (#120)', () => {
  it('prefers the package harness over the default and shows its description', () => {
    const launcher = launcherIn({ phase: 'idle' });
    render(form(launcher, { initialPackagePath: '/souls/helper.soul', packageName: 'Helper - Starter', preferredHarnesses: ['opencode'],
      packageDescription: 'Answers questions about this Mac.' }));
    expect(screen.getByText('Answers questions about this Mac.')).toBeTruthy();
    expect((screen.getByLabelText('Harness') as HTMLSelectElement).value).toBe('opencode');
    expect((screen.getByPlaceholderText('Optional') as HTMLInputElement).value).toBe('Helper');
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ harness: 'opencode', name: 'Helper' }));
  });

  it('switches to the package harness when its manifest arrives late, unless the owner picked one', () => {
    const launcher = launcherIn({ phase: 'idle' });
    const { rerender } = render(form(launcher, { initialPackagePath: '/souls/helper.soul', checkingPackage: true }));
    expect((screen.getByLabelText('Harness') as HTMLSelectElement).value).toBe('claude');
    rerender(form(launcher, { initialPackagePath: '/souls/helper.soul', preferredHarnesses: ['opencode'] }));
    expect((screen.getByLabelText('Harness') as HTMLSelectElement).value).toBe('opencode');
  });

  it('keeps the default harness when the package prefers none the app offers', () => {
    render(form(launcherIn({ phase: 'idle' }), { initialPackagePath: '/souls/helper.soul', preferredHarnesses: ['nonesuch'] }));
    expect((screen.getByLabelText('Harness') as HTMLSelectElement).value).toBe('claude');
  });
});

describe('LaunchForm soul templates (#65)', () => {
  const listed = async () => sampleTemplates;
  const radios = () => screen.getAllByRole('radio') as HTMLButtonElement[];
  const checked = () => radios().find((r) => r.getAttribute('aria-checked') === 'true')?.textContent;
  const picker = async () => screen.findByRole('radiogroup', { name: 'Soul' });

  it('offers each template, then "Custom soul", with the first chosen', async () => {
    render(form(launcherIn({ phase: 'idle' }), { harnesses: ['claude', 'opencode'], listTemplates: listed }));
    await picker();
    expect(radios().map((r) => r.textContent)).toEqual(['Coder', 'Researcher', 'Genius', 'Custom soul']);
    expect(checked()).toBe('Coder');
    expect(screen.getByText('Writes and reviews code in your repositories.')).toBeTruthy();
    expect(screen.queryByLabelText('Path to soul, ending with .soul')).toBeNull();
  });

  it('launches the chosen template\'s package with its default harness', async () => {
    const launcher = launcherIn({ phase: 'idle' });
    render(form(launcher, { harnesses: ['claude'], listTemplates: listed }));
    await picker();
    fireEvent.click(screen.getByRole('radio', { name: 'Researcher' }));
    expect(screen.getByText('Reads the web and your files, then reports back.')).toBeTruthy();
    expect((screen.getByLabelText('Harness') as HTMLSelectElement).value).toBe('opencode');
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ target: { package: '/Users/user/Souls/Researcher.soul' }, harness: 'opencode' }));
  });

  it('keeps the owner\'s harness and falls back to the default for a template with none', async () => {
    const launcher = launcherIn({ phase: 'idle' });
    render(form(launcher, { harnesses: ['claude', 'opencode'], listTemplates: listed }));
    await picker();
    fireEvent.click(screen.getByRole('radio', { name: 'Genius' }));
    expect((screen.getByLabelText('Harness') as HTMLSelectElement).value).toBe('claude');
    fireEvent.change(screen.getByLabelText('Harness'), { target: { value: 'muse' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Researcher' }));
    expect((screen.getByLabelText('Harness') as HTMLSelectElement).value).toBe('muse');
  });

  it('labels Name and Role as the design (Role: "What should it help with?", X4) and names the role after the chosen soul (LA2)', async () => {
    render(form(launcherIn({ phase: 'idle' }), { listTemplates: listed }));
    await picker();
    for (const label of ['Name', 'What should it help with?']) {
      const el = screen.getByText(label, { selector: 'label' });
      expect(el.className).toContain('text-sm font-medium leading-none');
      expect(screen.getByLabelText(label).id).toBe(el.getAttribute('for'));
    }
    expect(screen.getByLabelText('Name').getAttribute('placeholder')).toBe('Optional');
    expect(screen.getByLabelText('What should it help with?').getAttribute('placeholder')).toBe('Coder');
    fireEvent.click(screen.getByRole('radio', { name: 'Researcher' }));
    expect(screen.getByLabelText('What should it help with?').getAttribute('placeholder')).toBe('Researcher');
    fireEvent.click(screen.getByRole('radio', { name: 'Custom soul' }));
    expect(screen.getByLabelText('What should it help with?').getAttribute('placeholder')).toBe('Optional, e.g. Researcher');
  });

  it('"Custom soul" shows the package path field and launches the typed path', async () => {
    const launcher = launcherIn({ phase: 'idle' });
    render(form(launcher, { listTemplates: listed }));
    await picker();
    fireEvent.click(screen.getByRole('radio', { name: 'Custom soul' }));
    const path = screen.getByLabelText('Path to soul, ending with .soul') as HTMLInputElement;
    expect(path.value).toBe('');
    fireEvent.change(path, { target: { value: '/souls/mine.soul/' } });
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ target: { package: '/souls/mine.soul' } }));
  });

  it('starts on "Custom soul" for a package opened from Finder', async () => {
    const launcher = launcherIn({ phase: 'idle' });
    render(form(launcher, { initialPackagePath: '/souls/helper.soul', packageDescription: 'Answers questions.', listTemplates: listed }));
    await picker();
    expect(checked()).toBe('Custom soul');
    expect((screen.getByLabelText('Path to soul, ending with .soul') as HTMLInputElement).value).toBe('/souls/helper.soul');
    expect(screen.getByText('Answers questions.')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Coder' }));
    expect(screen.queryByText('Answers questions.')).toBeNull();
  });

  it('moves the selection with the arrow keys', async () => {
    render(form(launcherIn({ phase: 'idle' }), { listTemplates: listed }));
    const group = await picker();
    screen.getByRole('radio', { name: 'Coder' }).focus();
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(checked()).toBe('Researcher');
    expect(document.activeElement?.textContent).toBe('Researcher');
    fireEvent.keyDown(group, { key: 'End' });
    expect(checked()).toBe('Custom soul');
    fireEvent.keyDown(group, { key: 'ArrowDown' });
    expect(checked()).toBe('Coder');
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(checked()).toBe('Custom soul');
    expect(screen.getByLabelText('Path to soul, ending with .soul')).toBeTruthy();
  });

  it('notes templates agent-bot could not read', async () => {
    const lister = async () => ({ ...sampleTemplates, errors: [{ package: '/souls/Bad.soul', message: 'soul.json is missing' }] });
    render(form(launcherIn({ phase: 'idle' }), { listTemplates: lister }));
    await picker();
    expect(screen.getByText('Some soul templates could not be read.').getAttribute('title')).toBe('/souls/Bad.soul: soul.json is missing');
  });

  it('keeps today\'s form on an agent-bot without soul templates, or with none listed', async () => {
    for (const lister of [
      vi.fn(async (): Promise<SoulTemplateList> => { throw new BridgeError('soul-templates-unsupported', 'no soul templates'); }),
      vi.fn(async (): Promise<SoulTemplateList> => ({ templates: [], soulsRoot: '/souls', errors: [] })),
    ]) {
      const launcher = launcherIn({ phase: 'idle' });
      render(form(launcher, { listTemplates: lister }));
      await waitFor(() => expect(lister).toHaveBeenCalled());
      await Promise.resolve();
      expect(screen.queryByRole('radiogroup')).toBeNull();
      fireEvent.change(screen.getByLabelText('Path to soul, ending with .soul'), { target: { value: '/souls/a.soul' } });
      fireEvent.submit(screen.getByRole('form'));
      expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ target: { package: '/souls/a.soul' } }));
      cleanup();
    }
  });

  it('never lists templates to relaunch an existing companion', () => {
    const lister = vi.fn(listed);
    render(form(launcherIn({ phase: 'idle' }), { soul: starter, listTemplates: lister }));
    expect(lister).not.toHaveBeenCalled();
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });
});

describe('LaunchForm brief (#120)', () => {
  const briefField = () => screen.getByLabelText('Brief') as HTMLTextAreaElement;

  it('sends no brief when the field is blank', () => {
    const launcher = launcherIn({ phase: 'idle' });
    render(form(launcher, { initialPackagePath: '/souls/helper.soul' }));
    fireEvent.change(briefField(), { target: { value: '   ' } });
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).toHaveBeenCalledOnce();
    expect(vi.mocked(launcher.launch).mock.calls[0][0]).not.toHaveProperty('brief');
  });

  it('sends a typed brief for a package and counts it against 4000', () => {
    const launcher = launcherIn({ phase: 'idle' });
    render(form(launcher, { initialPackagePath: '/souls/helper.soul' }));
    fireEvent.change(briefField(), { target: { value: '  Keep the notes.\nFlag gaps.  ' } });
    expect(screen.getByText('26 / 4000')).toBeTruthy();
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ brief: '  Keep the notes.\nFlag gaps.  ' }));
  });

  it('refuses 4001 characters inline and keeps Launch off', () => {
    const launcher = launcherIn({ phase: 'idle' });
    render(form(launcher, { initialPackagePath: '/souls/helper.soul' }));
    fireEvent.change(briefField(), { target: { value: 'x'.repeat(4001) } });
    expect(screen.getByRole('alert').textContent).toBe('The brief is longer than 4000 characters.');
    expect(briefField().getAttribute('aria-invalid')).toBe('true');
    expect(launchButton().disabled).toBe(true);
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).not.toHaveBeenCalled();
    fireEvent.change(briefField(), { target: { value: 'x'.repeat(4000) } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(launchButton().disabled).toBe(false);
  });

  const keepHint = 'What this companion is here to do. Leave blank to keep its current brief.';

  it('prefills the saved brief on relaunch and sends none when it is kept', async () => {
    const launcher = launcherIn({ phase: 'idle' });
    const loadBrief = vi.fn(async () => 'Review open PRs');
    render(form(launcher, { soul: starter, loadBrief }));
    await waitFor(() => expect(briefField().value).toBe('Review open PRs'));
    expect(loadBrief).toHaveBeenCalledWith('agent_s');
    expect(briefField().disabled).toBe(false);
    expect(screen.getByText(keepHint)).toBeTruthy();
    fireEvent.submit(screen.getByRole('form'));
    // Unchanged, the saved brief stays as agent-bot has it.
    expect(vi.mocked(launcher.launch).mock.calls[0][0]).not.toHaveProperty('brief');
  });

  it('sends an edited brief on relaunch', async () => {
    const launcher = launcherIn({ phase: 'idle' });
    render(form(launcher, { soul: starter, loadBrief: async () => 'Review open PRs' }));
    await waitFor(() => expect(briefField().value).toBe('Review open PRs'));
    fireEvent.change(briefField(), { target: { value: 'Review open PRs and close stale ones' } });
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ target: { soul: 'agent_s' }, brief: 'Review open PRs and close stale ones' }));
  });

  it('keeps the saved brief when the field is cleared or there is none', async () => {
    const launcher = launcherIn({ phase: 'idle' });
    render(form(launcher, { soul: starter, loadBrief: async () => 'Review open PRs' }));
    await waitFor(() => expect(briefField().value).toBe('Review open PRs'));
    fireEvent.change(briefField(), { target: { value: '' } });
    fireEvent.submit(screen.getByRole('form'));
    expect(vi.mocked(launcher.launch).mock.calls[0][0]).not.toHaveProperty('brief');
    cleanup();
    const again = launcherIn({ phase: 'idle' });
    render(form(again, { soul: starter, loadBrief: async () => null }));
    await waitFor(() => expect(briefField().disabled).toBe(false));
    expect(briefField().value).toBe('');
    expect(screen.getByText(keepHint)).toBeTruthy();
    fireEvent.submit(screen.getByRole('form'));
    expect(vi.mocked(again.launch).mock.calls[0][0]).not.toHaveProperty('brief');
  });

  it('waits on the field while the brief loads, without holding up the launch', async () => {
    const launcher = launcherIn({ phase: 'idle' });
    let answer: (text: string | null) => void = () => {};
    const loadBrief = vi.fn(() => new Promise<string | null>((resolve) => { answer = resolve; }));
    render(form(launcher, { soul: starter, loadBrief }));
    expect(briefField().disabled).toBe(true);
    expect(screen.getByText('Loading its current brief…')).toBeTruthy();
    expect(launchButton().disabled).toBe(false);
    fireEvent.submit(screen.getByRole('form'));
    expect(vi.mocked(launcher.launch).mock.calls[0][0]).not.toHaveProperty('brief');
    await waitFor(() => expect(loadBrief).toHaveBeenCalled());
    answer('Review open PRs');
    await waitFor(() => expect(briefField().value).toBe('Review open PRs'));
  });

  it('leaves the field blank and usable when the brief cannot be read', async () => {
    const launcher = launcherIn({ phase: 'idle' });
    render(form(launcher, { soul: starter, loadBrief: async () => { throw new Error('agent-bot unavailable'); } }));
    await waitFor(() => expect(briefField().disabled).toBe(false));
    expect(briefField().value).toBe('');
    expect(screen.getByText(keepHint)).toBeTruthy();
    fireEvent.change(briefField(), { target: { value: 'Triage the inbox' } });
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ target: { soul: 'agent_s' }, brief: 'Triage the inbox' }));
  });

  it('keeps what the owner typed over a late answer', async () => {
    const launcher = launcherIn({ phase: 'idle' });
    let answer: (text: string | null) => void = () => {};
    const loadBrief = vi.fn(() => new Promise<string | null>((resolve) => { answer = resolve; }));
    render(form(launcher, { soul: starter, loadBrief }));
    // Should a value reach the field before the answer, it wins over the saved brief.
    fireEvent.change(briefField(), { target: { value: 'Ship the release' } });
    await waitFor(() => expect(loadBrief).toHaveBeenCalled());
    answer('Review open PRs');
    await waitFor(() => expect(briefField().disabled).toBe(false));
    expect(briefField().value).toBe('Ship the release');
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ brief: 'Ship the release' }));
  });

  it('shows the brief for a template launch too', async () => {
    const launcher = launcherIn({ phase: 'idle' });
    const listTemplates = vi.fn(async (): Promise<SoulTemplateList> => sampleTemplates);
    render(form(launcher, { listTemplates }));
    await screen.findAllByRole('radio');
    fireEvent.change(briefField(), { target: { value: 'Triage the inbox' } });
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ brief: 'Triage the inbox' }));
  });
});

describe('LaunchForm: who the companion runs as (#66)', () => {
  it('ends the progress list with "Runs as" once the daemon says, and not before', () => {
    const idle = launcherIn({ phase: 'idle' });
    const { rerender } = render(form(idle, { initialPackagePath: '/souls/helper.soul' }));
    fireEvent.submit(screen.getByRole('form'));
    rerender(form({ ...idle, state: { phase: 'pending', requestId: 'r1', note: null, stage: 'account' } }, { initialPackagePath: '/souls/helper.soul' }));
    let items = within(screen.getByRole('list', { name: 'Launch progress' })).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toHaveLength(3);
    rerender(form({ ...idle, state: { phase: 'pending', requestId: 'r1', note: null, stage: 'harness', sandbox: { resolution: 'sandboxed', account: 'gb-helper' } } },
      { initialPackagePath: '/souls/helper.soul' }));
    items = within(screen.getByRole('list', { name: 'Launch progress' })).getAllByRole('listitem').map((li) => li.textContent);
    expect(items.at(-1)).toBe('Runs as gb-helper (sandboxed)');
  });

  it('says it with a refused launch\'s result', () => {
    const idle = launcherIn({ phase: 'idle' });
    const { rerender } = render(form(idle, { initialPackagePath: '/souls/helper.soul' }));
    fireEvent.submit(screen.getByRole('form'));
    rerender(form({ ...idle, state: { phase: 'failed', requestId: 'r1', agentId: null, detail: 'refused', sandbox: { resolution: 'unrestricted', account: 'owner' } } },
      { initialPackagePath: '/souls/helper.soul' }));
    expect(screen.getByRole('alert').textContent).toContain('Runs as owner (unrestricted)');
  });
});

describe('LaunchForm model and parent (#261)', () => {
  const [luna, child, gone] = sampleCensus;
  const other: CensusRow = { ...luna, agentId: 'agent_other', name: 'nova', role: 'Researcher', parent: null };
  const roster = [luna, child, gone, other];
  const advanced = () => fireEvent.click(screen.getByRole('button', { name: 'Advanced: provider, model and parent' }));
  const parentSelect = () => screen.getByRole('combobox', { name: 'Parent' }) as HTMLSelectElement;
  const parentOptions = () => [...parentSelect().querySelectorAll('option')].map((o) => o.textContent);

  it('sends parent null for Independent, which is the default, and keeps model out when none is chosen', () => {
    const launcher = launcherIn({ phase: 'idle' });
    render(form(launcher, { initialPackagePath: '/souls/helper.soul', roster }));
    advanced();
    expect(screen.getByRole('button', { name: 'Advanced: provider, model and parent' }).getAttribute('aria-expanded')).toBe('true');
    expect(parentSelect().value).toBe('__none');
    expect(parentOptions()[0]).toBe('Independent — no parent, starts its own team');
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).toHaveBeenCalledOnce();
    const request = vi.mocked(launcher.launch).mock.calls[0][0];
    expect(request.parent).toBeNull();
    expect(request).not.toHaveProperty('model');
  });

  it('sends the chosen companion as parent once the launch path carries it', () => {
    const launcher = launcherIn({ phase: 'idle' });
    render(form(launcher, { initialPackagePath: '/souls/helper.soul', roster, parentCarried: true }));
    advanced();
    expect(parentOptions()).toEqual([
      'Independent — no parent, starts its own team', 'luna · codex', 'agent_c · unknown harness', 'old · unknown harness', 'nova · Researcher · codex']);
    fireEvent.change(parentSelect(), { target: { value: 'agent_other' } });
    expect(screen.getByText("Joins that companion's team. The engine confirms the parent it used.")).toBeTruthy();
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ parent: 'agent_other', target: { package: '/souls/helper.soul' } }));
  });

  it('carries the parent when the chosen companion\'s engine lists launch-parent, and refuses it when it does not', async () => {
    const env = (capabilities: string[]) => ({ engine: { version: '0.10.53', contractVersion: 1, capabilities }, providers: { declared: [], secrets: [], invalid: [] } } as unknown as SoulEnvironment);
    const asked: string[] = [];
    const launcher = launcherIn({ phase: 'idle' });
    const { unmount } = render(form(launcher, { initialPackagePath: '/souls/helper.soul', roster,
      loadEnvironment: async (id) => { asked.push(id); return env(['env', 'launch-parent']); } }));
    advanced();
    fireEvent.change(parentSelect(), { target: { value: 'agent_other' } });
    await waitFor(() => expect(asked).toEqual(['agent_other']));
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ parent: 'agent_other' }));
    unmount();
    const older = launcherIn({ phase: 'idle' });
    const askedOlder: string[] = [];
    render(form(older, { initialPackagePath: '/souls/helper.soul', roster, loadEnvironment: async (id) => { askedOlder.push(id); return env(['env', 'providers']); } }));
    advanced();
    fireEvent.change(parentSelect(), { target: { value: 'agent_other' } });
    await waitFor(() => expect(askedOlder).toEqual(['agent_other']));
    fireEvent.submit(screen.getByRole('form'));
    expect(older.launch).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain("This engine doesn't carry a parent at launch");
  });

  it('offers no companion the launch path cannot carry: the choice stays, the list says so, nothing is sent', () => {
    const launcher = launcherIn({ phase: 'idle' });
    render(form(launcher, { initialPackagePath: '/souls/helper.soul', roster }));
    advanced();
    fireEvent.change(parentSelect(), { target: { value: 'agent_other' } });
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).not.toHaveBeenCalled();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Fix these before launching:');
    expect(alert.textContent).toContain("This engine doesn't carry a parent at launch (agent-bot without launch-parent), so it would start independent.");
    expect(document.activeElement).toBe(alert);
    expect(parentSelect().value).toBe('agent_other');
    fireEvent.change(parentSelect(), { target: { value: '__none' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ parent: null }));
  });

  it('excludes the relaunched soul and its descendants from the parents, and keeps its own parent for a child', () => {
    render(form(launcherIn({ phase: 'idle' }), { soul: luna, roster }));
    advanced();
    expect(parentOptions()).toEqual(['Independent — no parent, starts its own team', 'old · unknown harness', 'nova · Researcher · codex']);
    cleanup();
    const launcher = launcherIn({ phase: 'idle' });
    render(form(launcher, { soul: child, roster, defaultHarness: 'claude' }));
    advanced();
    expect(parentOptions()).toEqual(['Independent — no parent, starts its own team', 'luna · codex', 'old · unknown harness', 'nova · Researcher · codex']);
    expect(parentSelect().value).toBe('agent_p');
    // Its own parent asks the daemon for nothing new, so the relaunch goes through unchanged.
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ target: { soul: 'agent_c' }, parent: 'agent_p' }));
  });

  it('lists every problem before launching, focused and announced, and launches nothing', () => {
    const launcher = launcherIn({ phase: 'idle' });
    render(form(launcher, { initialPackagePath: '/souls/helper.soul', copyOf: { name: 'luna', agentId: 'agent_p' }, harnesses: [], defaultHarness: null }));
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).not.toHaveBeenCalled();
    const alert = screen.getByRole('alert');
    expect(document.activeElement).toBe(alert);
    expect([...alert.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Enter a name.', 'Pick a harness, or set a GeniusBar default.']);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Luna II' } });
    expect([...screen.getByRole('alert').querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Pick a harness, or set a GeniusBar default.']);
  });

  it('keeps the chosen model and parent after a refused launch, shown in the engine\'s words', () => {
    const idle = launcherIn({ phase: 'idle' });
    const { rerender } = render(form(idle, { initialPackagePath: '/souls/helper.soul', roster, parentCarried: true }));
    advanced();
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: '__other' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Model ID' }), { target: { value: 'my-org/custom' } });
    fireEvent.change(parentSelect(), { target: { value: 'agent_other' } });
    fireEvent.submit(screen.getByRole('form'));
    expect(idle.launch).toHaveBeenCalledWith(expect.objectContaining({ model: 'my-org/custom', parent: 'agent_other' }));
    rerender(form({ ...idle, state: { phase: 'error', requestId: null, text: 'refused: model my-org/custom is not offered by codex' } }, { initialPackagePath: '/souls/helper.soul', roster, parentCarried: true }));
    expect(screen.getByRole('alert').textContent).toBe('refused: model my-org/custom is not offered by codex');
    expect(screen.getByTestId('model-stored').textContent).toBe('Stored model: my-org/custom');
    expect(parentSelect().value).toBe('agent_other');
  });

  it('shows the provider read-only: declared by the soul for the harness, the harness\'s own, or the template\'s choice', async () => {
    const env = (declared: { harness: string; id: string }[], capabilities = ['env', 'providers']) =>
      ({ engine: { version: '0.10.51', contractVersion: 1, capabilities }, providers: { declared, secrets: [], invalid: [] } } as unknown as SoulEnvironment);
    const { unmount } = render(form(launcherIn({ phase: 'idle' }), { soul: luna, roster, loadEnvironment: async () => env([{ harness: 'codex', id: 'openrouter' }]) }));
    advanced();
    expect(await screen.findByText('openrouter · declared by its soul.json for codex; not picked per launch.')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Provider' })).toBeNull();
    unmount();
    render(form(launcherIn({ phase: 'idle' }), { soul: luna, roster, loadEnvironment: async () => env([]) }));
    advanced();
    expect(await screen.findByText("None declared for codex — the harness's own provider; not picked per launch.")).toBeTruthy();
    cleanup();
    render(form(launcherIn({ phase: 'idle' }), { initialPackagePath: '/souls/helper.soul', roster }));
    advanced();
    expect(screen.getByText("Chosen by the soul's template (soul.json harnesses.claude.provider), not per launch; the engine refuses another.")).toBeTruthy();
  });
});

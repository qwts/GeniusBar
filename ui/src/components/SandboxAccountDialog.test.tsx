import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { BridgeError } from '../bridge';
import { I18nProvider } from '../lib/i18n';
import { sampleCensus, sampleSandbox, sampleSandboxSteps } from '../model/fixtures';
import { liveSandbox, normalizeSandboxSettings, SandboxProvider, type SandboxSource, type SandboxStatus } from './Sandbox';
import { ACCOUNT_HINT } from './SandboxAccountDialog';
import { SandboxCard } from './SandboxCard';
import { SandboxChip } from './SandboxChip';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

afterEach(() => { cleanup(); vi.mocked(invoke).mockReset(); });

const [luna] = sampleCensus;
const ORDER = 'Order: pack > this soul > GeniusBar default';

/**
 * A fake agent-bot whose `account` lands the name as the engine would once
 * the owner approves (or `missing` says the account then does not exist),
 * and whose `status` reads it back.
 */
function fakeSource(initial: SandboxStatus = sampleSandbox, { missing = false, supported = true } = {}) {
  let current = initial;
  const land = (name: string) => {
    current = {
      ...current, account: name,
      status: missing ? 'missing' : 'ready', steps: missing ? sampleSandboxSteps(name) : [],
      souls: current.souls.map((s) => (s.sandboxed && s.source !== 'sop' ? { ...s, runsAs: name } : s)),
    };
  };
  const source = {
    status: vi.fn(async () => current),
    set: vi.fn(async (on: boolean) => { current = { ...current, enabled: on }; return { enabled: on, provider: current.provider, account: current.account }; }),
    override: vi.fn(async () => { throw new BridgeError('sandbox-failed', 'not in this test'); }),
    pairings: vi.fn(async () => []),
    approve: vi.fn(async () => ({})),
    account: vi.fn(async (name: string) => { land(name); return { enabled: current.enabled, provider: current.provider, account: name }; }),
    accountSupported: vi.fn(async () => supported),
    land,
  } satisfies SandboxSource & { land: (name: string) => void };
  return source;
}

const withSandbox = (source: SandboxSource, ui: ReactNode) =>
  render(<I18nProvider><SandboxProvider source={source}>{ui}</SandboxProvider></I18nProvider>);

async function openFromCard(source: SandboxSource) {
  withSandbox(source, <SandboxCard />);
  const edit = await screen.findByRole('button', { name: 'Edit account…' });
  // A real click focuses the button first; the dialog hands focus back there.
  edit.focus();
  fireEvent.click(edit);
  const dialog = screen.getByRole('dialog', { name: 'Change the account each sandboxed companion runs as' });
  const input = within(dialog).getByLabelText('New account') as HTMLInputElement;
  return { edit, dialog, input };
}

describe('the Sandboxing card’s Edit account… (#66)', () => {
  it('shows Runs as with Edit account…, opens the dialog on GeniusBar’s default, focused on New account', async () => {
    const source = fakeSource();
    const { dialog, input } = await openFromCard(source);
    expect(screen.getByText('Runs as geniusbar-agent')).toBeTruthy();
    expect(within(dialog).getByText("This picks which existing standard account runs each sandboxed companion. It doesn't rename a macOS user or move the soul's files.")).toBeTruthy();
    expect(within(dialog).getByText((_, el) => el?.tagName === 'P' && el.textContent === 'Current account: geniusbar-agent')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(within(dialog).getByText((_, el) => el?.tagName === 'P' && el.textContent === ORDER)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
    // Nothing here renames or creates a macOS user.
    expect(dialog.textContent).not.toMatch(/rename the|create a|creates? the user|sysadminctl/i);
  });

  it('blocks Save on an invalid name with the inline message, linked by aria-describedby', async () => {
    const source = fakeSource();
    const { dialog, input } = await openFromCard(source);
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.change(input, { target: { value: 'Agent.X' } });
    const message = within(dialog).getByText('Use lowercase letters, numbers, - or _ (start with a letter or _).');
    expect(message.className).toContain('text-destructive');
    expect(within(dialog).getByText('Rules come from the engine; this check is only a hint.')).toBeTruthy();
    expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(message.closest('p')?.id);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.submit(dialog);
    expect(source.account).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'geniusbar-agent' } });
    expect(within(dialog).getByText("That's already the current account.")).toBeTruthy();
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.change(input, { target: { value: 'gb-luna' } });
    expect(save.hasAttribute('disabled')).toBe(false);
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  it('mirrors agent-bot’s short-name rule only as a hint', () => {
    for (const ok of ['geniusbar-agent', '_a', 'a', `a${'b'.repeat(30)}`]) expect(ACCOUNT_HINT.test(ok), ok).toBe(true);
    for (const bad of ['', 'Agent', '1agent', '-agent', 'a b', 'agent.x', `a${'b'.repeat(31)}`]) expect(ACCOUNT_HINT.test(bad), bad).toBe(false);
  });

  it('saves on Enter, says only Account set to …, reads the status again, and hands focus back to Edit account…', async () => {
    const source = fakeSource();
    const { edit, dialog, input } = await openFromCard(source);
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.change(input, { target: { value: 'gb-luna' } });
    fireEvent.submit(dialog);
    expect(source.account).toHaveBeenCalledWith('gb-luna');
    expect((await within(dialog).findByText('Account set to gb-luna')).getAttribute('role')).toBe('status');
    expect(source.status).toHaveBeenCalledTimes(2);
    expect(within(dialog).getByText((_, el) => el?.tagName === 'P' && el.textContent === 'Current account: gb-luna')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Save' })).toBeNull();
    expect(within(dialog).queryByText(/doesn't exist yet/)).toBeNull();
    expect(screen.getByText('Runs as gb-luna')).toBeTruthy();
    // The × and the footer's Close both close; the footer's is last.
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' }).at(-1)!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(edit);
  });

  it('cancels with Escape, keeping the old account and asking agent-bot nothing', async () => {
    const source = fakeSource();
    const { edit, dialog, input } = await openFromCard(source);
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.change(input, { target: { value: 'gb-luna' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(source.account).not.toHaveBeenCalled();
    expect(screen.getByText('Runs as geniusbar-agent')).toBeTruthy();
    expect(document.activeElement).toBe(edit);
    expect(dialog.isConnected).toBe(false);
  });

  it('ignores Escape and the backdrop while saving', async () => {
    const source = fakeSource();
    let settle: (value: { enabled: boolean; provider: string; account: string }) => void = () => {};
    source.account.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    const { dialog, input } = await openFromCard(source);
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.change(input, { target: { value: 'gb-luna' } });
    fireEvent.submit(dialog);
    expect((await within(dialog).findByRole('status')).textContent).toBe('Saving…');
    expect(within(dialog).getByRole('button', { name: 'Saving…' }).hasAttribute('disabled')).toBe(true);
    expect(within(dialog).getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    source.land('gb-luna');
    settle({ enabled: true, provider: 'standard_macos_account', account: 'gb-luna' });
    expect((await within(dialog).findByText('Account set to gb-luna'))).toBeTruthy();
  });

  it('shows agent-bot’s refusal as it is, reads again, and keeps the old account', async () => {
    const source = fakeSource();
    source.account.mockRejectedValueOnce(new BridgeError('owner-approval-denied', 'the owner did not approve'));
    const { dialog, input } = await openFromCard(source);
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.change(input, { target: { value: 'gb-luna' } });
    fireEvent.submit(dialog);
    expect((await within(dialog).findByRole('alert')).textContent).toBe('the owner did not approve');
    expect(source.status).toHaveBeenCalledTimes(2);
    expect(within(dialog).getByText((_, el) => el?.tagName === 'P' && el.textContent === 'Current account: geniusbar-agent')).toBeTruthy();
    expect(screen.getByText('Runs as geniusbar-agent')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false);
    expect(input.value).toBe('gb-luna');
    cleanup();
    // A bad name agent-bot refuses: its own wording, not GeniusBar's.
    const strict = fakeSource();
    strict.account.mockRejectedValueOnce(new BridgeError('invalid-account', 'sandbox account must be a short macOS account name like geniusbar-agent (lowercase letters, digits, _ and -), not "gb-x"'));
    const again = await openFromCard(strict);
    await waitFor(() => expect(document.activeElement).toBe(again.input));
    fireEvent.change(again.input, { target: { value: 'gb-x' } });
    fireEvent.submit(again.dialog);
    expect((await within(again.dialog).findByRole('alert')).textContent).toContain('not "gb-x"');
  });

  it('says it is re-reading after an unclear answer, then shows what the re-read says', async () => {
    // The engine answered nothing parseable but did write: the re-read shows the name, so it was set.
    const landed = fakeSource();
    landed.account.mockImplementationOnce(async (name: string) => { landed.land(name); throw new BridgeError('sandbox-failed', 'agent-bot gave no sandbox setting'); });
    let reread: () => void = () => {};
    landed.status.mockImplementationOnce(async () => sampleSandbox);
    const first = await openFromCard(landed);
    await waitFor(() => expect(document.activeElement).toBe(first.input));
    landed.status.mockImplementationOnce(() => new Promise((resolve) => { reread = () => resolve({ ...sampleSandbox, account: 'gb-luna' }); }));
    fireEvent.change(first.input, { target: { value: 'gb-luna' } });
    fireEvent.submit(first.dialog);
    expect((await within(first.dialog).findByText("GeniusBar didn't get a clear answer. Re-reading the account from agent-bot before showing anything else.")).getAttribute('role')).toBe('status');
    expect(within(first.dialog).queryByRole('alert')).toBeNull();
    reread();
    expect((await within(first.dialog).findByText('Account set to gb-luna'))).toBeTruthy();
    cleanup();
    // The engine was unreachable and wrote nothing: the re-read's account stands, with the engine's words.
    const unreachable = fakeSource();
    unreachable.account.mockRejectedValueOnce(new BridgeError('sandbox-unavailable', 'node could not start'));
    const second = await openFromCard(unreachable);
    await waitFor(() => expect(document.activeElement).toBe(second.input));
    fireEvent.change(second.input, { target: { value: 'gb-luna' } });
    fireEvent.submit(second.dialog);
    expect((await within(second.dialog).findByRole('alert')).textContent).toBe('node could not start');
    expect(unreachable.status).toHaveBeenCalledTimes(2);
    expect(within(second.dialog).getByText((_, el) => el?.tagName === 'P' && el.textContent === 'Current account: geniusbar-agent')).toBeTruthy();
    expect(within(second.dialog).queryByText(/Account set to/)).toBeNull();
  });

  it('lists agent-bot’s steps, each with who runs it, when the account set does not exist yet', async () => {
    const source = fakeSource(sampleSandbox, { missing: true });
    const { dialog, input } = await openFromCard(source);
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.change(input, { target: { value: 'gb-new' } });
    fireEvent.submit(dialog);
    expect((await within(dialog).findByText('Account set to gb-new')).getAttribute('role')).toBe('status');
    expect(within(dialog).getByText("Account gb-new doesn't exist yet. Set it up first — agent-bot lists the steps.")).toBeTruthy();
    const items = within(within(dialog).getByRole('list', { name: 'Steps for you' })).getAllByRole('listitem');
    // dev-tools is done, so five remain, in agent-bot's order, each saying who performs it.
    expect(items.map((li) => li.textContent)).toEqual([
      'Create the standard account gb-newIn your account, as an administrator',
      'gb-new has no admin rightsIn your account, as an administrator',
      'gb-new may reach the agent-comms brokerIn your account, as an administrator',
      'Pair gb-new with the brokerLogged in as gb-new',
      'Sign the harnesses in as gb-newLogged in as gb-new',
    ]);
    // Nothing claims the onboarding happened, and no pairing was approved.
    expect(dialog.textContent).not.toMatch(/ready|approved/i);
    expect(source.approve).not.toHaveBeenCalled();
  });

  it('keeps Save disabled with the reason when the bundled agent-bot has no sandbox account', async () => {
    const source = fakeSource(sampleSandbox, { supported: false });
    const { dialog, input } = await openFromCard(source);
    expect(await within(dialog).findByText("Changing the account isn't available in this version yet.")).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
    expect(input.hasAttribute('disabled')).toBe(true);
    expect(input.getAttribute('aria-describedby')).toContain('gated');
    fireEvent.submit(dialog);
    expect(source.account).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(source.accountSupported).toHaveBeenCalledTimes(1);
  });

  it('asks whether sandbox account exists once, and treats no answer as supported', async () => {
    const source = fakeSource();
    source.accountSupported.mockRejectedValue(new BridgeError('sandbox-unavailable', 'node could not start'));
    const { dialog } = await openFromCard(source);
    await waitFor(() => expect(within(dialog).getByLabelText('New account').hasAttribute('disabled')).toBe(false));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit account…' }));
    await screen.findByRole('dialog');
    expect(source.accountSupported).toHaveBeenCalledTimes(1);
  });
});

describe('a soul’s Edit account… from its sandbox chip (#66)', () => {
  const sop = { state: 'ok', decides: true, repository: 'qwts/sop', commit: 'abcdef0123456789abcdef0123456789abcdef01', rules: 1, message: null };
  const decided: SandboxStatus = {
    ...sampleSandbox, sop,
    souls: sampleSandbox.souls.map((s) => (s.agentId === luna.agentId ? { ...s, runsAs: 'gb-luna', source: 'sop' as const, rule: 'soul:luna' } : s)),
  };

  it('refuses edits on a pack-decided soul and shows the repository, commit and rule', async () => {
    const source = fakeSource(decided);
    withSandbox(source, <SandboxChip soul={luna} />);
    const pill = await screen.findByRole('button', { name: 'Sandbox for luna: Sandboxed' });
    fireEvent.click(pill);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit account…' }));
    const dialog = screen.getByRole('dialog', { name: 'Change the account luna runs as' });
    expect(within(dialog).getByText((_, el) => el?.tagName === 'P' && el.textContent === 'Current account: gb-luna')).toBeTruthy();
    const input = within(dialog).getByLabelText('New account') as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe('gb-luna');
    expect(within(dialog).queryByRole('button', { name: 'Save' })).toBeNull();
    expect(within(dialog).queryByText(/shared by every sandboxed companion/)).toBeNull();
    const locked = within(dialog).getByText('Set by the soul pack (qwts/sop @ abcdef0, rule soul:luna). Pack settings win over soul and GeniusBar settings.');
    expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(locked.id);
    const order = within(dialog).getByText((_, el) => el?.tagName === 'P' && el.textContent === ORDER);
    expect(within(order).getByText('pack').getAttribute('aria-current')).toBe('true');
    fireEvent.change(input, { target: { value: 'other' } });
    fireEvent.submit(dialog);
    expect(source.account).not.toHaveBeenCalled();
    expect(source.accountSupported).not.toHaveBeenCalled();
    expect(input.value).toBe('gb-luna');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(pill);
    // The soul still resolves as the pack decided.
    expect(screen.getByRole('button', { name: 'Sandbox for luna: Sandboxed' }).title).toBe('Runs as gb-luna (Standard macOS Account)');
  });

  it('marks GeniusBar default as the winner for a soul the pack does not decide, and saves through the same setter', async () => {
    const source = fakeSource();
    withSandbox(source, <SandboxChip soul={luna} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sandbox for luna: Sandboxed' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit account…' }));
    const dialog = screen.getByRole('dialog', { name: 'Change the account luna runs as' });
    const order = within(dialog).getByText((_, el) => el?.tagName === 'P' && el.textContent === ORDER);
    expect(within(order).getByText('GeniusBar default').getAttribute('aria-current')).toBe('true');
    // agent-bot keeps one account, so the dialog says the save reaches every sandboxed soul the pack does not decide.
    expect(within(dialog).getByText(/luna runs as GeniusBar's default account, shared by every sandboxed companion/)).toBeTruthy();
    const input = within(dialog).getByLabelText('New account');
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.change(input, { target: { value: 'gb-luna' } });
    fireEvent.submit(dialog);
    expect(source.account).toHaveBeenCalledWith('gb-luna');
    expect((await within(dialog).findByText('Account set to gb-luna'))).toBeTruthy();
    expect(within(dialog).getByText((_, el) => el?.tagName === 'P' && el.textContent === 'Current account: gb-luna')).toBeTruthy();
  });

  it('offers no Edit account… for an unrestricted soul, and leaves the overrides as they were', async () => {
    withSandbox(fakeSource({ ...sampleSandbox, enabled: false, souls: sampleSandbox.souls.map((s) => ({ ...s, override: 'inherit' as const, sandboxed: false, runsAs: 'user', source: 'global' as const })) }), <SandboxChip soul={luna} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sandbox for luna: Unrestricted' }));
    const menu = screen.getByRole('menu', { name: 'Sandboxing' });
    expect(within(menu).queryByRole('menuitem')).toBeNull();
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(3);
  });
});

describe('the agent-bot client for sandbox account', () => {
  it('asks the shell with sandbox_account and its probe', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'sandbox_account') return { enabled: true, provider: 'standard_macos_account', account: 'gb-luna' };
      if (command === 'sandbox_account_probe') return { supported: true };
      throw new Error(command);
    });
    expect(await liveSandbox.account('gb-luna')).toEqual({ enabled: true, provider: 'standard_macos_account', account: 'gb-luna' });
    expect(await liveSandbox.accountSupported()).toBe(true);
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['sandbox_account', { account: 'gb-luna' }],
      ['sandbox_account_probe', {}],
    ]);
  });

  it('keeps agent-bot’s codes, so a refusal and an older bundle read as what they are', async () => {
    vi.mocked(invoke).mockRejectedValueOnce({ code: 'invalid-account', message: 'sandbox account must be a short macOS account name' });
    await expect(liveSandbox.account('Agent.X')).rejects.toMatchObject({ code: 'invalid-account', message: 'sandbox account must be a short macOS account name' });
    vi.mocked(invoke).mockRejectedValueOnce({ code: 'sandbox-account-unsupported', message: 'this agent-bot has no sandbox account' });
    await expect(liveSandbox.account('gb-luna')).rejects.toMatchObject({ code: 'sandbox-account-unsupported' });
    vi.mocked(invoke).mockResolvedValueOnce({ account: 'gb-luna' });
    await expect(liveSandbox.account('gb-luna')).rejects.toMatchObject({ code: 'sandbox-failed' });
    vi.mocked(invoke).mockResolvedValueOnce({ supported: 'yes' });
    await expect(liveSandbox.accountSupported()).rejects.toMatchObject({ code: 'sandbox-failed' });
  });

  it('normalizes the settings as agent-bot prints them', () => {
    expect(normalizeSandboxSettings({ enabled: false, provider: 'standard_macos_account', account: 'gb-luna' }))
      .toEqual({ enabled: false, provider: 'standard_macos_account', account: 'gb-luna' });
    expect(normalizeSandboxSettings({ enabled: true, account: 'x' })?.provider).toBe('standard_macos_account');
    expect(normalizeSandboxSettings({ enabled: 'yes', account: 'x' })).toBeNull();
    expect(normalizeSandboxSettings(null)).toBeNull();
  });
});

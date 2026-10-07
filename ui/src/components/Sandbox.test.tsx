import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { App } from '../App';
import { BridgeError } from '../bridge';
import { I18nProvider } from '../lib/i18n';
import { sampleCensus, sampleConnection } from '../model/fixtures';
import { layoutActions } from '../state/layout';
import { preferenceActions } from '../state/preferences';
import { CompanionDetails } from './CompanionSession';
import { liveSandbox, normalizeSandboxStatus, SandboxProvider, type SandboxSoul, type SandboxSource, type SandboxStatus } from './Sandbox';
import { SandboxCard } from './SandboxCard';
import { SandboxChip } from './SandboxChip';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

afterEach(() => { cleanup(); globalThis.localStorage?.clear(); layoutActions.forget(); preferenceActions.forget(); vi.mocked(invoke).mockReset(); });

const [luna, child] = sampleCensus;

const steps: SandboxStatus['steps'] = [
  { id: 'create-account', title: 'Create the standard account geniusbar-agent', run: 'owner-admin',
    commands: ['sudo sysadminctl -addUser geniusbar-agent -fullName "GeniusBar Agent" -password -'], done: true },
  { id: 'dev-tools', title: 'Apple command-line tools are installed (shared by every account)', run: 'owner',
    commands: ['xcode-select --install'], done: false },
  { id: 'broker-group', title: 'geniusbar-agent may reach the agent-comms broker', run: 'owner-admin',
    commands: ['sudo dseditgroup -o edit -a geniusbar-agent -t user agent-comms'], done: null, note: 'Use the group the broker was installed with.' },
  { id: 'pair', title: 'Pair geniusbar-agent with the broker', run: 'account',
    commands: ['agent-comms account pair --broker me', 'agent-comms broker approve CODE'], done: false },
];

const soulRow = (agentId: string, over: Partial<SandboxSoul> = {}): SandboxSoul => ({
  agentId, name: agentId, override: 'inherit', sandboxed: false, runsAs: 'me', source: 'global', ...over,
});

function status(over: Partial<SandboxStatus> = {}): SandboxStatus {
  return {
    enabled: false, provider: 'standard_macos_account', account: 'geniusbar-agent', status: 'creating',
    steps, souls: [soulRow(luna.agentId), soulRow(child.agentId)], ...over,
  };
}

/** A fake agent-bot: `set` and `override` change what `status` reads next. */
function fakeSource(initial: SandboxStatus) {
  let current = initial;
  const source = {
    status: vi.fn(async () => current),
    set: vi.fn(async (on: boolean) => {
      current = { ...current, enabled: on, souls: current.souls.map((s) => s.override === 'inherit'
        ? { ...s, sandboxed: on, runsAs: on ? current.account : 'me' } : s) };
      return { enabled: on, provider: current.provider, account: current.account };
    }),
    override: vi.fn(async (agentId: string, override: SandboxSoul['override']) => {
      const sandboxed = override === 'inherit' ? current.enabled : override === 'sandboxed';
      const row = soulRow(agentId, { override, sandboxed, runsAs: sandboxed ? current.account : 'me', source: override === 'inherit' ? 'global' : 'override' });
      current = { ...current, souls: current.souls.map((s) => (s.agentId === agentId ? row : s)) };
      return row;
    }),
  } satisfies SandboxSource;
  return source;
}

const withSandbox = (source: SandboxSource | null, ui: ReactNode) =>
  render(<I18nProvider><SandboxProvider source={source}>{ui}</SandboxProvider></I18nProvider>);

describe('SandboxCard', () => {
  it('renders the switch off from agent-bot, with only the description', async () => {
    const source = fakeSource(status());
    withSandbox(source, <SandboxCard />);
    const toggle = await screen.findByRole('switch', { name: 'Sandboxing' }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByText('Run agents in a separate standard macOS account with no admin rights.')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Sandbox type' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Steps for you' })).toBeNull();
  });

  it('turns on through agent-bot, reads again, and shows the provider, status and undone steps', async () => {
    const source = fakeSource(status());
    withSandbox(source, <SandboxCard />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Sandboxing' }));
    expect(source.set).toHaveBeenCalledWith(true);
    await waitFor(() => expect((screen.getByRole('switch', { name: 'Sandboxing' }) as HTMLInputElement).checked).toBe(true));
    expect(source.status).toHaveBeenCalledTimes(2);
    const provider = screen.getByRole('combobox', { name: 'Sandbox type' }) as HTMLSelectElement;
    expect(provider.value).toBe('standard_macos_account');
    expect(within(provider).getByRole('option', { name: 'More options coming soon' }).hasAttribute('disabled')).toBe(true);
    const creating = screen.getByText('Account “geniusbar-agent” exists; finish setting it up');
    // The design's spinning Loader2 while the account is being made, and its small switch.
    expect(creating.querySelector('svg')?.getAttribute('class')).toContain('animate-spin');
    expect(screen.getByRole('switch', { name: 'Sandboxing' }).className).toContain('switch-sm');
    const list = screen.getByRole('list', { name: 'Steps for you' });
    const items = within(list).getAllByRole('listitem');
    // create-account is done, so three remain, in agent-bot's order.
    expect(items.map((li) => li.querySelector('span')?.textContent)).toEqual([
      'Apple command-line tools are installed (shared by every account)',
      'geniusbar-agent may reach the agent-comms broker',
      'Pair geniusbar-agent with the broker',
    ]);
    expect(within(items[1]).getByText(/GeniusBar cannot check this one/)).toBeTruthy();
    expect(within(items[1]).getByText('Use the group the broker was installed with.')).toBeTruthy();
    expect(within(items[2]).getByText('Logged in as geniusbar-agent')).toBeTruthy();
    expect(within(items[2]).getAllByRole('button', { name: /^Copy / })).toHaveLength(2);
  });

  it('copies a command', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    withSandbox(fakeSource(status({ enabled: true })), <SandboxCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy xcode-select --install' }));
    expect(writeText).toHaveBeenCalledWith('xcode-select --install');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy xcode-select --install' }).title).toBe('Copied'));
  });

  it('shows no steps once the account is ready, or while it is missing and the switch is off', async () => {
    withSandbox(fakeSource(status({ enabled: true, status: 'ready' })), <SandboxCard />);
    expect(await screen.findByText('Account “geniusbar-agent” is ready')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Steps for you' })).toBeNull();
    cleanup();
    withSandbox(fakeSource(status({ enabled: true, status: 'missing' })), <SandboxCard />);
    expect(await screen.findByText('Account “geniusbar-agent” does not exist yet')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Steps for you' })).toBeTruthy();
  });

  it('keeps the switch when the owner refuses, and says why', async () => {
    const source = fakeSource(status());
    source.set.mockRejectedValueOnce(new BridgeError('owner-approval-denied', 'the owner did not approve'));
    withSandbox(source, <SandboxCard />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Sandboxing' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Sandboxing unchanged: the owner did not approve');
    expect((screen.getByRole('switch', { name: 'Sandboxing' }) as HTMLInputElement).checked).toBe(false);
  });

  it('is hidden when the bundled agent-bot has no sandbox, or without a source', async () => {
    const source = fakeSource(status());
    source.status.mockRejectedValue(new BridgeError('sandbox-unsupported', 'this agent-bot has no sandbox'));
    const { container } = withSandbox(source, <SandboxCard />);
    await waitFor(() => expect(source.status).toHaveBeenCalled());
    expect(container.textContent).toBe('');
    cleanup();
    const none = withSandbox(null, <SandboxCard />);
    expect(none.container.textContent).toBe('');
  });
});

describe('SandboxChip', () => {
  it('shows the resolution, Runs as, and the overrides with inherit labelled by the global switch', async () => {
    withSandbox(fakeSource(status({ enabled: true, souls: [soulRow(luna.agentId, { sandboxed: true, runsAs: 'geniusbar-agent' })] })),
      <SandboxChip soul={luna} />);
    const pill = await screen.findByRole('button', { name: 'Sandbox for luna: Sandboxed' });
    fireEvent.click(pill);
    const menu = screen.getByRole('menu', { name: 'Sandboxing' });
    expect(within(menu).getByText('Runs as geniusbar-agent (Standard macOS Account)')).toBeTruthy();
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual(['Use GeniusBar setting (Sandboxed)', 'Always sandboxed', 'Never sandboxed']);
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
  });

  it('sets an override through agent-bot and reads again', async () => {
    const source = fakeSource(status());
    withSandbox(source, <SandboxChip soul={luna} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sandbox for luna: Unrestricted' }));
    expect(screen.getByText('Runs as you (me)')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Always sandboxed' }));
    expect(source.override).toHaveBeenCalledWith(luna.agentId, 'sandboxed');
    expect(await screen.findByRole('button', { name: 'Sandbox for luna: Sandboxed' })).toBeTruthy();
    expect(source.status).toHaveBeenCalledTimes(2);
  });

  it('reopens with the refusal when the owner declines', async () => {
    const source = fakeSource(status());
    source.override.mockRejectedValueOnce(new BridgeError('owner-approval-denied', 'the owner did not approve'));
    withSandbox(source, <SandboxChip soul={luna} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sandbox for luna: Unrestricted' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Never sandboxed' }));
    const menu = await screen.findByRole('menu', { name: 'Sandboxing' });
    expect(within(menu).getByRole('alert').textContent).toBe('Sandboxing unchanged: the owner did not approve');
  });

  it('is absent for a soul agent-bot has no row for', async () => {
    const source = fakeSource(status({ souls: [] }));
    const { container } = withSandbox(source, <SandboxChip soul={luna} />);
    await waitFor(() => expect(source.status).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});

describe('Details', () => {
  it('adds the Sandbox row with Runs as', async () => {
    withSandbox(fakeSource(status({ enabled: true, souls: [soulRow(child.agentId, { sandboxed: true, runsAs: 'geniusbar-agent' })] })),
      <CompanionDetails soul={child} />);
    const term = await screen.findByText('Sandbox', { selector: 'dt' });
    expect(term.nextElementSibling?.textContent).toBe('SandboxedRuns as geniusbar-agent (Standard macOS Account)');
  });
});

describe('App window chrome', () => {
  it('replaces the hardened pill with the sandbox chip, and falls back to it on an older agent-bot', async () => {
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic sandboxSource={fakeSource(status())} />);
    fireEvent.click(within(screen.getByRole('main', { name: 'Fleet' })).getByRole('button', { name: /^luna,/ }));
    const win = screen.getByRole('dialog', { name: 'luna' });
    expect(await within(win).findByRole('button', { name: 'Sandbox for luna: Unrestricted' })).toBeTruthy();
    expect(within(win).queryByText('Hardened', { selector: 'span.rounded-full' })).toBeNull();
    cleanup();
    const old = fakeSource(status());
    old.status.mockRejectedValue(new BridgeError('sandbox-unsupported', 'this agent-bot has no sandbox'));
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic sandboxSource={old} />);
    fireEvent.click(within(screen.getByRole('main', { name: 'Fleet' })).getByRole('button', { name: /^luna,/ }));
    await waitFor(() => expect(old.status).toHaveBeenCalled());
    const fallback = screen.getByRole('dialog', { name: 'luna' });
    expect(within(fallback).getByText('Hardened', { selector: 'span.rounded-full' })).toBeTruthy();
    expect(within(fallback).queryByRole('button', { name: /^Sandbox for/ })).toBeNull();
  });

  it('puts the Sandboxing card in the menu', async () => {
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic sandboxSource={fakeSource(status())} />);
    fireEvent.click(screen.getByRole('button', { name: 'GeniusBar menu' }));
    const menu = screen.getByRole('dialog', { name: 'GeniusBar menu' });
    expect(await within(menu).findByRole('region', { name: 'Sandboxing' })).toBeTruthy();
  });
});

describe('the agent-bot client', () => {
  it('asks the shell with the bridge commands and their arguments', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'sandbox_status') return status();
      if (command === 'sandbox_set') return { enabled: true, provider: 'standard_macos_account', account: 'geniusbar-agent' };
      return soulRow('agent_1', { override: 'unrestricted', source: 'override' });
    });
    expect((await liveSandbox.status()).status).toBe('creating');
    await liveSandbox.set(true);
    expect((await liveSandbox.override('agent_1', 'unrestricted')).override).toBe('unrestricted');
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['sandbox_status', {}],
      ['sandbox_set', { action: 'on' }],
      ['sandbox_override', { agent: 'agent_1', action: 'unrestricted' }],
    ]);
  });

  it('keeps the bridge error code, so an older bundle reads as unsupported', async () => {
    vi.mocked(invoke).mockRejectedValue({ code: 'sandbox-unsupported', message: 'this agent-bot has no sandbox' });
    await expect(liveSandbox.status()).rejects.toMatchObject({ code: 'sandbox-unsupported' });
    vi.mocked(invoke).mockResolvedValue({ enabled: 'yes' });
    await expect(liveSandbox.status()).rejects.toMatchObject({ code: 'sandbox-failed' });
  });

  it('normalizes status, dropping malformed steps and souls', () => {
    expect(normalizeSandboxStatus({ enabled: true, account: 'a', status: 'done', steps: [], souls: [] })).toBeNull();
    const s = normalizeSandboxStatus({
      enabled: true, account: 'a', status: 'missing',
      steps: [{ id: 'x', title: 'X', run: 'owner', commands: ['c', 1], done: 'maybe' }, { title: 'no id' }],
      souls: [{ agentId: 'agent_1', override: 'always', sandboxed: true, runsAs: 'a' }, soulRow('agent_2')],
    });
    expect(s?.steps).toEqual([{ id: 'x', title: 'X', run: 'owner', commands: ['c'], done: null }]);
    expect(s?.souls.map((r) => r.agentId)).toEqual(['agent_2']);
  });
});

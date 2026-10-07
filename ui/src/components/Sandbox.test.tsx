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
import { liveSandbox, normalizeSandboxPairings, normalizeSandboxStatus, SandboxProvider, type SandboxPairing, type SandboxSoul, type SandboxSource, type SandboxStatus } from './Sandbox';
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
  agentId, name: agentId, override: 'inherit', sandboxed: false, runsAs: 'me', source: 'global', rule: null, reason: null, ...over,
});

function status(over: Partial<SandboxStatus> = {}): SandboxStatus {
  return {
    enabled: false, provider: 'standard_macos_account', account: 'geniusbar-agent', status: 'creating',
    steps, souls: [soulRow(luna.agentId), soulRow(child.agentId)], sop: null, ...over,
  };
}

/** A fake agent-bot: `set` and `override` change what `status` reads next; `approve` settles a pending pairing. */
function fakeSource(initial: SandboxStatus, pairings: SandboxPairing[] = []) {
  let current = initial;
  let pending = pairings;
  const source = {
    pairings: vi.fn(async () => pending),
    approve: vi.fn(async (code: string) => {
      const row = pending.find((p) => p.code === code);
      if (!row) throw new BridgeError('sandbox-failed', `no pending pairing has the code ${code}`);
      pending = pending.map((p) => (p === row ? { ...p, state: 'approved', code: null } : p));
      return { account: row.account, state: 'approved' };
    }),
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

  it('centres the radio dot in a 3.5 box, as Radix, and words a refusal with the token class (S13)', async () => {
    withSandbox(fakeSource(status({ enabled: true, souls: [soulRow(luna.agentId, { sandboxed: true, runsAs: 'geniusbar-agent' })] })),
      <SandboxChip soul={luna} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sandbox for luna: Sandboxed' }));
    const [inherit, always] = within(screen.getByRole('menu', { name: 'Sandboxing' })).getAllByRole('menuitemradio');
    const box = inherit.firstElementChild as HTMLElement;
    expect(box.className.split(' ')).toEqual(expect.arrayContaining(['absolute', 'left-2', 'flex', 'size-3.5', 'items-center', 'justify-center']));
    expect(box.firstElementChild?.className).toContain('size-2');
    // Unchecked items keep the box, empty, so labels line up.
    expect((always.firstElementChild as HTMLElement).childElementCount).toBe(0);
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
    expect(within(menu).getByRole('alert').className).toContain('text-destructive');
  });

  it('focuses the first item on open, moves with Up / Down / Home / End, and Escape hands focus back to the pill (X10)', async () => {
    withSandbox(fakeSource(status()), <SandboxChip soul={luna} />);
    const pill = await screen.findByRole('button', { name: 'Sandbox for luna: Unrestricted' });
    fireEvent.click(pill);
    const menu = screen.getByRole('menu', { name: 'Sandboxing' });
    const [inherit, always, never] = within(menu).getAllByRole('menuitemradio');
    expect(document.activeElement).toBe(inherit);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(always);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(never);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(inherit);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(never);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(inherit);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Sandboxing' })).toBeNull();
    expect(document.activeElement).toBe(pill);
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

describe('the SOP pack’s persona mapping (#66)', () => {
  const sop = { state: 'ok', decides: true, repository: 'qwts/sop', commit: 'abcdef0123456789abcdef0123456789abcdef01', rules: 2, message: null };

  it('names the pack and its rules on the card, or agent-bot’s reason it decides nothing', async () => {
    const source = fakeSource(status({ enabled: true, sop }));
    withSandbox(source, <SandboxCard />);
    expect((await screen.findByText('SOP pack qwts/sop@abcdef0 decides: 2 rules')).className).toContain('text-muted-foreground');
    cleanup();
    withSandbox(fakeSource(status({ enabled: true, sop: { ...sop, state: 'unrecorded', decides: false, rules: 0, message: 'the SOP’s persona mapping is not recorded; run `agent-bot sop persona` to record it' } })), <SandboxCard />);
    await screen.findByText('SOP pack: the SOP’s persona mapping is not recorded; run `agent-bot sop persona` to record it');
    cleanup();
    // No SOP at all, or an older agent-bot: nothing said.
    withSandbox(fakeSource(status({ enabled: true, sop: { ...sop, state: 'none', decides: false, rules: 0 } })), <SandboxCard />);
    await screen.findByRole('switch', { name: 'Sandboxing' });
    expect(screen.queryByText(/SOP pack/)).toBeNull();
  });

  it('offers only inherit on a pack-decided soul, and says which rule decided', async () => {
    const decided = soulRow(luna.agentId, { sandboxed: true, runsAs: 'gb-reviewer', source: 'sop', rule: 'soul:luna',
      reason: null });
    const source = fakeSource(status({ enabled: true, souls: [decided, soulRow(child.agentId)], sop }));
    withSandbox(source, <SandboxChip soul={luna} />);
    fireEvent.click(await screen.findByRole('button', { name: /Sandbox for/ }));
    expect(screen.getByText('Decided by your SOP pack (rule soul:luna); change persona.toml there.')).toBeTruthy();
    const always = screen.getByRole('menuitemradio', { name: 'Always sandboxed' });
    expect(always.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(always);
    expect(source.override).not.toHaveBeenCalled();
    expect(screen.getByRole('menuitemradio', { name: /Use GeniusBar setting/ }).getAttribute('aria-disabled')).toBeNull();
  });

  it('shows agent-bot’s reason when the pack wants a sandbox the switch has off', async () => {
    const row = soulRow(luna.agentId, { source: 'sop', rule: 'role:auditor', reason: 'the SOP decides sandboxed as geniusbar-agent, but features.persona-accounts is off (agent-bot sandbox on turns it on); runs unrestricted' });
    withSandbox(fakeSource(status({ souls: [row, soulRow(child.agentId)], sop })), <SandboxChip soul={luna} />);
    fireEvent.click(await screen.findByRole('button', { name: /Sandbox for/ }));
    expect(screen.getByText(/features.persona-accounts is off/)).toBeTruthy();
  });

  it('reads the pack fields as agent-bot prints them, and an older agent-bot without them', () => {
    const parsed = normalizeSandboxStatus({ ...status(), sop: { state: 'ok', decides: true, repository: 'qwts/sop', commit: 'c0ffee', recordedAt: 'x', message: null, rules: [{ match: 'soul', value: 'luna', sandbox: 'sandboxed', account: null }], default: { sandbox: null, account: null } },
      souls: [{ agentId: 'a', name: 'A', override: 'inherit', sandboxed: true, runsAs: 'gb', source: 'sop', sop: { decides: true, state: 'ok', rule: 'soul:luna', sandbox: 'sandboxed', account: 'gb' } }] });
    expect(parsed?.sop).toEqual({ state: 'ok', decides: true, repository: 'qwts/sop', commit: 'c0ffee', rules: 1, message: null });
    expect(parsed?.souls[0]).toMatchObject({ source: 'sop', rule: 'soul:luna', reason: null });
    const older = normalizeSandboxStatus({ ...status(), sop: undefined, souls: [{ agentId: 'a', override: 'inherit', sandboxed: false, runsAs: 'me', source: 'global' }] });
    expect(older?.sop).toBeNull();
    expect(older?.souls[0]).toMatchObject({ source: 'global', rule: null, reason: null });
  });
});

describe('pairing approval (#66)', () => {
  const waiting: SandboxPairing[] = [
    { account: 'geniusbar-agent', kind: 'account', state: 'pending', code: 'K7M2PQ', at: '2026-10-07T20:00:00Z' },
    { account: 'geniusbar-agent', kind: 'daemon', state: 'pending', code: 'W3XY9Z', at: '2026-10-07T20:01:00Z' },
  ];

  it('lists who is waiting under the pair step and approves with one click', async () => {
    const source = fakeSource(status({ enabled: true }), waiting);
    withSandbox(source, <SandboxCard />);
    const list = await screen.findByRole('list', { name: 'Steps for you' });
    const pair = within(list).getAllByRole('listitem').at(-1)!;
    await within(pair).findByText(/^geniusbar-agent is waiting for your approval/);
    expect(within(pair).getByText(/The agent-bot daemon in geniusbar-agent is waiting/)).toBeTruthy();
    const approve = within(pair).getByRole('button', { name: 'Approve the pairing of geniusbar-agent, code K7M2PQ' });
    fireEvent.click(approve);
    await waitFor(() => expect(source.approve).toHaveBeenCalledWith('K7M2PQ'));
    // Approved: the broker no longer lists it as pending, so the row goes; the daemon's stays.
    await waitFor(() => expect(within(pair).queryByRole('button', { name: /code K7M2PQ/ })).toBeNull());
    expect(within(pair).getByRole('button', { name: /code W3XY9Z/ })).toBeTruthy();
    expect(source.pairings).toHaveBeenCalledTimes(2);
  });

  it('shows the broker’s refusal under the step and keeps the row', async () => {
    const source = fakeSource(status({ enabled: true }), waiting);
    source.approve.mockRejectedValueOnce(new BridgeError('pairing-expired', 'the code K7M2PQ has expired'));
    withSandbox(source, <SandboxCard />);
    fireEvent.click(await screen.findByRole('button', { name: /code K7M2PQ/ }));
    expect((await screen.findByRole('alert')).textContent).toBe('Not approved: the code K7M2PQ has expired');
    expect(screen.getByRole('button', { name: /code K7M2PQ/ })).toBeTruthy();
  });

  it('asks the broker only while the account is being set up, and shows the step alone when it cannot', async () => {
    const ready = fakeSource(status({ enabled: true, status: 'ready', steps: [] }), waiting);
    withSandbox(ready, <SandboxCard />);
    await screen.findByRole('switch', { name: 'Sandboxing' });
    await waitFor(() => expect(ready.status).toHaveBeenCalled());
    expect(ready.pairings).not.toHaveBeenCalled();
    cleanup();
    const broken = fakeSource(status({ enabled: true }), waiting);
    broken.pairings.mockRejectedValue(new BridgeError('sandbox-failed', 'agent-comms: broker not running'));
    withSandbox(broken, <SandboxCard />);
    const list = await screen.findByRole('list', { name: 'Steps for you' });
    await waitFor(() => expect(broken.pairings).toHaveBeenCalled());
    expect(within(list).queryByRole('button', { name: /Approve the pairing/ })).toBeNull();
    expect(within(list).getByText('Pair geniusbar-agent with the broker')).toBeTruthy();
  });

  it('reads the broker’s pairings as agent-comms prints them', () => {
    expect(normalizeSandboxPairings({ pairings: [
      { account: 'geniusbar-agent', uid: 503, state: 'pending', at: '2026-10-07T20:00:00Z', code: 'K7M2PQ' },
      { account: 'geniusbar-agent', kind: 'daemon', uid: 503, state: 'approved', at: '2026-10-07T20:01:00Z', hardened: true },
      { account: '', state: 'pending' },
    ] })).toEqual([
      { account: 'geniusbar-agent', kind: 'account', state: 'pending', code: 'K7M2PQ', at: '2026-10-07T20:00:00Z' },
      { account: 'geniusbar-agent', kind: 'daemon', state: 'approved', code: null, at: '2026-10-07T20:01:00Z' },
    ]);
    expect(normalizeSandboxPairings({})).toBeNull();
  });
});

describe('the agent-bot client', () => {
  it('asks the shell with the bridge commands and their arguments', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'sandbox_status') return status();
      if (command === 'sandbox_set') return { enabled: true, provider: 'standard_macos_account', account: 'geniusbar-agent' };
      if (command === 'sandbox_pairings') return { pairings: [] };
      if (command === 'sandbox_approve') return { account: 'geniusbar-agent', state: 'approved' };
      return soulRow('agent_1', { override: 'unrestricted', source: 'override' });
    });
    expect((await liveSandbox.status()).status).toBe('creating');
    await liveSandbox.set(true);
    expect((await liveSandbox.override('agent_1', 'unrestricted')).override).toBe('unrestricted');
    expect(await liveSandbox.pairings()).toEqual([]);
    expect(await liveSandbox.approve('K7M2PQ')).toEqual({ account: 'geniusbar-agent', state: 'approved' });
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['sandbox_status', {}],
      ['sandbox_set', { action: 'on' }],
      ['sandbox_override', { agent: 'agent_1', action: 'unrestricted' }],
      ['sandbox_pairings', {}],
      ['sandbox_approve', { code: 'K7M2PQ' }],
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

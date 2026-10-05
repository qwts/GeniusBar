import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { emptyComposer, mergeIncoming, emptyChat } from './model/chat';
import type { CensusRow } from './model/census';
import { inboxMessage, sampleCensus, sampleConnection } from './model/fixtures';
import { idleSetup } from './model/setup';
import { disconnected } from './model/status';
import { LAYOUT_KEY, layoutActions } from './state/layout';
import { preferenceActions } from './state/preferences';
import type { ChatApi } from './useChat';
import type { LaunchApi } from './useLaunch';

afterEach(() => { cleanup(); globalThis.localStorage?.clear(); layoutActions.forget(); preferenceActions.forget(); });

// luna's team with a subagent of its own, so a hidden lead can leave
// several descendants behind it.
const nestedCensus: readonly CensusRow[] = [
  ...sampleCensus.filter((soul) => soul.agentId !== 'agent_gone'),
  {
    account: 'user',
    agentId: 'agent_k',
    name: 'kiro',
    harness: 'claude',
    parent: 'agent_c',
    presence: 'joined',
    unacked: 0,
    lastWake: null,
  },
];

describe('App', () => {
  it('shows the header and an empty roster before the bridge connects', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'GeniusBar' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/connecting/i);
    expect(screen.getByRole('region', { name: 'Fleet' }).childElementCount).toBe(0);
  });

  it('renders the fixed fake census and health, nested, with every soul', () => {
    // SnapshotTests.rendersPNG: the populated roster must actually draw
    // rows that the same header with an empty roster does not.
    render(<App census={sampleCensus} connection={sampleConnection} isStatic />);
    expect(screen.getByRole('status', { name: 'Connected' }).textContent).toBe('Connected');
    const roster = screen.getByRole('region', { name: 'Fleet' });
    expect(roster.querySelectorAll('button.companion-row')).toHaveLength(3);
    cleanup();
    render(<App connection={sampleConnection} isStatic />);
    expect(screen.getByRole('region', { name: 'Fleet' }).textContent).toBe('No companions yet. Your first companion will appear here.');
  });

  it('opens a companion as a session in the popup, and goes back to the fleet', () => {
    render(<App census={sampleCensus} connection={sampleConnection} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: /^agent_c,/ }));
    const session = screen.getByRole('region', { name: 'agent_c, agent_c' });
    expect(screen.queryByRole('region', { name: 'Fleet' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Back to fleet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to fleet' }));
    expect(screen.queryByRole('region', { name: 'agent_c, agent_c' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^agent_c,/ }));
    fireEvent.keyDown(screen.getByRole('region', { name: 'agent_c, agent_c' }), { key: 'Escape' });
    expect(screen.getByRole('region', { name: 'Fleet' })).toBeTruthy();
    expect(session.isConnected).toBe(false);
  });

  it('opens the detail it is told to select, for --snapshot-detail', () => {
    render(<App census={sampleCensus} connection={sampleConnection} isStatic select="user/agent_c" />);
    expect(screen.getByRole('region', { name: 'agent_c, agent_c' })).toBeTruthy();
  });

  it('keeps the last census on screen while the broker is unreachable', () => {
    const lastRefresh = new Date(2026, 0, 1, 12, 0, 1);
    const onRefresh = vi.fn();
    render(
      <App
        census={sampleCensus}
        connection={{ ...sampleConnection, brokerUnreachable: true, lastRefresh, lastError: 'cannot reach the broker' }}
        onRefresh={onRefresh}
        isStatic
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('Can’t reach the background service');
    expect(screen.getAllByText(`Last updated · ${lastRefresh.toLocaleTimeString()}`)).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /Ready|Starting|Unavailable/ })).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('shows unread counts on rows and opens the conversation, marking it read', () => {
    const { state } = mergeIncoming(emptyChat, [
      inboxMessage('msg_1', 1, 'hello', { account: 'user', agentId: 'agent_c' }),
      inboxMessage('msg_2', 2, 'again', { account: 'user', agentId: 'agent_c' }),
    ]);
    const chat: ChatApi = { chat: state, composers: {}, open: vi.fn(), setDraft: vi.fn(), send: vi.fn() };
    render(<App census={sampleCensus} connection={sampleConnection} isStatic chat={chat} />);
    const row = screen.getByRole('button', { name: /^agent_c,.*2 unread messages/ });
    expect(row.textContent).toContain('2 new');
    expect(chat.open).toHaveBeenLastCalledWith(null);
    fireEvent.click(row);
    expect(chat.open).toHaveBeenLastCalledWith('user/agent_c');
    const session = screen.getByRole('region', { name: 'agent_c, agent_c' });
    expect(session.textContent).toContain('hello');
    fireEvent.change(screen.getByRole('textbox', { name: 'Message to agent_c' }), { target: { value: 'yo' } });
    expect(chat.setDraft).toHaveBeenCalledWith('user/agent_c', 'yo');
    expect(chat.composers['user/agent_c'] ?? emptyComposer).toEqual(emptyComposer);
    fireEvent.click(screen.getByRole('button', { name: 'Back to fleet' }));
    expect(chat.open).toHaveBeenLastCalledWith(null);
  });
});

describe('App setup', () => {
  it('replaces the roster with the setup panel while setup is needed', () => {
    const unpaired = { ...disconnected, bridgeConnected: true, unpaired: true };
    render(<App connection={unpaired} setup={idleSetup} onSetup={() => {}} />);
    expect(screen.getByRole('region', { name: 'Setup' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Fleet' })).toBeNull();
    expect(screen.queryByText('No souls on this machine.')).toBeNull();
  });

  it('launches a selected soul with its account and harness filled in', () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    render(<App census={sampleCensus} connection={sampleConnection} launcher={launcher} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: /^luna,/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Launch…' }));
    const form = screen.getByRole('form', { name: /^Launch / });
    expect((screen.getByLabelText('Account') as HTMLInputElement).value).toBe('user');
    expect((screen.getByLabelText('Harness') as HTMLInputElement).value).toBe('codex');
    fireEvent.submit(form);
    expect(launcher.launch).toHaveBeenCalledWith({ account: 'user', target: { soul: 'agent_p' }, harness: 'codex', name: '' });
    // agent-bot could not say what this soul's comms is, so the launch leaves it alone.
    expect(screen.queryByRole('switch', { name: 'Agent comms' })).toBeNull();
  });

  it('prefills the default harness, and still launches any harness typed in', () => {
    preferenceActions.setDefaultHarness('opencode');
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    render(<App census={sampleCensus} connection={sampleConnection} launcher={launcher} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: 'Launch package…' }));
    const harness = screen.getByLabelText('Harness') as HTMLInputElement;
    expect(harness.value).toBe('opencode');
    // The list only suggests: a harness that is in neither the census nor the known list still launches.
    const suggested = [...document.getElementById(harness.getAttribute('list')!)!.querySelectorAll('option')].map((o) => o.value);
    expect(suggested).toEqual(expect.arrayContaining(['claude', 'opencode', 'muse', 'codex']));
    expect(suggested).not.toContain('my-own-harness');
    fireEvent.change(screen.getByLabelText('Package'), { target: { value: '/souls/helper' } });
    fireEvent.change(harness, { target: { value: 'my-own-harness' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Launch a companion package' }));
    expect(launcher.launch).toHaveBeenCalledWith({ account: 'user', target: { package: '/souls/helper' }, harness: 'my-own-harness', name: '', comms: true });
  });

  it('launches with agent comms on by default, or off when turned off first (#71)', () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    render(<App census={sampleCensus} connection={sampleConnection} launcher={launcher} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: 'Launch package…' }));
    const comms = screen.getByRole('switch', { name: 'Agent comms' }) as HTMLInputElement;
    expect(comms.checked).toBe(true);
    fireEvent.click(comms);
    fireEvent.change(screen.getByLabelText('Package'), { target: { value: '/souls/helper' } });
    fireEvent.change(screen.getByLabelText('Harness'), { target: { value: 'claude' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Launch a companion package' }));
    expect(launcher.launch).toHaveBeenCalledWith({ account: 'user', target: { package: '/souls/helper' }, harness: 'claude', name: '', comms: false });
  });

  it('launches a package from the footer, and shows a refusal inline', () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    const { rerender } = render(<App census={sampleCensus} connection={sampleConnection} launcher={launcher} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: 'Launch package…' }));
    fireEvent.change(screen.getByLabelText('Package'), { target: { value: '/souls/helper' } });
    fireEvent.change(screen.getByLabelText('Harness'), { target: { value: 'claude' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Launch a companion package' }));
    expect(launcher.launch).toHaveBeenCalledWith({ account: 'user', target: { package: '/souls/helper' }, harness: 'claude', name: '', comms: true });
    const refused: LaunchApi = { ...launcher, state: { phase: 'error', requestId: null, text: 'GeniusBar can’t reach the agents on account user. Make sure setup has finished, then try again.' } };
    rerender(<App census={sampleCensus} connection={sampleConnection} launcher={refused} isStatic />);
    expect(screen.getByRole('alert').textContent).toMatch(/can’t reach the agents/i);
  });

  it('shows a friendly error when an opened soul package cannot be read', () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    render(<App census={sampleCensus} connection={sampleConnection} launcher={launcher}
      openedPackage={{ id: 1, path: '/Downloads/broken.soul', checking: false,
        error: 'GeniusBar couldn’t read this soul package. Check that it’s accessible and contains a soul.json file, then try again.' }}
      isStatic />);
    expect((screen.getByLabelText('Package') as HTMLInputElement).value).toBe('/Downloads/broken.soul');
    expect(screen.getByRole('alert').textContent).toMatch(/couldn’t read this soul package/i);
  });

  it('blocks launching an unreadable opened package until its path is edited', () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    render(<App census={sampleCensus} connection={sampleConnection} launcher={launcher}
      openedPackage={{ id: 1, path: '/Downloads/broken.soul', checking: false, error: 'unreadable' }} isStatic />);
    const form = screen.getByRole('form', { name: 'Launch a companion package' });
    expect((screen.getByRole('button', { name: 'Launch' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(form);
    expect(launcher.launch).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Package'), { target: { value: '/souls/helper' } });
    expect((screen.getByRole('button', { name: 'Launch' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.submit(form);
    expect(launcher.launch).toHaveBeenCalledOnce();
  });

  it('lets the first companion start with agent comms off (#71)', () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    const starter = { package: '/App/souls/starter.soul', account: 'friend', name: 'Starter', harnesses: ['claude'], devTools: true };
    render(<App census={[]} connection={sampleConnection} launcher={launcher} starter={starter} isStatic />);
    const comms = screen.getByRole('switch', { name: 'Agent comms' }) as HTMLInputElement;
    expect(comms.checked).toBe(true);
    fireEvent.click(comms);
    fireEvent.submit(screen.getByRole('form', { name: 'Start with Starter' }));
    expect(launcher.launch).toHaveBeenCalledWith({ account: 'friend', target: { package: '/App/souls/starter.soul' }, harness: 'claude', name: 'Starter', comms: false });
  });

  it('opens the companion, not a new launch, for an installed soul opened from Finder (#80)', () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    render(<App census={sampleCensus} connection={sampleConnection} launcher={launcher}
      openedPackage={{ id: 1, path: '/souls/Luna - Starter.soul', checking: false, error: null, agentId: 'agent_p' }} isStatic />);
    expect(screen.getByRole('region', { name: /^luna,/ })).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Launch a companion package' })).toBeNull();
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it('switches from the package form to the companion once the opened folder is located (#80)', () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    const path = '/souls/Luna - Starter.soul';
    const { rerender } = render(<App census={sampleCensus} connection={sampleConnection} launcher={launcher}
      openedPackage={{ id: 1, path, checking: true, error: null }} isStatic />);
    expect(screen.getByRole('form', { name: 'Launch a companion package' })).toBeTruthy();
    rerender(<App census={sampleCensus} connection={sampleConnection} launcher={launcher}
      openedPackage={{ id: 1, path, checking: false, error: null, agentId: 'agent_p' }} isStatic />);
    expect(screen.getByRole('region', { name: /^luna,/ })).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Launch a companion package' })).toBeNull();
  });

  it('refuses to launch a copied soul folder and says why (#80)', () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    render(<App census={sampleCensus} connection={sampleConnection} launcher={launcher}
      openedPackage={{ id: 1, path: '/souls/Luna copy.soul', checking: false,
        error: '/souls/Luna copy.soul is a copy of soul agent_p, whose folder is /souls/Luna.soul; open that soul instead and remove the copy' }} isStatic />);
    expect(screen.getByRole('alert').textContent).toMatch(/is a copy of soul agent_p/);
    expect((screen.getByRole('button', { name: 'Launch' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByRole('form', { name: 'Launch a companion package' }));
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it('keeps contact AutoFill off the launch name field (#80)', () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    render(<App census={sampleCensus} connection={sampleConnection} launcher={launcher} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: 'Launch package…' }));
    expect(screen.getByLabelText('Name').getAttribute('autocomplete')).toBe('off');
  });

  it('opens an empty manual form after an opened package is closed', () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    render(<App census={sampleCensus} connection={sampleConnection} launcher={launcher}
      openedPackage={{ id: 1, path: '/Downloads/broken.soul', checking: false, error: 'unreadable' }} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Launch package…' }));
    expect((screen.getByLabelText('Package') as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('offers the starter soul on an empty roster and launches it with its default harness', () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    const starter = { package: '/App/souls/starter.soul', account: 'friend', name: 'Starter', harnesses: ['claude', 'codex'], devTools: true };
    const { rerender } = render(<App census={[]} connection={sampleConnection} launcher={launcher} starter={starter} isStatic />);
    expect((screen.getByLabelText('Harness') as HTMLInputElement).value).toBe('claude');
    fireEvent.click(screen.getByRole('button', { name: 'Start with Starter' }));
    expect(launcher.launch).toHaveBeenCalledWith({ account: 'friend', target: { package: '/App/souls/starter.soul' }, harness: 'claude', name: 'Starter', comms: true });
    const failed: LaunchApi = { ...launcher, state: { phase: 'failed', requestId: 'r1', agentId: null, detail: 'harness not installed' } };
    rerender(<App census={[]} connection={sampleConnection} launcher={failed} starter={starter} isStatic />);
    expect(screen.getByRole('alert').textContent).toMatch(/harness not installed/);
  });

  it('after the starter launches, stays open while the roster fills and signs in to the harness', async () => {
    const starter = { package: '/App/souls/starter.soul', account: 'friend', name: 'Starter', harnesses: ['claude'], devTools: true };
    const idle: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    let signedIn = false;
    const auth = vi.fn(async (action: 'status' | 'login') => { if (action === 'login') signedIn = true; return { loggedIn: signedIn }; });
    const { rerender } = render(<App census={[]} connection={sampleConnection} launcher={idle} starter={starter} harnessAuth={auth} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: 'Start with Starter' }));
    const launched: LaunchApi = { ...idle, state: { phase: 'launched', requestId: 'r1', agentId: 'agent_s' } };
    rerender(<App census={sampleCensus} connection={sampleConnection} launcher={launched} starter={starter} harnessAuth={auth} isStatic />);
    const signIn = await screen.findByRole('button', { name: 'Sign in to Claude' });
    expect(auth).toHaveBeenCalledWith('status', 'claude', 'agent_s');
    fireEvent.click(signIn);
    await waitFor(() => expect(screen.getByText(/Ready\. Open the companion/)).toBeTruthy());
    expect(auth).toHaveBeenCalledWith('login', 'claude', 'agent_s');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Your first companion' })).toBeNull();
  });

  it('asks for Apple developer tools before the starter can launch', async () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    const starter = { package: '/App/souls/starter.soul', account: 'friend', name: 'Starter', harnesses: ['claude'], devTools: false };
    const devTools = { install: vi.fn(async () => {}), recheck: vi.fn() };
    const { rerender } = render(<App census={[]} connection={sampleConnection} launcher={launcher} starter={starter} devTools={devTools} isStatic />);
    expect(screen.queryByRole('button', { name: 'Start with Starter' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Install developer tools' }));
    expect(devTools.install).toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: "I've installed them" }));
    expect(devTools.recheck).toHaveBeenCalled();
    rerender(<App census={[]} connection={sampleConnection} launcher={launcher} starter={{ ...starter, devTools: true }} devTools={devTools} isStatic />);
    expect(screen.getByRole('button', { name: 'Start with Starter' })).toBeTruthy();
  });

  it('keeps the plain empty text when the starter soul is not offered', () => {
    render(<App census={[]} connection={sampleConnection} isStatic />);
    expect(screen.queryByRole('form', { name: 'Start with Starter' })).toBeNull();
    expect(screen.getByText('No companions yet. Your first companion will appear here.')).toBeTruthy();
  });

  it('offers no launch without a launcher', () => {
    render(<App census={sampleCensus} connection={sampleConnection} isStatic />);
    expect(screen.queryByRole('button', { name: 'Launch package…' })).toBeNull();
  });

  it('shows update states in the panel and acts on them (#34)', () => {
    const act = vi.fn();
    const updates = { status: { state: 'available' as const, version: '0.1.1' }, act };
    render(<App census={sampleCensus} connection={sampleConnection} updates={updates} isStatic />);
    expect(screen.getByRole('status', { name: 'Update' }).textContent).toContain('GeniusBar 0.1.1 is available.');
    fireEvent.click(screen.getByRole('button', { name: 'Install and restart' }));
    expect(act).toHaveBeenCalledOnce();
    // While the update needs action, the footer check hides.
    expect(screen.queryByRole('button', { name: 'Check for Updates…' })).toBeNull();
    cleanup();
    render(<App connection={sampleConnection} updates={{ ...updates, status: { state: 'idle', version: null } }} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: 'Check for Updates…' }));
    expect(act).toHaveBeenCalledTimes(2);
    cleanup();
    render(<App connection={sampleConnection} updates={{ ...updates, status: { state: 'disabled', version: null } }} isStatic />);
    expect(screen.queryByRole('button', { name: 'Check for Updates…' })).toBeNull();
  });

  it('keeps the update line above an open companion session in the popup', () => {
    const act = vi.fn();
    const updates = { status: { state: 'available' as const, version: '0.1.1' }, act };
    render(<App census={sampleCensus} connection={sampleConnection} updates={updates} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: /^agent_c,/ }));
    expect(screen.getByRole('region', { name: 'agent_c, agent_c' })).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Update' }).textContent).toContain('GeniusBar 0.1.1 is available.');
    fireEvent.click(screen.getByRole('button', { name: 'Install and restart' }));
    expect(act).toHaveBeenCalledOnce();
  });

  it('shows an update or an error beside the closed window-mode menu, and opens it', () => {
    const updates = { status: { state: 'available' as const, version: '0.1.1' }, act: () => {} };
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} updates={updates} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: 'GeniusBar 0.1.1 is available.' }));
    expect(screen.getByRole('dialog', { name: 'GeniusBar menu' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'GeniusBar 0.1.1 is available.' })).toBeNull();
    cleanup();
    render(<App mode="window" census={sampleCensus} isStatic
      connection={{ ...sampleConnection, lastError: 'Could not read the census.' }} />);
    expect(screen.queryByRole('dialog', { name: 'GeniusBar menu' })).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('Could not read the census.');
  });

  it('removes services only after the owner confirms, and shows a failure inline', async () => {
    const onRemove = vi.fn<() => Promise<void>>(async () => { throw new Error('launchctl would not unload'); });
    render(<App connection={sampleConnection} onRemoveServices={onRemove} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove services…' }));
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: 'Remove services' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove services…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'launchctl would not unload');
    onRemove.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Services removed.')).toBeTruthy();
    expect(onRemove).toHaveBeenCalledTimes(2);
  });
});

describe('App window mode', () => {
  const desktop = () => screen.getByRole('main', { name: 'Fleet' });

  it('lays out one card per team and opens a companion in a window', () => {
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic />);
    expect(within(desktop()).getByRole('region', { name: 'luna' })).toBeTruthy();
    expect(within(desktop()).getByRole('region', { name: 'old' })).toBeTruthy();
    fireEvent.click(within(desktop()).getByRole('button', { name: /^agent_c,/ }));
    const win = screen.getByRole('dialog', { name: 'agent_c' });
    expect(within(win).getByRole('region', { name: 'agent_c, agent_c' })).toBeTruthy();
    expect(within(win).queryByRole('button', { name: 'Back to fleet' })).toBeNull();
    expect(document.activeElement).toBe(within(win).getByRole('button', { name: 'Close window' }));
    fireEvent.click(within(win).getByRole('button', { name: 'Close window' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the menu from the toolbar, and hides companions from the desktop', () => {
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic />);
    expect(screen.queryByRole('dialog', { name: 'GeniusBar menu' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'GeniusBar menu' }));
    const menu = screen.getByRole('dialog', { name: 'GeniusBar menu' });
    fireEvent.click(within(menu).getByRole('button', { name: 'Hide from desktop: agent_c' }));
    expect(within(desktop()).queryByRole('button', { name: /^agent_c,/ })).toBeNull();
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!).hidden).toEqual(['user/agent_c']);
    // Still listed in the menu, and still opens from there.
    expect(within(menu).getByRole('button', { name: /^agent_c,/ })).toBeTruthy();
    fireEvent.click(within(menu).getByRole('button', { name: 'Show all hidden (1)' }));
    expect(within(desktop()).getByRole('button', { name: /^agent_c,/ })).toBeTruthy();
    fireEvent.keyDown(within(menu).getByRole('searchbox'), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'GeniusBar menu' })).toBeNull();
  });

  it('jumps to a companion from the View menu or ⌘K palette', () => {
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'View' })).getByRole('menuitem', { name: /Jump to companion/ }));
    const palette = screen.getByRole('dialog', { name: 'Jump to companion' });
    fireEvent.change(within(palette).getByRole('textbox', { name: 'Search companions…' }), { target: { value: 'agent_c' } });
    fireEvent.click(within(palette).getByRole('button', { name: /agent_c/ }));
    expect(screen.queryByRole('dialog', { name: 'Jump to companion' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'agent_c' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const again = screen.getByRole('dialog', { name: 'Jump to companion' });
    fireEvent.change(within(again).getByRole('textbox'), { target: { value: 'nobody' } });
    expect(within(again).getByText('No companions found')).toBeTruthy();
    fireEvent.keyDown(within(again).getByRole('textbox'), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Jump to companion' })).toBeNull();
  });

  it('closes open menus under ⌘K, keeps Tab in the palette, and restores focus', () => {
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic />);
    const item = screen.getByRole('button', { name: 'GeniusBar menu' });
    fireEvent.click(item);
    expect(screen.getByRole('dialog', { name: 'GeniusBar menu' })).toBeTruthy();
    item.focus();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.queryByRole('dialog', { name: 'GeniusBar menu' })).toBeNull();
    const palette = screen.getByRole('dialog', { name: 'Jump to companion' });
    const stops = [within(palette).getByRole('textbox'), ...within(palette).getAllByRole('button')];
    stops[stops.length - 1].focus();
    fireEvent.keyDown(stops[stops.length - 1], { key: 'Tab' });
    expect(document.activeElement).toBe(stops[0]);
    fireEvent.keyDown(stops[0], { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(stops[stops.length - 1]);
    fireEvent.keyDown(stops[0], { key: 'Escape' });
    expect(document.activeElement).toBe(item);
  });

  it('describes the unread count on the GeniusBar item', () => {
    const { state } = mergeIncoming(emptyChat, [
      inboxMessage('msg_1', 1, 'hello', { account: 'user', agentId: 'agent_c' }),
      inboxMessage('msg_2', 2, 'again', { account: 'user', agentId: 'agent_c' }),
    ]);
    const chat: ChatApi = { chat: state, composers: {}, open: vi.fn(), setDraft: vi.fn(), send: vi.fn() };
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic chat={chat} />);
    const item = screen.getByRole('button', { name: 'GeniusBar menu' });
    expect(document.getElementById(item.getAttribute('aria-describedby')!)?.textContent).toBe('2 new');
  });

  it('resets the desktop layout from the View menu', () => {
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic />);
    fireEvent.click(within(desktop()).getByRole('button', { name: 'Collapse team' }));
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reset desktop layout' }));
    expect(screen.queryByRole('menu', { name: 'View' })).toBeNull();
    expect(within(desktop()).getAllByRole('button', { name: 'Collapse team' }).length).toBeGreaterThan(0);
  });

  it('opens the launch form from the desktop, and slims a solo card', () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} launcher={launcher} isStatic />);
    expect(within(desktop()).getByRole('region', { name: 'old' }).style.width).toBe('200px');
    expect(within(desktop()).getByRole('region', { name: 'luna' }).style.width).toBe('300px');
    fireEvent.click(within(desktop()).getByRole('button', { name: 'Launch companion' }));
    const menu = screen.getByRole('dialog', { name: 'GeniusBar menu' });
    expect(within(menu).getByRole('region', { name: 'Launch a companion package' })).toBeTruthy();
  });

  it('has no Launch button without a launcher', () => {
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic />);
    expect(within(desktop()).queryByRole('button', { name: 'Launch companion' })).toBeNull();
  });

  it('keeps the Launch button on an empty desktop', () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    render(<App mode="window" census={[]} connection={sampleConnection} launcher={launcher} isStatic />);
    expect(within(desktop()).queryByRole('region')).toBeNull();
    expect(within(desktop()).getByRole('button', { name: 'Launch companion' })).toBeTruthy();
  });

  it('shows the unread count on a card, capped at 9+', () => {
    const messages = (n: number) => Array.from({ length: n }, (_, i) =>
      inboxMessage(`msg_${i + 1}`, i + 1, 'hello', { account: 'user', agentId: 'agent_c' }));
    const chatWith = (n: number): ChatApi => ({
      chat: mergeIncoming(emptyChat, messages(n)).state, composers: {}, open: vi.fn(), setDraft: vi.fn(), send: vi.fn(),
    });
    const { unmount } = render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic chat={chatWith(2)} />);
    const card = () => within(desktop()).getByRole('button', { name: /^agent_c,/ });
    expect(card().getAttribute('aria-label')).toContain('2 unread messages');
    expect(within(card()).getByText('2')).toBeTruthy();
    unmount();
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic chat={chatWith(12)} />);
    expect(card().getAttribute('aria-label')).toContain('12 unread messages');
    expect(within(card()).getByText('9+')).toBeTruthy();
  });

  it('collapses a team and remembers it', () => {
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic />);
    const collapse = within(desktop()).getByRole('button', { name: 'Collapse team' });
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(collapse);
    expect(within(desktop()).queryByRole('button', { name: /^agent_c,/ })).toBeNull();
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!).collapsed).toEqual(['user/agent_p']);
    fireEvent.click(within(desktop()).getByRole('button', { name: 'Expand team' }));
    expect(within(desktop()).getByRole('button', { name: /^agent_c,/ })).toBeTruthy();
  });

  it('replaces a hidden team lead with a neutral placeholder, keeping its subagents reachable', () => {
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: 'GeniusBar menu' }));
    const menu = screen.getByRole('dialog', { name: 'GeniusBar menu' });
    fireEvent.click(within(menu).getByRole('button', { name: 'Hide from desktop: luna' }));
    // The hidden lead leaves nothing behind: no avatar, no name, no harness,
    // and no longer the card's accessible name either.
    const card = within(desktop()).getByRole('region', { name: 'Team' });
    expect(card.textContent).not.toMatch(/luna|codex/i);
    expect(within(card).queryByRole('button', { name: /^luna,/ })).toBeNull();
    expect(within(desktop()).queryByRole('region', { name: 'luna' })).toBeNull();
    // Only what reaches the visible subagent is left, and it still opens.
    expect(card.textContent).toContain('1 subagent');
    fireEvent.click(within(card).getByRole('button', { name: /^agent_c,/ }));
    expect(screen.getByRole('dialog', { name: 'agent_c' })).toBeTruthy();
    // Collapsing the card still folds its subagent away.
    fireEvent.click(within(card).getByRole('button', { name: 'Collapse team' }));
    expect(within(card).queryByRole('button', { name: /^agent_c,/ })).toBeNull();
  });

  it('counts the subagents hidden under a hidden lead, and drops the card once all are hidden', () => {
    render(<App mode="window" census={nestedCensus} connection={sampleConnection} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: 'GeniusBar menu' }));
    const menu = screen.getByRole('dialog', { name: 'GeniusBar menu' });
    fireEvent.click(within(menu).getByRole('button', { name: 'Hide from desktop: luna' }));
    fireEvent.click(within(menu).getByRole('button', { name: 'Hide from desktop: agent_c' }));
    const card = within(desktop()).getByRole('region', { name: 'Team' });
    expect(card.textContent).toContain('2 subagents · 1 hidden');
    expect(within(card).queryByRole('button', { name: /^agent_c,/ })).toBeNull();
    expect(within(card).getByRole('button', { name: /^kiro,/ })).toBeTruthy();
    fireEvent.click(within(menu).getByRole('button', { name: 'Hide from desktop: kiro' }));
    expect(within(desktop()).queryByRole('region', { name: 'Team' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'luna' })).toBeNull();
    fireEvent.click(within(menu).getByRole('button', { name: 'Show all hidden (3)' }));
    expect(within(desktop()).getByRole('region', { name: 'luna' })).toBeTruthy();
  });

  it('hides and shows a whole team from the menu, beside the lead-only eye', () => {
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: 'GeniusBar menu' }));
    const menu = screen.getByRole('dialog', { name: 'GeniusBar menu' });
    expect(within(menu).getByRole('button', { name: 'Hide from desktop: luna' })).toBeTruthy();
    fireEvent.click(within(menu).getByRole('button', { name: 'Hide team from desktop: luna' }));
    expect(within(desktop()).queryByRole('region', { name: 'Team' })).toBeNull();
    expect(within(desktop()).queryByRole('region', { name: 'luna' })).toBeNull();
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!).hidden).toEqual(['user/agent_p', 'user/agent_c']);
    fireEvent.click(within(menu).getByRole('button', { name: 'Show team on desktop: luna' }));
    expect(within(desktop()).getByRole('region', { name: 'luna' })).toBeTruthy();
  });

  it('opens the menu on its own while setup is needed', () => {
    const unpaired = { ...disconnected, bridgeConnected: true, unpaired: true };
    render(<App mode="window" connection={unpaired} setup={idleSetup} onSetup={() => {}} />);
    expect(desktop().textContent).toContain('Open the GeniusBar menu above to set up.');
    const menu = screen.getByRole('dialog', { name: 'GeniusBar menu' });
    expect(within(menu).getByRole('region', { name: 'Setup' })).toBeTruthy();
  });
});

describe('App language', () => {
  it('switches to Spanish and remembers the choice', () => {
    render(<App census={sampleCensus} connection={sampleConnection} isStatic />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Language' }), { target: { value: 'es' } });
    expect(screen.getByRole('region', { name: 'Flota' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^luna, codex, Listo$/ })).toBeTruthy();
    expect(localStorage.getItem('gb.lang')).toBe('es');
    cleanup();
    render(<App census={sampleCensus} connection={sampleConnection} isStatic />);
    expect(screen.getByRole('combobox', { name: 'Idioma' })).toHaveProperty('value', 'es');
  });

  it('localizes the placeholder a hidden team lead leaves behind', () => {
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: 'GeniusBar menu' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Language' }), { target: { value: 'es' } });
    const menu = screen.getByRole('dialog', { name: 'Menú de GeniusBar' });
    fireEvent.click(within(menu).getByRole('button', { name: 'Ocultar del escritorio: luna' }));
    const card = within(screen.getByRole('main', { name: 'Flota' })).getByRole('region', { name: 'Equipo' });
    expect(card.textContent).toContain('1 subagente');
    expect(card.textContent).not.toMatch(/luna|codex/i);
  });
});


describe('CLI tools and migration in the rebuilt shell', () => {
  it.each(['tray', 'window'] as const)('keeps both actions and translates them in %s mode', async (mode) => {
    const onSetup = vi.fn();
    const cliTools = {
      status: vi.fn(async () => ({ dir: '/Users/me/.local/bin', tools: [{ name: 'agent-bot', state: 'absent' as const }] })),
      install: vi.fn(), uninstall: vi.fn(),
    };
    render(<App mode={mode} connection={{ ...disconnected, bridgeConnected: true, unpaired: true }}
      setup={idleSetup} onSetup={onSetup} cliTools={cliTools} existingServices={{
        broker: { label: 'broker', program: [], version: '0.3.1', homebrew: true, state: 'stopped' },
        daemon: { label: 'daemon', program: [], version: null, homebrew: true, state: 'running' },
      }} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Language' }), { target: { value: 'es' } });
    expect(screen.getByRole('region', { name: 'Configuración' })).toBeTruthy();
    expect(screen.getByRole('note').textContent).toContain('agent-comms 0.3.1 (detenido) y agent-bot (en ejecución) de Homebrew');
    expect(screen.getByRole('note').textContent).toContain('se reinician los servicios que estaban en ejecución');
    expect(screen.getByText('Iniciar tus agentes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Trasladar a GeniusBar' }));
    expect(onSetup).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'Conservarlos' }));
    expect(onSetup).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'Herramientas de línea de comandos…' }));
    await screen.findByRole('button', { name: 'Instalar' });
    expect(cliTools.status).toHaveBeenCalledOnce();
  });
});

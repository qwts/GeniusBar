import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { emptyComposer, mergeIncoming, emptyChat } from './model/chat';
import { inboxMessage, sampleCensus, sampleConnection } from './model/fixtures';
import { idleSetup } from './model/setup';
import { disconnected } from './model/status';
import { LAYOUT_KEY, layoutActions } from './state/layout';
import type { ChatApi } from './useChat';
import type { LaunchApi } from './useLaunch';

afterEach(() => { cleanup(); globalThis.localStorage?.clear(); layoutActions.forget(); });

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
  });

  it('launches a package from the footer, and shows a refusal inline', () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    const { rerender } = render(<App census={sampleCensus} connection={sampleConnection} launcher={launcher} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: 'Launch package…' }));
    fireEvent.change(screen.getByLabelText('Package'), { target: { value: '/souls/helper' } });
    fireEvent.change(screen.getByLabelText('Harness'), { target: { value: 'claude' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Launch a companion package' }));
    expect(launcher.launch).toHaveBeenCalledWith({ account: 'user', target: { package: '/souls/helper' }, harness: 'claude', name: '' });
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
    expect(launcher.launch).toHaveBeenCalledWith({ account: 'friend', target: { package: '/App/souls/starter.soul' }, harness: 'claude', name: 'Starter' });
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
});

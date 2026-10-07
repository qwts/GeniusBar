import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { AuditSourceContext } from './components/AuditLog';
import { emptyComposer, mergeIncoming, emptyChat } from './model/chat';
import type { CensusRow } from './model/census';
import { inboxMessage, sampleCensus, sampleConnection, sampleTemplates } from './model/fixtures';
import { noBadges } from './model/refresh';
import { idleSetup } from './model/setup';
import { disconnected, formatTime } from './model/status';
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
    expect(screen.getByRole('region', { name: 'Fleet' }).textContent).toBe('No companions yet. Launch one to get started.');
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

  it('keeps the healthy header to the name and counts, the footer to failures, and the empty line in Tailwind (N5, N6, N7)', () => {
    const lastRefresh = new Date(2026, 0, 1, 9, 5, 0);
    render(<App connection={{ ...sampleConnection, lastRefresh }} isStatic />);
    const header = screen.getByRole('heading', { name: 'GeniusBar' }).closest('header')!;
    expect(within(header).getByRole('status', { name: 'Connected' }).className).toBe('sr-only');
    expect(header.querySelector('.dot')).toBeNull();
    expect(screen.queryByText(/^Updated /)).toBeNull();
    expect(screen.getByText('No companions yet. Launch one to get started.').className).toBe('m-0 px-3 py-2 text-sm text-muted-foreground');
    cleanup();
    render(<App connection={{ ...sampleConnection, lastRefresh, lastError: 'Could not read the census.' }} isStatic />);
    expect(screen.getByRole('alert').textContent).toBe('Could not read the census.');
    expect(screen.getByRole('alert').className).toContain('text-destructive');
  });

  it('puts freshness in the G’s title in window mode (N6)', () => {
    const lastRefresh = new Date(2026, 0, 1, 9, 5, 0);
    render(<App mode="window" connection={{ ...sampleConnection, lastRefresh }} isStatic />);
    expect(screen.getByRole('button', { name: 'GeniusBar menu' }).title).toBe(`Connected · Updated ${formatTime(lastRefresh)}`);
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
    // The header says when; the footer row shows only failures now (N6), and the time is hour:minute (P2-b).
    expect(screen.getAllByText(`Last updated · ${formatTime(lastRefresh)}`)).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /Ready|Starting|Offline/ })).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh' }));
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
    fireEvent.change(screen.getByRole('textbox', { name: 'Message agent_c' }), { target: { value: 'yo' } });
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

  it('gives the whole menu to setup, with the design’s links (Lovable SetupPanel)', () => {
    const unpaired = { ...disconnected, bridgeConnected: true, unpaired: true };
    const onRefresh = vi.fn();
    render(<App connection={unpaired} setup={idleSetup} onSetup={() => {}} onRefresh={onRefresh} onRemoveServices={vi.fn(async () => {})} />);
    expect(screen.getByText('GeniusBar needs setup on this device. Choose Set up below.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Waiting for your approval' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onRefresh).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Remove services…' }));
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
  });

  it('during setup the footer is only the design’s links, with the language at the end (P2-a)', () => {
    const unpaired = { ...disconnected, bridgeConnected: true, unpaired: true };
    const updates = { status: { state: 'up-to-date' as const, version: null }, act: vi.fn() };
    const { unmount } = render(<App connection={unpaired} setup={idleSetup} onSetup={() => {}} onRefresh={vi.fn()} updates={updates} />);
    expect(screen.queryByRole('button', { name: 'Sound cues' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Audit log' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Launch companion' })).toBeNull();
    const language = screen.getByRole('combobox', { name: 'Language' });
    expect(language.closest('div.p-3')?.textContent).toContain('Refresh');
    expect(screen.queryByRole('status', { name: 'Update' })).toBeNull();
    unmount();
    // An update to install, or a failed one, still shows, after the steps.
    render(<App connection={unpaired} setup={idleSetup} onSetup={() => {}} updates={{ ...updates, status: { state: 'available', version: '0.1.1' } }} />);
    const notice = screen.getByRole('status', { name: 'Update' });
    expect(screen.getByRole('region', { name: 'Setup' }).compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the fleet, not setup, while installed services are starting (#118)', () => {
    const starting = { ...disconnected, bridgeConnected: true, brokerUnreachable: true, starting: true };
    render(<App connection={starting} setup={idleSetup} onSetup={() => {}} />);
    expect(screen.queryByRole('region', { name: 'Setup' })).toBeNull();
    expect(screen.getByRole('status', { name: 'Background service is starting… Reconnecting…' })).toBeTruthy();
    expect(screen.getByText('Your companions will appear here once GeniusBar connects.')).toBeTruthy();
    cleanup();
    // Past the window the snapshot is no longer starting and setup returns.
    render(<App connection={{ ...starting, starting: false }} setup={idleSetup} onSetup={() => {}} />);
    expect(screen.getByRole('region', { name: 'Setup' })).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: 'Launch companion' }));
    const harness = screen.getByLabelText('Harness') as HTMLSelectElement;
    expect(harness.value).toBe('opencode');
    // The list only suggests: "Other…" launches a harness that is in neither the census nor the known list.
    const listed = [...harness.options].map((o) => o.value);
    expect(listed).toEqual(expect.arrayContaining(['claude', 'opencode', 'muse', 'codex', '__other']));
    expect(listed).not.toContain('my-own-harness');
    fireEvent.change(screen.getByLabelText('Path to soul, ending with .soul'), { target: { value: '/souls/helper' } });
    fireEvent.change(harness, { target: { value: '__other' } });
    fireEvent.change(within(screen.getByRole('dialog', { name: 'Launch a new companion' })).getByLabelText('Harness command'), { target: { value: 'my-own-harness' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Launch a companion package' }));
    expect(launcher.launch).toHaveBeenCalledWith({ account: 'user', target: { package: '/souls/helper' }, harness: 'my-own-harness', name: '', comms: true });
  });

  it('launches with agent comms on by default, or off when turned off first (#71)', () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    render(<App census={sampleCensus} connection={sampleConnection} launcher={launcher} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: 'Launch companion' }));
    const comms = screen.getByRole('switch', { name: 'Agent comms' }) as HTMLInputElement;
    expect(comms.checked).toBe(true);
    fireEvent.click(comms);
    fireEvent.change(screen.getByLabelText('Path to soul, ending with .soul'), { target: { value: '/souls/helper' } });
    fireEvent.change(screen.getByLabelText('Harness'), { target: { value: 'claude' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Launch a companion package' }));
    expect(launcher.launch).toHaveBeenCalledWith({ account: 'user', target: { package: '/souls/helper' }, harness: 'claude', name: '', comms: false });
  });

  it('opens every companion’s audit log from the footer History button (#122)', async () => {
    const load = vi.fn(async () => []);
    render(<AuditSourceContext.Provider value={load}><App census={sampleCensus} connection={sampleConnection} isStatic /></AuditSourceContext.Provider>);
    expect(screen.queryByRole('region', { name: 'Audit log' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Audit log' }));
    const region = await screen.findByRole('region', { name: 'Audit log' });
    expect(region.textContent).toContain('All activity');
    await waitFor(() => expect(load).toHaveBeenCalledWith(null));
    fireEvent.click(within(region).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Audit log' })).toBeNull();
  });

  it('launches a package from the footer, and shows a refusal inline', () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    const { rerender } = render(<App census={sampleCensus} connection={sampleConnection} launcher={launcher} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: 'Launch companion' }));
    fireEvent.change(screen.getByLabelText('Path to soul, ending with .soul'), { target: { value: '/souls/helper' } });
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
    expect((screen.getByLabelText('Path to soul, ending with .soul') as HTMLInputElement).value).toBe('/Downloads/broken.soul');
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
    fireEvent.change(screen.getByLabelText('Path to soul, ending with .soul'), { target: { value: '/souls/helper' } });
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

  it('prefills the name and harness from the opened package once agent-bot located it (#120)', () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    const path = '/Downloads/VMShare.soul';
    const { rerender } = render(<App census={sampleCensus} connection={sampleConnection} launcher={launcher}
      openedPackage={{ id: 1, path, checking: true, error: null }} isStatic />);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('');
    rerender(<App census={sampleCensus} connection={sampleConnection} launcher={launcher}
      openedPackage={{ id: 1, path, checking: false, error: null, name: 'VMTwo - Starter', preferredHarnesses: ['grokbot', 'codex', 'opencode'] }} isStatic />);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('VMTwo');
    // grokbot is unknown here; codex is seen in the census, so it wins over opencode.
    expect((screen.getByLabelText('Harness') as HTMLSelectElement).value).toBe('codex');
    fireEvent.submit(screen.getByRole('form', { name: 'Launch a companion package' }));
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ target: { package: path }, harness: 'codex', name: 'VMTwo' }));
  });

  it('keeps what the owner typed when the opened package\'s manifest arrives later (#120)', () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    const path = '/Downloads/VMShare.soul';
    const { rerender } = render(<App census={sampleCensus} connection={sampleConnection} launcher={launcher}
      openedPackage={{ id: 1, path, checking: true, error: null }} isStatic />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Pip' } });
    fireEvent.change(screen.getByLabelText('Harness'), { target: { value: 'claude' } });
    rerender(<App census={sampleCensus} connection={sampleConnection} launcher={launcher}
      openedPackage={{ id: 1, path, checking: false, error: null, name: 'VMTwo - Starter', preferredHarnesses: ['opencode'] }} isStatic />);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Pip');
    expect((screen.getByLabelText('Harness') as HTMLSelectElement).value).toBe('claude');
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
    fireEvent.click(screen.getByRole('button', { name: 'Launch companion' }));
    expect(screen.getByLabelText('Name').getAttribute('autocomplete')).toBe('off');
  });

  it('opens an empty manual form after an opened package is closed', () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    render(<App census={sampleCensus} connection={sampleConnection} launcher={launcher}
      openedPackage={{ id: 1, path: '/Downloads/broken.soul', checking: false, error: 'unreadable' }} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Launch companion' }));
    expect((screen.getByLabelText('Path to soul, ending with .soul') as HTMLInputElement).value).toBe('');
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
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(devTools.install).toHaveBeenCalled();
    expect(await screen.findByText(/Waiting for the installer/)).toBeTruthy();
    rerender(<App census={[]} connection={sampleConnection} launcher={launcher} starter={{ ...starter, devTools: true }} devTools={devTools} isStatic />);
    expect(screen.getByRole('button', { name: 'Start with Starter' })).toBeTruthy();
  });

  it('keeps the plain empty text when the starter soul is not offered', () => {
    render(<App census={[]} connection={sampleConnection} isStatic />);
    expect(screen.queryByRole('form', { name: 'Start with Starter' })).toBeNull();
    expect(screen.getByText('No companions yet. Launch one to get started.')).toBeTruthy();
  });

  it('adds a companion from the footer +: the launch dialog with Starter preselected (#97)', async () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    const bundledFirst = { ...sampleTemplates, templates: [sampleTemplates.templates[2], ...sampleTemplates.templates.slice(0, 2)] };
    render(<App census={sampleCensus} connection={sampleConnection} launcher={launcher} templateLister={async () => bundledFirst} isStatic />);
    const add = screen.getByRole('button', { name: 'Launch companion' });
    expect(add.getAttribute('title')).toBe('Launch companion');
    fireEvent.click(add);
    const dialog = screen.getByRole('dialog', { name: 'Launch a new companion' });
    const souls = await within(dialog).findByRole('radiogroup', { name: 'Soul' });
    expect(within(souls).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Starter', 'Coder', 'Researcher', 'Custom soul']);
    expect(within(souls).getByRole('radio', { name: 'Starter' }).getAttribute('aria-checked')).toBe('true');
  });

  it('keeps "Launch soul…" for a package in the footer ⋯ menu (#97)', () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    render(<App census={sampleCensus} connection={sampleConnection} launcher={launcher} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Launch soul…' }));
    expect(screen.queryByRole('menu')).toBeNull();
    const dialog = screen.getByRole('dialog', { name: 'Launch a new companion' });
    expect(within(dialog).getByLabelText('Path to soul, ending with .soul')).toBeTruthy();
  });

  it('offers no launch without a launcher', () => {
    render(<App census={sampleCensus} connection={sampleConnection} isStatic />);
    expect(screen.queryByRole('button', { name: 'Launch companion' })).toBeNull();
  });

  it('shows update states in the panel and acts on them (#34)', () => {
    const act = vi.fn();
    const updates = { status: { state: 'available' as const, version: '0.1.1' }, act };
    render(<App census={sampleCensus} connection={sampleConnection} updates={updates} isStatic />);
    expect(screen.getByRole('status', { name: 'Update' }).textContent).toContain('GeniusBar 0.1.1 is available.');
    fireEvent.click(screen.getByRole('button', { name: 'Install and restart' }));
    expect(act).toHaveBeenCalledOnce();
    // While the update needs action, the footer check hides (and so does an empty ⋯).
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    cleanup();
    render(<App connection={sampleConnection} updates={{ ...updates, status: { state: 'idle', version: null } }} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Check for Updates…' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(act).toHaveBeenCalledTimes(2);
    cleanup();
    render(<App connection={sampleConnection} updates={{ ...updates, status: { state: 'disabled', version: null } }} onRefresh={() => {}} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByRole('menuitem', { name: 'Check for Updates…' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Refresh' })).toBeTruthy();
  });

  it('opens the desktop from the popup’s ⋯ menu, and only there (#69)', () => {
    const onOpenDesktop = vi.fn();
    render(<App connection={sampleConnection} onOpenDesktop={onOpenDesktop} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open desktop' }));
    expect(onOpenDesktop).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
    cleanup();
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} onOpenDesktop={onOpenDesktop} onRefresh={() => {}} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: 'GeniusBar menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByRole('menuitem', { name: 'Open desktop' })).toBeNull();
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
    const menuRemove = () => {
      fireEvent.click(screen.getByRole('button', { name: 'More' }));
      const item = screen.getByRole('menuitem', { name: 'Remove services…' });
      expect(item.className).toContain('text-destructive');
      fireEvent.click(item);
    };
    menuRemove();
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: 'Remove services' })).toBeNull();
    menuRemove();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'launchctl would not unload');
    onRemove.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Remove services' })).toBeNull());
    expect(screen.queryByText('Services removed.')).toBeNull();
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
    // No hardened flag in the census, so no pill; luna's shows.
    expect(within(win).queryByText('Hardened', { selector: 'span.rounded-full' })).toBeNull();
    fireEvent.click(within(desktop()).getByRole('button', { name: /^luna,/ }));
    expect(within(screen.getByRole('dialog', { name: 'luna' })).getByText('Hardened', { selector: 'span.rounded-full' })).toBeTruthy();
    fireEvent.click(within(desktop()).getByRole('button', { name: /^agent_c,/ }));
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
    fireEvent.change(within(palette).getByRole('combobox', { name: 'Search companions…' }), { target: { value: 'agent_c' } });
    fireEvent.click(within(palette).getByRole('option', { name: /agent_c/ }));
    expect(screen.queryByRole('dialog', { name: 'Jump to companion' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'agent_c' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const again = screen.getByRole('dialog', { name: 'Jump to companion' });
    fireEvent.change(within(again).getByRole('combobox'), { target: { value: 'nobody' } });
    expect(within(again).getByText('No companions found')).toBeTruthy();
    fireEvent.keyDown(within(again).getByRole('combobox'), { key: 'Escape' });
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
    // The results are options of the search box (arrow keys); the design's ✕ is the only other Tab stop.
    const input = within(palette).getByRole('combobox');
    const close = within(palette).getByRole('button', { name: 'Close' });
    expect(within(palette).queryAllByRole('button')).toEqual([close]);
    input.focus();
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab' });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: 'Escape' });
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

  it('opens the launch dialog from the desktop, and slims a solo card', () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} launcher={launcher} isStatic />);
    expect(within(desktop()).getByRole('region', { name: 'old' }).style.width).toBe('200px');
    expect(within(desktop()).getByRole('region', { name: 'luna' }).style.width).toBe('300px');
    fireEvent.click(within(desktop()).getByRole('button', { name: 'Launch companion' }));
    const dialog = screen.getByRole('dialog', { name: 'Launch a new companion' });
    expect(within(dialog).getByRole('form', { name: 'Launch a companion package' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'GeniusBar menu' })).toBeNull();
    // Comms says what it means, and Cancel closes the dialog.
    expect(within(dialog).getByText('Managed')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Agent comms' }));
    expect(within(dialog).getByText('Unmanaged')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Launch a new companion' })).toBeNull();
  });

  it('closes the launch dialog on a backdrop click, but not on a drag out of a field', () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} launcher={launcher} isStatic />);
    fireEvent.click(within(desktop()).getByRole('button', { name: 'Launch companion' }));
    const dialog = screen.getByRole('dialog', { name: 'Launch a new companion' });
    const backdrop = dialog.parentElement!;
    // Selecting text in the path field and releasing over the backdrop keeps the dialog.
    fireEvent.pointerDown(within(dialog).getByLabelText('Path to soul, ending with .soul'));
    fireEvent.click(backdrop);
    expect(screen.getByRole('dialog', { name: 'Launch a new companion' })).toBeTruthy();
    // A press and release on the backdrop closes it.
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    expect(screen.queryByRole('dialog', { name: 'Launch a new companion' })).toBeNull();
  });

  it('closes the launch dialog on Escape, but not while a launch is in progress (#116)', () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    const { rerender } = render(<App mode="window" census={sampleCensus} connection={sampleConnection} launcher={launcher} isStatic />);
    fireEvent.click(within(desktop()).getByRole('button', { name: 'Launch companion' }));
    const pending: LaunchApi = { ...launcher, state: { phase: 'pending', requestId: 'r1', note: null, stage: null } };
    rerender(<App mode="window" census={sampleCensus} connection={sampleConnection} launcher={pending} isStatic />);
    fireEvent.keyDown(screen.getByLabelText('Path to soul, ending with .soul'), { key: 'Escape' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Launch a new companion' })).toBeTruthy();
    rerender(<App mode="window" census={sampleCensus} connection={sampleConnection} launcher={launcher} isStatic />);
    fireEvent.keyDown(screen.getByLabelText('Path to soul, ending with .soul'), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Launch a new companion' })).toBeNull();
  });

  it('closes the launch dialog when its launch succeeds and opens the new companion (#116)', () => {
    const onRefresh = vi.fn();
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    const census = sampleCensus.filter((soul) => soul.agentId !== 'agent_c');
    const { rerender } = render(<App mode="window" census={census} connection={sampleConnection} launcher={launcher} onRefresh={onRefresh} isStatic />);
    fireEvent.click(within(desktop()).getByRole('button', { name: 'Launch companion' }));
    const dialog = screen.getByRole('dialog', { name: 'Launch a new companion' });
    fireEvent.change(within(dialog).getByLabelText('Path to soul, ending with .soul'), { target: { value: '/souls/helper.soul/' } });
    fireEvent.submit(within(dialog).getByRole('form'));
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ target: { package: '/souls/helper.soul' } }));
    const launched: LaunchApi = { ...launcher, state: { phase: 'launched', requestId: 'r1', agentId: 'agent_c' } };
    rerender(<App mode="window" census={census} connection={sampleConnection} launcher={launched} onRefresh={onRefresh} isStatic />);
    expect(screen.queryByRole('dialog', { name: 'Launch a new companion' })).toBeNull();
    expect(launcher.reset).toHaveBeenCalled();
    expect(onRefresh).toHaveBeenCalled();
    // The new companion opens once the census lists it.
    rerender(<App mode="window" census={sampleCensus} connection={sampleConnection} launcher={launcher} onRefresh={onRefresh} isStatic />);
    expect(screen.getByRole('region', { name: 'agent_c, agent_c' })).toBeTruthy();
    // The next launch starts clean.
    fireEvent.click(within(desktop()).getByRole('button', { name: 'Launch companion' }));
    expect((screen.getByLabelText('Path to soul, ending with .soul') as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('button', { name: 'Launch' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('never shows a finished launch dialog after the popup is hidden (#116)', () => {
    const launched: LaunchApi = { state: { phase: 'launched', requestId: 'r1', agentId: 'agent_x' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    render(<App census={sampleCensus} connection={sampleConnection} launcher={launched} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: 'Launch companion' }));
    expect(screen.getByRole('dialog', { name: 'Launch a new companion' })).toBeTruthy();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    try {
      fireEvent(document, new Event('visibilitychange'));
      expect(screen.queryByRole('dialog', { name: 'Launch a new companion' })).toBeNull();
    } finally {
      hidden.mockRestore();
    }
  });

  it('picks an account from the census, or takes another (Lovable 20.03.51)', () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    const census = [...sampleCensus, { ...sampleCensus[0], agentId: 'agent_z', account: 'zed' }];
    render(<App mode="window" census={census} connection={sampleConnection} launcher={launcher} isStatic />);
    fireEvent.click(within(desktop()).getByRole('button', { name: 'Launch companion' }));
    const dialog = screen.getByRole('dialog', { name: 'Launch a new companion' });
    const account = within(dialog).getByLabelText('Account') as HTMLSelectElement;
    expect(account.value).toBe('');
    expect([...account.options].map((o) => o.textContent)).toEqual(['Choose an account', 'user', 'zed', 'Other account…']);
    fireEvent.change(account, { target: { value: '__other' } });
    fireEvent.change(within(dialog).getByLabelText('Other account'), { target: { value: 'gb-agent' } });
    fireEvent.change(within(dialog).getByLabelText('Path to soul, ending with .soul'), { target: { value: '/souls/helper.soul' } });
    fireEvent.change(within(dialog).getByLabelText('Harness'), { target: { value: 'claude' } });
    fireEvent.submit(within(dialog).getByRole('form'));
    expect(launcher.launch).toHaveBeenCalledWith({ account: 'gb-agent', target: { package: '/souls/helper.soul' }, harness: 'claude', name: '', comms: true });
  });

  it('has no Launch button without a launcher', () => {
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic />);
    expect(within(desktop()).queryByRole('button', { name: 'Launch companion' })).toBeNull();
  });

  it('opens the ⓘ sheet outside the window, so pressing on it does not drag the window', () => {
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic />);
    fireEvent.click(within(desktop()).getByRole('button', { name: /^agent_c,/ }));
    const win = screen.getByRole('dialog', { name: 'agent_c' });
    const before = win.style.transform;
    fireEvent.click(within(win).getByRole('button', { name: 'Details' }));
    const sheet = screen.getByRole('dialog', { name: 'Details · agent_c' });
    expect(win.contains(sheet)).toBe(false);
    expect(sheet.parentElement?.parentElement).toBe(document.body);
    const backdrop = sheet.parentElement!;
    // jsdom has no pointer capture; the drag handler calls it before it moves anything.
    const capture = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { value: capture, configurable: true });
    fireEvent.pointerDown(backdrop, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(backdrop, { pointerId: 1, clientX: 90, clientY: 60 });
    fireEvent.pointerDown(sheet, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(sheet, { pointerId: 1, clientX: 90, clientY: 60 });
    expect(capture).not.toHaveBeenCalled();
    expect(win.style.transform).toBe(before);
    fireEvent.keyDown(sheet, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Details · agent_c' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'agent_c' })).toBeTruthy();
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
    // As the design, Hide on the lead hides its whole team (D5); a subagent
    // shown again from the menu leaves the lead hidden behind a placeholder.
    fireEvent.contextMenu(within(desktop()).getByRole('button', { name: /^luna,/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide from desktop' }));
    expect(within(desktop()).queryByRole('region', { name: 'Team' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'GeniusBar menu' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'GeniusBar menu' })).getByRole('button', { name: 'Show on desktop: agent_c' }));
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
    // Hide on the lead hides the team (D5); kiro shown again leaves the lead's placeholder.
    fireEvent.contextMenu(within(desktop()).getByRole('button', { name: /^luna,/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide from desktop' }));
    expect(within(desktop()).queryByRole('region', { name: 'Team' })).toBeNull();
    fireEvent.click(within(menu).getByRole('button', { name: 'Show on desktop: kiro' }));
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

  it('goes home from the G GeniusBar mark: the open window and the audit window close (M1)', () => {
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic />);
    fireEvent.click(within(desktop()).getByRole('button', { name: /^luna,/ }));
    expect(screen.getByRole('dialog', { name: 'luna' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'GeniusBar' }));
    expect(screen.queryByRole('dialog', { name: 'luna' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Audit log' }));
    expect(screen.getByRole('dialog', { name: 'Audit log' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'GeniusBar' }));
    expect(screen.queryByRole('dialog', { name: 'Audit log' })).toBeNull();
  });

  it("passes the live state to the open window: a working companion's title bar and header Dudles look busy (S1, S3)", () => {
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic
      badges={{ ...noBadges, busy: new Set(['agent_p']) }} />);
    fireEvent.click(within(desktop()).getByRole('button', { name: /^luna,/ }));
    const win = screen.getByRole('dialog', { name: 'luna' });
    for (const dudle of win.querySelectorAll('svg.dudle')) expect(dudle.getAttribute('data-state')).toBe('working');
    expect(within(win).getByText(/· Working…$/)).toBeTruthy();
  });

  it("hides and shows a whole team from the lead's eye in the menu", () => {
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: 'GeniusBar menu' }));
    const menu = screen.getByRole('dialog', { name: 'GeniusBar menu' });
    expect(within(menu).queryByRole('button', { name: 'Hide from desktop: luna' })).toBeNull();
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
    expect(desktop().textContent).toContain('Open GeniusBar in the menu bar to set up.');
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
    fireEvent.contextMenu(within(screen.getByRole('main', { name: 'Flota' })).getByRole('button', { name: /^luna,/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ocultar del escritorio' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Menú de GeniusBar' })).getByRole('button', { name: 'Mostrar en el escritorio: agent_c' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Más' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Herramientas de línea de comandos…' }));
    await screen.findByRole('button', { name: 'Instalar' });
    expect(cliTools.status).toHaveBeenCalledOnce();
  });
});

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { emptyChat } from '../model/chat';
import { buildSoulForest } from '../model/census';
import { sampleApprovals, sampleCensus, sampleConnection, samplePaused } from '../model/fixtures';
import { layoutActions } from '../state/layout';
import { noBadges } from '../model/refresh';
import type { LaunchApi } from '../useLaunch';
import type { Pauser } from '../usePause';
import type { ChatApi } from '../useChat';
import type { SoulMode } from '../bridge';
import { MenuBar } from './MenuBar';
import { SoulSourceContext, type SoulSource } from './SoulNotices';

afterEach(() => { cleanup(); globalThis.localStorage?.clear(); layoutActions.forget(); });

const bar = (approvals: number, unread = 0) => (
  <MenuBar open={false} onOpenChange={vi.fn()} tone="ok" title="ok" onReset={vi.fn()} unread={unread}
    approvals={approvals} forest={[]} paused onJump={vi.fn()}>menu</MenuBar>
);

describe('MenuBar approval badge', () => {
  it('badges the G with the pending count and describes it', () => {
    render(bar(2, 1));
    const item = screen.getByRole('button', { name: 'GeniusBar menu' });
    expect(item.textContent).toContain('G2');
    expect(document.getElementById(item.getAttribute('aria-describedby')!)?.textContent).toBe('2 waiting on you, 1 new');
  });

  it('shows the working count in mono after the badges, and describes it', () => {
    render(<MenuBar open={false} onOpenChange={vi.fn()} tone="ok" title="ok" onReset={vi.fn()} unread={0}
      approvals={1} working={3} forest={[]} paused onJump={vi.fn()}>menu</MenuBar>);
    const item = screen.getByRole('button', { name: 'GeniusBar menu' });
    expect(item.textContent).toBe('G13');
    expect(document.getElementById(item.getAttribute('aria-describedby')!)?.textContent).toBe('1 waiting on you, 3 working');
  });

  it('keeps the plain item at zero', () => {
    render(bar(0));
    const item = screen.getByRole('button', { name: 'GeniusBar menu' });
    expect(item.textContent).toBe('G');
    expect(item.getAttribute('aria-describedby')).toBeNull();
  });
});

describe('the fleet Auto-Pilot banner (Lovable MenuBar)', () => {
  const pilot = (autopilot: boolean, onAutopilotOff = vi.fn()) => (
    <MenuBar open={false} onOpenChange={vi.fn()} tone="ok" title="ok" onReset={vi.fn()} unread={0}
      forest={[]} paused onJump={vi.fn()} autopilot={autopilot} onAutopilotOff={onAutopilotOff}>menu</MenuBar>
  );

  it('shows under the menu bar with Turn off, and turns the G amber, while every companion is on Auto-Pilot', () => {
    const off = vi.fn();
    render(pilot(true, off));
    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('Auto-Pilot is on — companions run tools without asking.');
    fireEvent.click(within(banner).getByRole('button', { name: 'Turn off' }));
    expect(off).toHaveBeenCalledOnce();
    const g = screen.getByRole('button', { name: 'GeniusBar menu' }).querySelector('span')!;
    expect(g.className).toContain('bg-warning');
  });

  it('is absent, with the plain G, otherwise', () => {
    render(pilot(false));
    expect(screen.queryByText(/Auto-Pilot is on/)).toBeNull();
    const g = screen.getByRole('button', { name: 'GeniusBar menu' }).querySelector('span')!;
    expect(g.className).toContain('bg-foreground');
  });

  it('turns every companion back to Safe Mode from the desktop', async () => {
    const setMode = vi.fn(async (_id: string, mode: SoulMode) => mode);
    const source: SoulSource = {
      population: vi.fn(async () => null), coldWake: vi.fn(async () => null), setColdWake: vi.fn(),
      signedIn: vi.fn(async () => null), signIn: vi.fn(),
      mode: vi.fn(async () => 'autopilot' as const), setMode,
      model: vi.fn(async () => null), setModel: vi.fn(),
    };
    render(<SoulSourceContext.Provider value={source}>
      <App mode="window" census={sampleCensus} connection={sampleConnection} isStatic />
    </SoulSourceContext.Provider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(screen.queryByText(/Auto-Pilot is on/)).toBeNull());
    expect(setMode.mock.calls.every(([, mode]) => mode === 'safe')).toBe(true);
    expect(setMode).toHaveBeenCalledTimes(new Set(sampleCensus.map((s) => s.agentId)).size);
  });
});

describe('menu bar and palette chrome (pass 3)', () => {
  const bar = (tone: string, extra: Partial<Parameters<typeof MenuBar>[0]> = {}) => (
    <MenuBar open={false} onOpenChange={vi.fn()} tone={tone} title="t" onReset={vi.fn()} unread={0}
      forest={[]} paused onJump={vi.fn()} {...extra}>menu</MenuBar>
  );

  it('shows the G item’s health dot only when something is wrong (N2)', () => {
    const { container, unmount } = render(bar('ok'));
    expect(container.querySelector('.dot')).toBeNull();
    unmount();
    const bad = render(bar('bad'));
    expect(bad.container.querySelector('.dot.dot-bad')).toBeTruthy();
  });

  it('pads the Auto-Pilot strip py-1 with a flat Turn off (N2)', () => {
    render(bar('ok', { autopilot: true, onAutopilotOff: vi.fn() }));
    expect(screen.getByRole('status').className.split(' ')).toContain('py-1');
    expect(screen.getByRole('button', { name: 'Turn off' }).className.split(' ')).toEqual(expect.arrayContaining(['min-h-0', 'py-0']));
  });

  it('gives the palette the design’s ✕, list height, insets, empty text and role size (N1, R1)', () => {
    const captain = { ...sampleCensus[0], role: 'Release captain' };
    render(bar('ok', { forest: buildSoulForest([captain, ...sampleCensus.slice(1)]) }));
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const palette = screen.getByRole('dialog', { name: 'Jump to companion' });
    const listbox = within(palette).getByRole('listbox');
    expect(listbox.className).toBe('px-2');
    expect(listbox.parentElement?.className.split(' ')).toEqual(expect.arrayContaining(['max-h-[300px]', 'p-1']));
    expect(within(palette).getByText('Release captain').className).toBe('text-muted-foreground');
    expect(within(palette).getAllByText('unknown harness')[0].className).toBe('font-mono text-xs text-muted-foreground');
    fireEvent.change(within(palette).getByRole('combobox'), { target: { value: 'nobody' } });
    expect(within(palette).getByText('No companions found').className).not.toMatch(/muted/);
    fireEvent.click(within(palette).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Jump to companion' })).toBeNull();
  });
});

describe('the View menu', () => {
  it('opens the all-activity audit log, and resets the layout with no icon', () => {
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    const menu = screen.getByRole('menu', { name: 'View' });
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent?.trim())).toEqual(['Jump to companion⌘K', 'Audit log', 'Reset desktop layout']);
    expect(items[2].querySelector('svg')).toBeNull();
    fireEvent.click(items[1]);
    expect(screen.queryByRole('menu', { name: 'View' })).toBeNull();
    // N8: a desktop window with the design's page heading, not a panel in the 320px popover.
    expect(screen.queryByRole('dialog', { name: 'GeniusBar menu' })).toBeNull();
    const audit = screen.getByRole('dialog', { name: 'Audit log' });
    expect(within(audit).getByRole('heading', { level: 1 }).textContent).toBe('Audit log · All activity');
    expect(document.activeElement).toBe(within(audit).getByRole('button', { name: 'Close window' }));
    fireEvent.click(within(audit).getByRole('button', { name: 'Close window' }));
    expect(screen.queryByRole('dialog', { name: 'Audit log' })).toBeNull();
  });

  it('opens the same window from the menu footer’s History, closing the menu (N8)', () => {
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: 'GeniusBar menu' }));
    const popover = screen.getByRole('dialog', { name: 'GeniusBar menu' });
    fireEvent.click(within(popover).getByRole('button', { name: 'Audit log' }));
    expect(screen.queryByRole('dialog', { name: 'GeniusBar menu' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Audit log' })).toBeNull();
    const audit = screen.getByRole('dialog', { name: 'Audit log' });
    fireEvent.keyDown(audit, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Audit log' })).toBeNull();
  });

  it('keeps the inline panel in the tray popup (N8)', () => {
    render(<App census={sampleCensus} connection={sampleConnection} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: 'Audit log' }));
    expect(screen.getByRole('region', { name: 'Audit log' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Audit log' })).toBeNull();
  });
});

describe('the menu’s approval list', () => {
  const chat = (decide = vi.fn(async () => {})): ChatApi => ({
    chat: emptyChat, composers: {}, open: vi.fn(), setDraft: vi.fn(), send: vi.fn(),
    approvals: { records: sampleApprovals, local: new Map() }, decide,
  });

  it('lists proposals above the search, counts them, and decides through the chat feed', () => {
    const decide = vi.fn(async () => {});
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic chat={chat(decide)} />);
    const item = screen.getByRole('button', { name: 'GeniusBar menu' });
    expect(item.textContent).toContain('G2');
    fireEvent.click(item);
    const menu = screen.getByRole('dialog', { name: 'GeniusBar menu' });
    expect(within(menu).getByText('2 waiting on you')).toBeTruthy();
    const list = within(menu).getByRole('alert', { name: 'Waiting for your approval' });
    const search = within(menu).getByRole('searchbox', { name: 'Search companions…' });
    expect(list.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: 'Deny Bash for luna' }));
    expect(decide).toHaveBeenCalledWith('prop_1', 'deny');
  });

  it('opens the companion’s chat from its name in the tray popup', () => {
    render(<App mode="tray" census={sampleCensus} connection={sampleConnection} isStatic chat={chat()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open chat with luna' }));
    expect(screen.queryByRole('alert', { name: 'Waiting for your approval' })).toBeNull();
    expect(screen.getAllByText('luna').length).toBeGreaterThan(0);
  });

  it('keeps the section and the counts, at zero, while nothing waits', () => {
    render(<App mode="tray" census={sampleCensus} connection={sampleConnection} isStatic
      chat={{ ...chat(), approvals: { records: [], local: new Map() } }} />);
    expect(screen.queryByRole('alert', { name: 'Waiting for your approval' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Waiting for your approval' }).textContent).toContain('Nothing waiting for you');
    expect(screen.getByText('0 waiting on you')).toBeTruthy();
  });
});

describe('the "Companions paused" chip (#122, agent-bot soul pause)', () => {
  const chip = (fleetPaused: boolean, onResume?: () => void) => (
    <MenuBar open={false} onOpenChange={vi.fn()} tone="ok" title="ok" onReset={vi.fn()} unread={0}
      forest={[]} paused onJump={vi.fn()} fleetPaused={fleetPaused} onResume={onResume}>menu</MenuBar>
  );

  it('shows while companions are paused, before the GeniusBar item, and resumes on click', () => {
    const onResume = vi.fn();
    render(chip(true, onResume));
    const button = screen.getByRole('button', { name: 'Companions paused' });
    expect(button.className).toBe('flex min-h-7 items-center gap-1 rounded bg-secondary px-2 py-0.5 text-secondary-foreground');
    const item = screen.getByRole('button', { name: 'GeniusBar menu' });
    expect(button.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(button);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('is absent while running, or without a way to resume', () => {
    render(chip(false, vi.fn()));
    expect(screen.queryByRole('button', { name: 'Companions paused' })).toBeNull();
    cleanup();
    render(chip(true));
    expect(screen.queryByRole('button', { name: 'Companions paused' })).toBeNull();
  });

  const chat: ChatApi = { chat: emptyChat, composers: {}, open: vi.fn(), setDraft: vi.fn(), send: vi.fn() };
  const pauserWith = (supported = true): Pauser & { pause: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> } => {
    let entries = samplePaused.map((e) => ({ ...e }));
    const set = (agentId: string, paused: boolean) => {
      entries = entries.map((e) => (e.agentId === agentId ? { ...e, paused } : e));
      return { agentId, paused };
    };
    return {
      supported: vi.fn(async () => supported),
      list: vi.fn(async () => entries),
      pause: vi.fn(async (agentId: string) => set(agentId, true)),
      resume: vi.fn(async (agentId: string) => set(agentId, false)),
    };
  };
  const desk = (pauser: Pauser) => render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic chat={chat}
    floatingButton pauser={pauser} />);

  it('in the desktop, resumes only the paused companions, then offers Pause all for every managed one', async () => {
    const pauser = pauserWith();
    desk(pauser);
    const button = await screen.findByRole('button', { name: 'Companions paused' });
    await act(async () => { fireEvent.click(button); });
    expect(pauser.resume.mock.calls.map(([id]) => id)).toEqual(['agent_p']);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Companions paused' })).toBeNull());
    fireEvent.keyDown(screen.getByRole('button', { name: 'Companion quick actions' }), { key: 'Enter' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Pause all' })); });
    expect(pauser.pause.mock.calls.map(([id]) => id)).toEqual(['agent_p', 'agent_c']);
    expect(await screen.findByRole('button', { name: 'Companions paused' })).toBeTruthy();
  });

  it('shows a failed resume in the menu bar\'s error style', async () => {
    const pauser = pauserWith();
    pauser.resume.mockRejectedValue({ code: 'daemon-unavailable', message: 'the daemon is not running' });
    desk(pauser);
    const button = await screen.findByRole('button', { name: 'Companions paused' });
    await act(async () => { fireEvent.click(button); });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Could not resume: the daemon is not running');
    expect(within(alert).getByRole('button').className).toContain('text-destructive');
  });

  it('renders neither chip nor quick action on an agent-bot without soul pause', async () => {
    const pauser = pauserWith(false);
    desk(pauser);
    await waitFor(() => expect(pauser.supported).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Companions paused' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Companion quick actions' }), { key: 'Enter' });
    expect(screen.queryByRole('button', { name: /Pause all|Resume/ })).toBeNull();
    expect(pauser.list).not.toHaveBeenCalled();
  });
});

describe('the ⌘K palette’s actions and keys (#122)', () => {
  const launcher = (): LaunchApi => ({ state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() });
  const desk = (withLauncher = true) => render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic
    launcher={withLauncher ? launcher() : undefined} />);
  const openPalette = () => {
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    return screen.getByRole('dialog', { name: 'Jump to companion' });
  };
  const desktop = () => screen.getByRole('main', { name: 'Fleet' });

  it('lists "Launch a companion…" below the companions, and opens the launch dialog from it', () => {
    desk();
    const palette = openPalette();
    const options = within(palette).getAllByRole('option');
    const launch = within(palette).getByRole('option', { name: 'Launch a companion…' });
    expect(options[options.length - 1]).toBe(launch);
    expect(options.length).toBeGreaterThan(1);
    expect(within(palette).queryByRole('option', { name: /Show all hidden/ })).toBeNull();
    fireEvent.click(launch);
    expect(screen.queryByRole('dialog', { name: 'Jump to companion' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Launch a new companion' })).toBeTruthy();
  });

  it('groups companions with no team under "No team", after the teams', () => {
    desk();
    const palette = openPalette();
    const groups = within(palette).getAllByRole('group').map((g) => g.getAttribute('aria-label'));
    expect(groups).toEqual(['luna', 'No team', 'Actions']);
    expect(within(within(palette).getByRole('group', { name: 'No team' })).getAllByRole('option')).toHaveLength(1);
  });

  it('offers no launch entry without a launcher', () => {
    desk(false);
    expect(within(openPalette()).queryByRole('option', { name: 'Launch a companion…' })).toBeNull();
  });

  it('offers "Show all hidden (N)" only while companions are hidden, and restores them', () => {
    desk();
    act(() => { layoutActions.setHidden('user/agent_c', true); layoutActions.setHidden('user/agent_p', true); });
    expect(within(desktop()).queryByRole('button', { name: /^agent_c,/ })).toBeNull();
    const palette = openPalette();
    fireEvent.click(within(palette).getByRole('option', { name: 'Show all hidden (2)' }));
    expect(screen.queryByRole('dialog', { name: 'Jump to companion' })).toBeNull();
    expect(within(desktop()).getByRole('button', { name: /^agent_c,/ })).toBeTruthy();
    expect(within(openPalette()).queryByRole('option', { name: /Show all hidden/ })).toBeNull();
  });

  it('filters the actions with the companions as you type', () => {
    desk();
    const palette = openPalette();
    const input = within(palette).getByRole('combobox', { name: 'Search companions…' });
    fireEvent.change(input, { target: { value: 'launch' } });
    expect(within(palette).getAllByRole('option').map((o) => o.textContent)).toEqual(['Launch a companion…']);
    fireEvent.change(input, { target: { value: 'luna' } });
    expect(within(palette).queryByRole('option', { name: 'Launch a companion…' })).toBeNull();
  });

  it('moves aria-activedescendant with the arrow keys, wraps, and opens the highlighted companion on Enter', () => {
    desk();
    const palette = openPalette();
    const input = within(palette).getByRole('combobox', { name: 'Search companions…' });
    const listbox = within(palette).getByRole('listbox');
    expect(input.getAttribute('aria-controls')).toBe(listbox.id);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    const options = within(palette).getAllByRole('option');
    const active = () => input.getAttribute('aria-activedescendant');
    expect(active()).toBe(options[0].id);
    expect(options[0].getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(active()).toBe(options[1].id);
    expect(options[1].getAttribute('aria-selected')).toBe('true');
    expect(options[0].getAttribute('aria-selected')).toBe('false');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(active()).toBe(options[options.length - 1].id);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(active()).toBe(options[1].id);
    const name = options[1].querySelector('span')!.textContent!;
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByRole('dialog', { name: 'Jump to companion' })).toBeNull();
    expect(screen.getByRole('dialog', { name })).toBeTruthy();
  });

  it('starts the highlight over at the top when the query changes', () => {
    desk();
    const palette = openPalette();
    const input = within(palette).getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.change(input, { target: { value: 'agent_c' } });
    const [first] = within(palette).getAllByRole('option');
    expect(input.getAttribute('aria-activedescendant')).toBe(first.id);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('dialog', { name: 'agent_c' })).toBeTruthy();
  });
});

describe('the declared role in the palette and on the desktop (#122, agent-bot-identity #535)', () => {
  const roles = new Map([['agent_p', { role: 'Release captain', roleLine: 'Release captain' }]]);
  const desk = () => render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic
    badges={{ ...noBadges, roles }} />);
  const openPalette = () => {
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    return screen.getByRole('dialog', { name: 'Jump to companion' });
  };

  it('subtitles a palette option with the role, else the harness, and searches the role', () => {
    desk();
    const palette = openPalette();
    const texts = within(palette).getAllByRole('option').map((o) => o.textContent ?? '');
    const luna = texts.find((x) => x.startsWith('luna'));
    expect(luna).toContain('Release captain');
    expect(luna).not.toContain('codex');
    // A soul with no role keeps its harness line.
    expect(texts.find((x) => x.startsWith('agent_c'))).toContain('unknown harness');
    fireEvent.change(within(palette).getByRole('combobox', { name: 'Search companions…' }), { target: { value: 'captain' } });
    expect(within(palette).getAllByRole('option').map((o) => o.textContent ?? '').filter((x) => x.startsWith('luna'))).toHaveLength(1);
    expect(within(palette).getAllByRole('option').some((o) => (o.textContent ?? '').startsWith('agent_c'))).toBe(false);
  });

  it('subtitles the team card with the role and the subagent count', () => {
    desk();
    const card = screen.getByRole('region', { name: 'luna' });
    expect(within(card).getByText(/^Release captain · /)).toBeTruthy();
  });

  it('keeps the harness on the team card without a role', () => {
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic badges={noBadges} />);
    const card = screen.getByRole('region', { name: 'luna' });
    expect(within(card).getByText(/^codex · /)).toBeTruthy();
  });
});

describe('MenuBar pass 6 (M1, M2, M3, P10, P19)', () => {
  const plain = (extra: Partial<Parameters<typeof MenuBar>[0]> = {}) => (
    <MenuBar open={false} onOpenChange={vi.fn()} tone="ok" title="t" onReset={vi.fn()} unread={0}
      forest={buildSoulForest(sampleCensus)} paused onJump={vi.fn()} {...extra}>menu</MenuBar>
  );

  it('makes the G GeniusBar mark a home button, its name and the clock hidden on a narrow window', () => {
    const onHome = vi.fn();
    const { container } = render(plain({ onHome }));
    const home = screen.getByRole('button', { name: 'GeniusBar' });
    expect(home.getAttribute('title')).toBe('Show the desktop');
    expect(home.className).toContain('focus-visible:ring-2');
    expect(within(home).getByText('GeniusBar').className.split(' ')).toEqual(['hidden', 'sm:inline']);
    fireEvent.click(home);
    expect(onHome).toHaveBeenCalledOnce();
    expect(container.querySelector('time')?.className.split(' ')).toEqual(expect.arrayContaining(['hidden', 'sm:inline']));
  });

  it('keeps a plain mark without a home action', () => {
    render(plain());
    expect(screen.queryByRole('button', { name: 'GeniusBar' })).toBeNull();
    expect(screen.getByText('GeniusBar').className.split(' ')).toEqual(['hidden', 'sm:inline']);
  });

  it('moves through the View menu with the keys, and Escape gives focus back to View (M2)', () => {
    render(plain({ onAudit: vi.fn() }));
    const view = screen.getByRole('button', { name: 'View' });
    fireEvent.click(view);
    const menu = screen.getByRole('menu', { name: 'View' });
    const items = within(menu).getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'View' })).toBeNull();
    expect(document.activeElement).toBe(view);
    // Down on the closed trigger opens it, as Radix Menubar.
    fireEvent.keyDown(view, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(within(screen.getByRole('menu', { name: 'View' })).getAllByRole('menuitem')[0]);
  });

  it('gives the palette rows the cmdk height, py-1.5 (P19)', () => {
    render(plain());
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const option = within(screen.getByRole('listbox')).getAllByRole('option')[0];
    expect(option.className.split(' ')).toContain('py-1.5');
    expect(option.className.split(' ')).not.toContain('py-3');
  });
});

describe('the ⋯ footer menu keys (P10)', () => {
  it('moves through the items with the keys, and Escape gives focus back to ⋯', async () => {
    const { FooterMenu } = await import('./FooterMenu');
    render(<FooterMenu items={[{ label: 'One', run: vi.fn() }, 'separator', { label: 'Two', run: vi.fn() }, { label: 'Three', run: vi.fn(), destructive: true }]} />);
    const more = screen.getByRole('button', { name: 'More' });
    fireEvent.click(more);
    const menu = screen.getByRole('menu', { name: 'More' });
    const [one, two, three] = within(menu).getAllByRole('menuitem');
    expect(document.activeElement).toBe(one);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(two);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(three);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(one);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(three);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(one);
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(more);
  });
});

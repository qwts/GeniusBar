import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { emptyChat } from '../model/chat';
import { sampleApprovals, sampleCensus, sampleConnection, samplePaused } from '../model/fixtures';
import type { Pauser } from '../usePause';
import type { ChatApi } from '../useChat';
import { MenuBar } from './MenuBar';

afterEach(cleanup);

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

  it('keeps the plain item at zero', () => {
    render(bar(0));
    const item = screen.getByRole('button', { name: 'GeniusBar menu' });
    expect(item.textContent).toBe('G');
    expect(item.getAttribute('aria-describedby')).toBeNull();
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

  it('shows no section or counts while nothing waits', () => {
    render(<App mode="tray" census={sampleCensus} connection={sampleConnection} isStatic
      chat={{ ...chat(), approvals: { records: [], local: new Map() } }} />);
    expect(screen.queryByRole('alert', { name: 'Waiting for your approval' })).toBeNull();
    expect(screen.queryByText(/waiting on you/)).toBeNull();
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
    expect(button.className).toBe('flex items-center gap-1 rounded bg-secondary px-2 py-0.5 text-secondary-foreground');
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

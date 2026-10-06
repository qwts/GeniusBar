import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { emptyChat } from '../model/chat';
import { sampleApprovals, sampleCensus, sampleConnection } from '../model/fixtures';
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

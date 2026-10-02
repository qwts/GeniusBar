import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { emptyComposer, mergeIncoming, emptyChat } from './model/chat';
import { inboxMessage, sampleCensus, sampleConnection } from './model/fixtures';
import { idleSetup } from './model/setup';
import { disconnected } from './model/status';
import type { ChatApi } from './useChat';

afterEach(() => { cleanup(); globalThis.localStorage?.clear(); });

describe('App', () => {
  it('shows the header and an empty roster before the bridge connects', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'GeniusBar' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/not connected/i);
    expect(screen.getByRole('region', { name: 'Souls' }).childElementCount).toBe(0);
  });

  it('renders the fixed fake census and health, nested, with every soul', () => {
    // SnapshotTests.rendersPNG: the populated roster must actually draw
    // rows that the same header with an empty roster does not.
    render(<App census={sampleCensus} connection={sampleConnection} isStatic />);
    expect(screen.getByRole('status', { name: /Broker healthy/ }).textContent).toContain(
      'uptime 12s · log 512 B · accounts 1 · principals 2 · watches 3',
    );
    const roster = screen.getByRole('region', { name: 'Souls' });
    expect(roster.querySelectorAll('button.soul-row')).toHaveLength(3);
    cleanup();
    render(<App connection={sampleConnection} isStatic />);
    expect(screen.getByRole('region', { name: 'Souls' }).textContent).toBe('No souls on this machine.');
  });

  it('opens the detail for a selected row and closes it with Done', () => {
    render(<App census={sampleCensus} connection={sampleConnection} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: /^agent_c,/ }));
    expect(screen.getByRole('dialog', { name: 'agent_c, agent_c' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
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
    expect(screen.getByRole('status').textContent).toContain('Broker unreachable');
    expect(screen.getAllByText(`Last known · ${lastRefresh.toLocaleTimeString()}`)).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /presence/ })).toHaveLength(3);
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
    const dialog = screen.getByRole('dialog', { name: 'agent_c, agent_c' });
    expect(dialog.textContent).toContain('hello');
    fireEvent.change(screen.getByRole('textbox', { name: 'Message to agent_c' }), { target: { value: 'yo' } });
    expect(chat.setDraft).toHaveBeenCalledWith('user/agent_c', 'yo');
    expect(chat.composers['user/agent_c'] ?? emptyComposer).toEqual(emptyComposer);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(chat.open).toHaveBeenLastCalledWith(null);
  });
});

describe('App setup', () => {
  it('replaces the roster with the setup panel while setup is needed', () => {
    const unpaired = { ...disconnected, bridgeConnected: true, unpaired: true };
    render(<App connection={unpaired} setup={idleSetup} onSetup={() => {}} />);
    expect(screen.getByRole('region', { name: 'Setup' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Souls' })).toBeNull();
    expect(screen.queryByText('No souls on this machine.')).toBeNull();
  });
});

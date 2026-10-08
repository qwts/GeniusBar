import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyComposer, type ChatEntry } from '../model/chat';
import { Conversation } from './Conversation';

afterEach(cleanup);

const entries: ChatEntry[] = [
  { id: 'msg_1', direction: 'in', body: '<b>bold</b> **not markdown**\n  indented', at: 1_000, seq: 1 },
  { id: 'msg_2', direction: 'out', body: 'reply', at: 2_000, seq: 2 },
];

describe('Conversation', () => {
  it('disables the composer while the companion cannot take messages', () => {
    const onSend = vi.fn();
    render(<Conversation name="luna" entries={entries} composer={{ ...emptyComposer, draft: 'hi' }} onDraft={() => {}} onSend={onSend} disabled />);
    expect((screen.getByRole('textbox', { name: 'Message luna' }) as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByRole('textbox', { name: 'Message luna' }).closest('form')!);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('scrolls only the log, which shrinks to the room left and chains no scroll to the window (#260)', () => {
    const { rerender } = render(<Conversation name="luna" entries={entries} composer={emptyComposer} onDraft={() => {}} onSend={() => {}} />);
    const log = screen.getByRole('log', { name: 'Conversation with luna' });
    expect(log.className.split(' ')).toEqual(expect.arrayContaining(['min-h-0', 'flex-1', 'overflow-y-auto', 'overscroll-contain']));
    expect(log.parentElement!.className.split(' ')).toEqual(expect.arrayContaining(['flex', 'min-h-0', 'flex-1', 'flex-col']));
    expect(screen.getByRole('textbox').closest('form')!.className.split(' ')).toContain('shrink-0');
    rerender(<Conversation name="luna" entries={[]} composer={emptyComposer} onDraft={() => {}} onSend={() => {}} />);
    const empty = screen.getByText(/Say hello to luna/).parentElement!.parentElement!;
    expect(empty.className.split(' ')).toEqual(expect.arrayContaining(['min-h-0', 'flex-1', 'overflow-y-auto', 'overscroll-contain']));
  });

  it('lists messages oldest first and renders bodies as safe Markdown, never HTML (#117)', () => {
    render(<Conversation name="luna" entries={entries} composer={emptyComposer} onDraft={() => {}} onSend={() => {}} />);
    // role="log" as the design's message list (X14).
    const items = screen.getByRole('log', { name: 'Conversation with luna' }).querySelectorAll(':scope > li');
    expect(items).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Send' }).className.split(' ')).toEqual(expect.arrayContaining(['outline-none', 'focus-visible:ring-2', 'focus-visible:ring-ring']));
    expect(items[1].textContent).toContain('You');
    const body = items[0].querySelector('.chat-body')!;
    expect(body.textContent).toBe('<b>bold</b> not markdown\n  indented');
    expect(body.querySelector('b')).toBeNull();
    expect(body.querySelector('strong')?.textContent).toBe('not markdown');
  });

  it('shows links as text with their address, not as live links', () => {
    const linked: ChatEntry[] = [{ id: 'm', direction: 'in', body: 'See [docs](https://example.com) and `agent_550fe`', at: 1, seq: 1 }];
    render(<Conversation name="luna" entries={linked} composer={emptyComposer} onDraft={() => {}} onSend={() => {}} />);
    const body = document.querySelector('.chat-body')!;
    expect(body.querySelector('a')).toBeNull();
    expect(body.textContent).toBe('See docs (https://example.com) and agent_550fe');
    expect(body.querySelector('code')?.textContent).toBe('agent_550fe');
  });

  it('renders tool calls, approval requests and asides in the stream', () => {
    const mixed: ChatEntry[] = [
      { id: 'm', direction: 'in', body: 'On it.', at: 1, seq: 1 },
      { id: 't', kind: 'tool_call', tool: 'terminal', args: 'npm test', status: 'running', at: 2, seq: null },
      { id: 'a', kind: 'approval_request', tool: 'terminal', args: 'git push', risk: 'external', status: 'pending', at: 3, seq: null },
      { id: 's', kind: 'aside', from: 'luna', to: 'scout', body: 'CI?', reply: 'Green.', team: 'luna', at: 4, seq: null },
    ];
    render(<Conversation name="luna" entries={mixed} composer={emptyComposer} onDraft={() => {}} onSend={() => {}} />);
    const items = screen.getByRole('log', { name: 'Conversation with luna' }).querySelectorAll(':scope > li');
    expect(items).toHaveLength(4);
    expect(screen.getByRole('group', { name: 'Tool call: terminal — Running' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('luna wants to run terminal');
    expect(screen.getByRole('button', { name: /luna → scout/ }).getAttribute('aria-expanded')).toBe('true');
    expect(items[3].textContent).toContain('Green.');
  });

  it('passes approval decisions to onResolve, and disables them without it', () => {
    const ask: ChatEntry[] = [{ id: 'a', kind: 'approval_request', tool: 'terminal', args: 'rm x', risk: 'destructive', status: 'pending', at: 1, seq: null }];
    const onResolve = vi.fn();
    const { rerender } = render(<Conversation name="luna" entries={ask} composer={emptyComposer} onDraft={() => {}} onSend={() => {}} onResolve={onResolve} />);
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onResolve).toHaveBeenCalledWith('a', 'denied');
    // The daemon has no session scope yet.
    const session = screen.getByRole('button', { name: 'Approve for session' }) as HTMLButtonElement;
    expect(session.disabled).toBe(true);
    expect(session.title).toBe('Approvals arrive in a later update');

    rerender(<Conversation name="luna" entries={ask} composer={emptyComposer} onDraft={() => {}} onSend={() => {}} />);
    const deny = screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement;
    expect(deny.disabled).toBe(true);
    expect(deny.title).toBe('Approvals arrive in a later update');
  });

  it('announces the newest incoming message politely', () => {
    render(<Conversation name="luna" entries={entries.slice(0, 1)} composer={emptyComposer} onDraft={() => {}} onSend={() => {}} />);
    const live = document.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toContain('luna: <b>bold</b>');
  });

  it('sends on submit, Enter and Cmd+Enter, never when blank', () => {
    const onSend = vi.fn();
    const onDraft = vi.fn();
    const { rerender } = render(<Conversation name="luna" entries={[]} composer={emptyComposer} onDraft={onDraft} onSend={onSend} />);
    expect(screen.getByText("Say hello to luna. Ask for anything — they'll show their work here.")).toBeTruthy();
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Message luna' }), { target: { value: 'hi' } });
    expect(onDraft).toHaveBeenCalledWith('hi');

    rerender(<Conversation name="luna" entries={[]} composer={{ ...emptyComposer, draft: 'hi' }} onDraft={onDraft} onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', metaKey: true });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });
    expect(onSend).toHaveBeenCalledTimes(3);
    // Enter alone sends, as the design; Shift+Enter is left to insert a newline.
    const enter = fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(enter).toBe(false);
    expect(onSend).toHaveBeenCalledTimes(4);
    const shiftEnter = fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', shiftKey: true });
    expect(shiftEnter).toBe(true);
    expect(onSend).toHaveBeenCalledTimes(4);
    expect(screen.getByRole('textbox').getAttribute('title')).toBe('↩ to send · ⇧↩ new line');
  });

  it('never sends on Enter when blank', () => {
    const onSend = vi.fn();
    render(<Conversation name="luna" entries={[]} composer={emptyComposer} onDraft={() => {}} onSend={onSend} />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', metaKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('says Sending… on the button while a message is on its way', () => {
    render(<Conversation name="luna" entries={[]} composer={{ ...emptyComposer, draft: 'hi', sending: true }} onDraft={() => {}} onSend={() => {}} />);
    expect(screen.getByRole('button', { name: 'Sending…' }).textContent).toBe('Sending…');
  });

  it('shows errors inline under the composer and keeps the draft', () => {
    render(
      <Conversation
        name="luna"
        entries={[]}
        composer={{ ...emptyComposer, draft: 'kept', error: 'This companion’s mailbox is full.' }}
        onDraft={() => {}}
        onSend={() => {}}
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe('This companion’s mailbox is full.');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('kept');
  });
});

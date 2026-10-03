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
  it('lists messages oldest first and renders bodies as plain text', () => {
    render(<Conversation name="luna" entries={entries} composer={emptyComposer} onDraft={() => {}} onSend={() => {}} />);
    const items = screen.getByRole('list', { name: 'Conversation with luna' }).querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(items[1].textContent).toContain('You');
    const body = items[0].querySelector('.chat-body')!;
    expect(body.textContent).toBe('<b>bold</b> **not markdown**\n  indented');
    expect(body.querySelector('b')).toBeNull();
    expect(body.querySelector('strong')).toBeNull();
  });

  it('sends on submit and Cmd+Enter, never when blank', () => {
    const onSend = vi.fn();
    const onDraft = vi.fn();
    const { rerender } = render(<Conversation name="luna" entries={[]} composer={emptyComposer} onDraft={onDraft} onSend={onSend} />);
    expect(screen.getByText('Say hello to luna to start chatting.')).toBeTruthy();
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Message to luna' }), { target: { value: 'hi' } });
    expect(onDraft).toHaveBeenCalledWith('hi');

    rerender(<Conversation name="luna" entries={[]} composer={{ ...emptyComposer, draft: 'hi' }} onDraft={onDraft} onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', metaKey: true });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(2);
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

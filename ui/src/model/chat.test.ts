import { describe, expect, it } from 'vitest';
import {
  addSent,
  beginSend,
  canSend,
  conversationOf,
  emptyChat,
  emptyComposer,
  markRead,
  mergeIncoming,
  sendErrorText,
  sendFailed,
  sendKey,
  sendSucceeded,
  senderKey,
  unreadOf,
  fromStored,
  STORED_ENTRIES,
  toStored,
} from './chat';
import { inboxMessage } from './fixtures';

describe('senderKey', () => {
  it('keys a soul sender by account/agentId', () => {
    expect(senderKey(inboxMessage('msg_1', 1))).toBe('user/agent_p');
  });

  it('rejects malformed messages and non-soul senders', () => {
    expect(senderKey(null)).toBeNull();
    expect(senderKey({ ...inboxMessage('msg_1', 1), id: '' })).toBeNull();
    expect(senderKey({ ...inboxMessage('msg_1', 1), body: 3 })).toBeNull();
    expect(senderKey({ ...inboxMessage('msg_1', 1), from: { principal: 'principal_y' } })).toBeNull();
    // The broker contract's required fields; anything less stays in the mailbox.
    expect(senderKey({ ...inboxMessage('msg_1', 1), seq: undefined })).toBeNull();
    expect(senderKey({ ...inboxMessage('msg_1', 1), kind: undefined })).toBeNull();
    expect(senderKey({ ...inboxMessage('msg_1', 1), to: {} })).toBeNull();
  });
});

describe('mergeIncoming', () => {
  it('stores messages per soul, oldest first, counting unread', () => {
    const { state, stored } = mergeIncoming(emptyChat, [
      inboxMessage('msg_2', 2),
      inboxMessage('msg_1', 1),
      inboxMessage('msg_3', 3, 'hi', { account: 'other', agentId: 'agent_p' }),
    ]);
    expect(stored).toEqual(['msg_2', 'msg_1', 'msg_3']);
    expect(conversationOf(state, 'user/agent_p').entries.map((e) => e.id)).toEqual(['msg_1', 'msg_2']);
    expect(unreadOf(state, 'user/agent_p')).toBe(2);
    // Same agent ID under another account is a different conversation.
    expect(unreadOf(state, 'other/agent_p')).toBe(1);
  });

  it('ignores duplicates but still reports them as stored, so a failed ack is retried', () => {
    const first = mergeIncoming(emptyChat, [inboxMessage('msg_1', 1)]).state;
    const { state, stored } = mergeIncoming(first, [inboxMessage('msg_1', 1), inboxMessage('msg_1', 1)]);
    expect(state).toBe(first);
    expect(stored).toEqual(['msg_1']);
    expect(unreadOf(state, 'user/agent_p')).toBe(1);
  });

  it('never stores or reports malformed messages', () => {
    const { state, stored } = mergeIncoming(emptyChat, [{ id: 'msg_bad' }, inboxMessage('msg_1', 1)]);
    expect(stored).toEqual(['msg_1']);
    expect(state.ids.has('msg_bad')).toBe(false);
  });

  it('delivers messages to the open conversation as read', () => {
    const { state } = mergeIncoming(emptyChat, [inboxMessage('msg_1', 1)], 'user/agent_p');
    expect(unreadOf(state, 'user/agent_p')).toBe(0);
    expect(conversationOf(state, 'user/agent_p').entries).toHaveLength(1);
  });
});

describe('addSent and markRead', () => {
  it('adds a sent message once, in time order', () => {
    const incoming = mergeIncoming(emptyChat, [inboxMessage('msg_1', 1)]).state;
    const sent = addSent(incoming, 'user/agent_p', { messageId: 'msg_s', body: 'reply', at: 5_000, seq: 9 });
    expect(addSent(sent, 'user/agent_p', { messageId: 'msg_s', body: 'reply', at: 6_000 })).toBe(sent);
    const entries = conversationOf(sent, 'user/agent_p').entries;
    expect(entries.map((e) => [e.id, e.direction])).toEqual([['msg_1', 'in'], ['msg_s', 'out']]);
    expect(unreadOf(sent, 'user/agent_p')).toBe(1);
  });

  it('clears unread for one conversation only', () => {
    const { state } = mergeIncoming(emptyChat, [
      inboxMessage('msg_1', 1), inboxMessage('msg_2', 2, 'x', { account: 'user', agentId: 'agent_c' }),
    ]);
    const read = markRead(state, 'user/agent_p');
    expect(unreadOf(read, 'user/agent_p')).toBe(0);
    expect(unreadOf(read, 'user/agent_c')).toBe(1);
    expect(markRead(read, 'user/agent_p')).toBe(read);
    expect(markRead(read, 'nobody/here')).toBe(read);
  });
});

describe('composer keys', () => {
  const keys = () => {
    let n = 0;
    return () => `key-${++n}`;
  };

  it('reuses the key when retrying the same draft and rotates it for the next message', () => {
    const newKey = keys();
    const draft = { ...emptyComposer, draft: 'hello' };
    const first = beginSend(draft, newKey);
    expect(first).toMatchObject({ body: 'hello', key: 'key-1' });
    expect(first.composer.sending).toBe(true);

    const failed = sendFailed(first.composer, 'broker-timeout', 'late');
    expect(failed.draft).toBe('hello');
    expect(failed.error).toMatch(/draft is safe here/);
    const retry = beginSend(failed, newKey);
    expect(retry.key).toBe('key-1');
    expect(retry.composer.error).toBeNull();

    const done = sendSucceeded(retry.composer, 'hello');
    expect(done).toEqual(emptyComposer);
    expect(beginSend({ ...done, draft: 'hello' }, newKey).key).toBe('key-2');
  });

  it('uses a new key once the failed draft is edited', () => {
    const newKey = keys();
    const failed = sendFailed(beginSend({ ...emptyComposer, draft: 'helo' }, newKey).composer, 'rate-limited', '');
    expect(sendKey({ ...failed, draft: 'hello' }, 'hello', newKey)).toBe('key-2');
    expect(sendKey(failed, 'helo', newKey)).toBe('key-1');
  });

  it('keeps text typed while a send was in flight', () => {
    const started = beginSend({ ...emptyComposer, draft: 'one' }, keys());
    expect(sendSucceeded({ ...started.composer, draft: 'one two' }, 'one').draft).toBe('one two');
  });

  it('cannot send blank drafts or while sending', () => {
    expect(canSend(emptyComposer)).toBe(false);
    expect(canSend({ ...emptyComposer, draft: ' \n ' })).toBe(false);
    expect(canSend({ ...emptyComposer, draft: 'x', sending: true })).toBe(false);
    expect(canSend({ ...emptyComposer, draft: 'x' })).toBe(true);
  });

  it('explains the broker errors', () => {
    expect(sendErrorText('unknown-recipient', '')).toMatch(/cannot receive/);
    expect(sendErrorText('rate-limited', '')).toMatch(/Too many/);
    expect(sendErrorText('mailbox-full', '')).toMatch(/mailbox is full/);
    expect(sendErrorText('broker-unreachable', '')).toMatch(/can’t connect right now/i);
    expect(sendErrorText('weird', 'boom')).toBe('GeniusBar couldn’t send your message. Try again, and ask for help if the problem continues.');
  });
});

describe('chat persistence', () => {
  const entry = (id: string, at: number) => ({ id, direction: 'in' as const, body: `b${id}`, at, seq: at });

  it('round-trips conversations and rebuilds the id set', () => {
    const state = { conversations: { 'a/agent_1': { entries: [entry('m1', 1), entry('m2', 2)], unread: 1 } }, ids: new Set(['m1', 'm2']) };
    const back = fromStored(toStored(state));
    expect(back.conversations).toEqual(state.conversations);
    expect([...back.ids].sort()).toEqual(['m1', 'm2']);
  });

  it('keeps only the newest entries per conversation', () => {
    const entries = Array.from({ length: STORED_ENTRIES + 5 }, (_, i) => entry(`m${i}`, i));
    const back = fromStored(toStored({ conversations: { k: { entries, unread: 0 } }, ids: new Set() }));
    expect(back.conversations.k.entries).toHaveLength(STORED_ENTRIES);
    expect(back.conversations.k.entries[0].id).toBe('m5');
  });

  it('keeps unacked entries however old', () => {
    const entries = Array.from({ length: STORED_ENTRIES + 5 }, (_, i) => entry(`m${i}`, i));
    const back = fromStored(toStored({ conversations: { k: { entries, unread: 0 } }, ids: new Set() }, new Set(['m1'])));
    expect(back.conversations.k.entries).toHaveLength(STORED_ENTRIES + 1);
    expect(back.conversations.k.entries[0].id).toBe('m1');
  });

  it('ignores malformed or foreign data', () => {
    expect(fromStored(null)).toBe(emptyChat);
    expect(fromStored('not json')).toBe(emptyChat);
    expect(fromStored('{"v":2,"conversations":{}}')).toBe(emptyChat);
    const back = fromStored(JSON.stringify({ v: 1, conversations: { k: { entries: [entry('ok', 1), { id: 3 }], unread: 9 } } }));
    expect(back.conversations.k).toEqual({ entries: [entry('ok', 1)], unread: 1 });
  });
});

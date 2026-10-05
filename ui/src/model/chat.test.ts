import { describe, expect, it } from 'vitest';
import {
  addSent,
  beginSend,
  canSend,
  conversationOf,
  emptyChat,
  emptyComposer,
  enforceAggregateBounds,
  markRead,
  MAX_AGGREGATE_ENTRIES,
  MAX_CONVERSATIONS,
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
  type ChatEntry,
  type ChatState,
  type Conversation,
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

describe('aggregate memory bounds (#93)', () => {
  const entry = (id: string, at: number): ChatEntry =>
    ({ id, direction: 'in', body: `b${id}`, at, seq: at });

  function buildState(convCount: number, entriesPerConv: number): ChatState {
    const conversations: Record<string, Conversation> = {};
    const ids = new Set<string>();
    for (let c = 0; c < convCount; c++) {
      const entries: ChatEntry[] = [];
      for (let e = 0; e < entriesPerConv; e++) {
        const id = `m_${c}_${e}`;
        entries.push(entry(id, c * 1_000_000 + e));
        ids.add(id);
      }
      conversations[`account/agent_${c}`] = { entries, unread: 0 };
    }
    return { conversations, ids };
  }

  it('evicts oldest conversations when count exceeds MAX_CONVERSATIONS', () => {
    const count = MAX_CONVERSATIONS + 50;
    const state = buildState(count, 2);
    const bounded = enforceAggregateBounds(state);
    const keys = Object.keys(bounded.conversations);
    expect(keys).toHaveLength(MAX_CONVERSATIONS);
    // The 50 oldest conversations (lowest latest-entry time) should be gone.
    for (let c = 0; c < 50; c++) {
      expect(bounded.conversations[`account/agent_${c}`]).toBeUndefined();
    }
    // The newest should survive.
    for (let c = count - 1; c >= 50; c--) {
      expect(bounded.conversations[`account/agent_${c}`]).toBeDefined();
    }
    // Ids set is consistent.
    let idCount = 0;
    for (const c of Object.values(bounded.conversations)) idCount += c.entries.length;
    expect(bounded.ids.size).toBe(idCount);
  });

  it('evicts oldest entries globally when total exceeds MAX_AGGREGATE_ENTRIES', () => {
    // 20 conversations with 600 entries each = 12,000 entries > 10,000 cap.
    const state = buildState(20, 600);
    const bounded = enforceAggregateBounds(state);
    let total = 0;
    for (const c of Object.values(bounded.conversations)) total += c.entries.length;
    expect(total).toBeLessThanOrEqual(MAX_AGGREGATE_ENTRIES);
    expect(total).toBe(MAX_AGGREGATE_ENTRIES);
    // The 2,000 oldest entries are evicted. Conversation 0 had the oldest
    // entries (times 0..599), so it may have lost all entries and been removed.
    // The newest conversations should retain all their entries.
    const c19 = bounded.conversations['account/agent_19'];
    expect(c19).toBeDefined();
    expect(c19.entries.length).toBe(600);
    // At least some early conversations should have lost entries or been dropped.
    const c0 = bounded.conversations['account/agent_0'];
    const c1 = bounded.conversations['account/agent_1'];
    const earlyEntries = (c0?.entries.length ?? 0) + (c1?.entries.length ?? 0);
    expect(earlyEntries).toBeLessThan(1200);
  });

  it('drops conversations that become empty after entry eviction', () => {
    // 1 conversation with MAX_AGGREGATE_ENTRIES entries (at times 1_000_000+),
    // plus 5 tiny conversations with 1 entry each at time 0..4 (oldest).
    const conversations: Record<string, Conversation> = {};
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const id = `old_${i}`;
      conversations[`account/old_${i}`] = { entries: [entry(id, i)], unread: 1 };
      ids.add(id);
    }
    const bigEntries: ChatEntry[] = [];
    for (let i = 0; i < MAX_AGGREGATE_ENTRIES; i++) {
      const id = `big_${i}`;
      bigEntries.push(entry(id, 1_000_000 + i));
      ids.add(id);
    }
    conversations['account/big'] = { entries: bigEntries, unread: 0 };
    const state: ChatState = { conversations, ids };
    const bounded = enforceAggregateBounds(state);
    // The 5 old single-entry conversations should be gone.
    for (let i = 0; i < 5; i++) {
      expect(bounded.conversations[`account/old_${i}`]).toBeUndefined();
    }
    expect(bounded.conversations['account/big'].entries).toHaveLength(MAX_AGGREGATE_ENTRIES);
  });

  it('is a no-op when within bounds', () => {
    const state = buildState(5, 10);
    expect(enforceAggregateBounds(state)).toBe(state);
  });

  it('is enforced by mergeIncoming on sustained ingress across many conversations', () => {
    let state: ChatState = emptyChat;
    // Simulate sustained ingress: 300 conversations × 50 messages each = 15,000 messages.
    for (let c = 0; c < 300; c++) {
      const messages = Array.from({ length: 50 }, (_, i) =>
        inboxMessage(`m_${c}_${i}`, c * 100 + i, `body ${c}-${i}`, { account: 'user', agentId: `agent_${c}` }),
      );
      const result = mergeIncoming(state, messages);
      state = result.state;
    }
    const convKeys = Object.keys(state.conversations);
    expect(convKeys.length).toBeLessThanOrEqual(MAX_CONVERSATIONS);
    let total = 0;
    for (const c of Object.values(state.conversations)) total += c.entries.length;
    expect(total).toBeLessThanOrEqual(MAX_AGGREGATE_ENTRIES);
  });

  it('is enforced by addSent', () => {
    // Fill to the max, then add one more via addSent.
    const state = buildState(1, MAX_AGGREGATE_ENTRIES);
    const after = addSent(state, 'account/agent_0', {
      messageId: 'sent_new', body: 'hello', at: 999_999_999, seq: 1,
    });
    let total = 0;
    for (const c of Object.values(after.conversations)) total += c.entries.length;
    expect(total).toBeLessThanOrEqual(MAX_AGGREGATE_ENTRIES);
    // The new sent message should be retained (it's the newest).
    expect(after.ids.has('sent_new')).toBe(true);
  });

  it('preserves the existing 500-entry per-conversation serialization rule', () => {
    // Ensure the per-conv STORED_ENTRIES rule still works independently.
    const entries = Array.from({ length: STORED_ENTRIES + 5 }, (_, i) => entry(`m${i}`, i));
    const back = fromStored(toStored({ conversations: { k: { entries, unread: 0 } }, ids: new Set() }));
    expect(back.conversations.k.entries).toHaveLength(STORED_ENTRIES);
    expect(back.conversations.k.entries[0].id).toBe('m5');
  });

  it('enforces bounds when loading from stored data', () => {
    // Simulate stored data with more than MAX_CONVERSATIONS.
    const conversations: Record<string, { entries: ChatEntry[]; unread: number }> = {};
    for (let c = 0; c < MAX_CONVERSATIONS + 10; c++) {
      conversations[`account/agent_${c}`] = { entries: [entry(`m_${c}`, c)], unread: 0 };
    }
    const stored = JSON.stringify({ v: 1, conversations });
    const loaded = fromStored(stored);
    expect(Object.keys(loaded.conversations).length).toBeLessThanOrEqual(MAX_CONVERSATIONS);
  });
});

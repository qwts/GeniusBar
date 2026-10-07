import { describe, expect, it } from 'vitest';
import { addSent, conversationOf, emptyChat, fromStored, markRead, mergeIncoming, mergeStored, toStored, unreadOf } from './chat';
import { inboxMessage } from './fixtures';

const luna = 'user/agent_p';
const scout = 'user/agent_c';

describe('mergeStored (#223)', () => {
  it('takes in what another window stored, in time order, and its unread counts', () => {
    const mine = addSent(emptyChat, luna, { messageId: 'out_1', body: 'hi', at: 1_002, seq: null });
    const theirs = fromStored(toStored(mergeIncoming(emptyChat, [inboxMessage('msg_1', 1), inboxMessage('msg_3', 3),
      inboxMessage('msg_9', 9, 'yo', { account: 'user', agentId: 'agent_c' })]).state));
    const { state, ahead } = mergeStored(mine, theirs);
    expect(conversationOf(state, luna).entries.map((e) => e.id)).toEqual(['msg_1', 'out_1', 'msg_3']);
    expect(unreadOf(state, luna)).toBe(2);
    expect(unreadOf(state, scout)).toBe(1);
    // This window holds out_1, which the other lacks: it saves back.
    expect(ahead).toBe(true);
    expect(mergeStored(state, fromStored(toStored(state))).ahead).toBe(false);
  });

  it('changes nothing when the other window holds nothing new', () => {
    const mine = mergeIncoming(emptyChat, [inboxMessage('msg_1', 1)]).state;
    const merged = mergeStored(mine, fromStored(toStored(mine)));
    expect(merged.state).toBe(mine);
    expect(merged.ahead).toBe(false);
  });

  it('keeps the conversation on screen read, and says so to the others', () => {
    const theirs = fromStored(toStored(mergeIncoming(emptyChat, [inboxMessage('msg_1', 1)]).state));
    const { state, ahead } = mergeStored(emptyChat, theirs, luna);
    expect(conversationOf(state, luna).entries).toHaveLength(1);
    expect(unreadOf(state, luna)).toBe(0);
    expect(ahead).toBe(true);
    // A read made elsewhere reads here too.
    const unreadHere = mergeIncoming(emptyChat, [inboxMessage('msg_1', 1)]).state;
    expect(unreadOf(mergeStored(unreadHere, fromStored(toStored(markRead(unreadHere, luna)))).state, luna)).toBe(0);
  });
});

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeError } from './bridge';
import { conversationOf, MAX_AGGREGATE_ENTRIES, MAX_CONVERSATIONS, unreadOf } from './model/chat';
import { inboxMessage } from './model/fixtures';
import { CHAT_STORAGE_KEY, INBOX_PAGE, pollInbox, sendMessage, useChat, type AgentBotFeed } from './useChat';

afterEach(() => { cleanup(); globalThis.localStorage?.clear(); });

type Call = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

function memoryStorage() {
  const saved = new Map<string, string>();
  return { saved, getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => { saved.set(k, v); } };
}

describe('pollInbox', () => {
  it('pages by cursor while messages remain, storing each page before acking it', async () => {
    const log: string[] = [];
    const pages = [
      { messages: [inboxMessage('msg_1', 1), inboxMessage('msg_2', 2)], cursor: 2, remaining: 1 },
      { messages: [inboxMessage('msg_3', 3)], cursor: 3, remaining: 0 },
    ];
    const callImpl: Call = async (method, params) => {
      log.push(`${method} ${JSON.stringify(params)}`);
      if (method === 'inbox') return { ok: true, ...pages.shift() };
      return { ok: true, acknowledged: 1 };
    };
    const outcome = await pollInbox(callImpl as never, (messages) => {
      log.push(`store ${messages.length}`);
      return (messages as { id: string }[]).map((m) => m.id).filter((id) => id !== 'msg_2');
    });
    expect(outcome).toEqual({ ok: true });
    expect(log).toEqual([
      'inbox {"after":0,"limit":100}',
      'store 2',
      'ack {"ids":["msg_1"]}',
      'inbox {"after":2,"limit":100}',
      'store 1',
      'ack {"ids":["msg_3"]}',
    ]);
  });

  it('skips the ack when nothing was stored and reports bridge errors', async () => {
    const callImpl = vi.fn(async () => ({ ok: true, messages: [], cursor: 0, remaining: 0 }));
    expect(await pollInbox(callImpl as never, () => [])).toEqual({ ok: true });
    expect(callImpl).toHaveBeenCalledOnce();
    const failing = async () => { throw new BridgeError('broker-unreachable', 'down'); };
    expect(await pollInbox(failing as never, () => [])).toEqual({ ok: false, code: 'broker-unreachable', message: 'down' });
  });
});

describe('sendMessage', () => {
  it('sends to the address with the key and returns the message id', async () => {
    const callImpl = vi.fn(async () => ({ ok: true, messageId: 'msg_s', seq: 7, duplicate: false, wake: 'waiting' }));
    expect(await sendMessage(callImpl as never, 'user/agent_p', 'hi', 'k1'))
      .toEqual({ ok: true, messageId: 'msg_s', seq: 7, duplicate: false });
    expect(callImpl).toHaveBeenCalledWith('send', { to: 'user/agent_p', body: 'hi', key: 'k1' });
  });

  it('returns coded errors', async () => {
    const failing = async () => { throw new BridgeError('mailbox-full', 'full'); };
    expect(await sendMessage(failing as never, 'a/b', 'hi', 'k')).toEqual({ ok: false, code: 'mailbox-full', message: 'full' });
  });
});

describe('useChat', () => {
  function fakeBridge() {
    const inbox: unknown[] = [];
    const acked: string[] = [];
    const sends: Record<string, unknown>[] = [];
    let sendError: BridgeError | null = null;
    const callImpl: Call = async (method, params = {}) => {
      if (method === 'inbox') {
        const messages = inbox.filter((m) => !acked.includes((m as { id: string }).id));
        return { ok: true, messages, cursor: 0, remaining: 0 };
      }
      if (method === 'ack') {
        acked.push(...(params.ids as string[]));
        return { ok: true };
      }
      sends.push(params);
      if (sendError) throw sendError;
      return { ok: true, messageId: `msg_sent_${params.key}`, seq: 50, duplicate: false };
    };
    return { inbox, acked, sends, callImpl, failSends: (e: BridgeError | null) => { sendError = e; } };
  }

  it('polls, stores, acks, and marks the open conversation read', async () => {
    const bridge = fakeBridge();
    bridge.inbox.push(inboxMessage('msg_1', 1));
    const { result } = renderHook(() => useChat({
      enabled: true, callImpl: bridge.callImpl as never, intervalMs: 20, storage: memoryStorage(),
    }));
    await waitFor(() => expect(bridge.acked).toEqual(['msg_1']));
    expect(unreadOf(result.current.chat, 'user/agent_p')).toBe(1);

    act(() => result.current.open('user/agent_p'));
    expect(unreadOf(result.current.chat, 'user/agent_p')).toBe(0);
    bridge.inbox.push(inboxMessage('msg_2', 2));
    await waitFor(() => expect(conversationOf(result.current.chat, 'user/agent_p').entries).toHaveLength(2));
    expect(unreadOf(result.current.chat, 'user/agent_p')).toBe(0);
  });

  it('keeps the draft and key across a failed send, then shows the sent message', async () => {
    const bridge = fakeBridge();
    let n = 0;
    const { result } = renderHook(() => useChat({
      enabled: false, callImpl: bridge.callImpl as never, newKey: () => `k${++n}`, now: () => 9_000,
      storage: memoryStorage(),
    }));
    act(() => result.current.setDraft('user/agent_p', 'hello'));
    bridge.failSends(new BridgeError('rate-limited', 'slow down'));
    await act(() => result.current.send('user/agent_p'));
    expect(result.current.composers['user/agent_p']).toMatchObject({ draft: 'hello', sending: false });
    expect(result.current.composers['user/agent_p'].error).toMatch(/Too many/);
    expect(conversationOf(result.current.chat, 'user/agent_p').entries).toHaveLength(0);

    bridge.failSends(null);
    await act(() => result.current.send('user/agent_p'));
    expect(bridge.sends.map((s) => s.key)).toEqual(['k1', 'k1']);
    expect(result.current.composers['user/agent_p']).toMatchObject({ draft: '', error: null });
    expect(conversationOf(result.current.chat, 'user/agent_p').entries)
      .toEqual([{ id: 'msg_sent_k1', direction: 'out', body: 'hello', at: 9_000, seq: 50 }]);

    act(() => result.current.setDraft('user/agent_p', 'again'));
    await act(() => result.current.send('user/agent_p'));
    expect(bridge.sends.map((s) => s.key)).toEqual(['k1', 'k1', 'k2']);
  });

  it('does not ack what it cannot save', async () => {
    for (const storage of [null, { getItem: () => null, setItem: () => { throw new Error('quota'); } }]) {
      const bridge = fakeBridge();
      bridge.inbox.push(inboxMessage('msg_1', 1));
      const { result, unmount } = renderHook(() => useChat({
        enabled: true, callImpl: bridge.callImpl as never, intervalMs: 20, storage,
      }));
      await waitFor(() => expect(conversationOf(result.current.chat, 'user/agent_p').entries).toHaveLength(1));
      await new Promise((r) => setTimeout(r, 60));
      expect(bridge.acked).toEqual([]);
      unmount();
    }
  });

  it('keeps the draft and key when a delivered send cannot be saved, and retries the save', async () => {
    const bridge = fakeBridge();
    const storage = memoryStorage();
    let failSave = true;
    const flaky = { getItem: storage.getItem, setItem: (k: string, v: string) => {
      if (failSave) throw new Error('quota');
      storage.setItem(k, v);
    } };
    const { result } = renderHook(() => useChat({
      enabled: false, callImpl: bridge.callImpl as never, newKey: () => 'k1', storage: flaky,
    }));
    act(() => result.current.setDraft('user/agent_p', 'hello'));
    await act(() => result.current.send('user/agent_p'));
    expect(result.current.composers['user/agent_p']).toMatchObject({
      draft: 'hello', sending: false, pending: { body: 'hello', key: 'k1' },
    });
    expect(result.current.composers['user/agent_p'].error).toMatch(/could not be saved/);

    failSave = false;
    await act(() => result.current.send('user/agent_p'));
    expect(bridge.sends.map((s) => s.key)).toEqual(['k1', 'k1']);
    expect(result.current.composers['user/agent_p']).toMatchObject({ draft: '', error: null });
    expect(storage.saved.get(CHAT_STORAGE_KEY)).toContain('msg_sent_k1');
  });
});

describe('useChat persistence', () => {
  it('saves before acking, and a new session starts from the saved history', async () => {
    const saved = new Map<string, string>();
    const storage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => { saved.set(k, v); } };
    const order: string[] = [];
    const message = inboxMessage('msg_p1', 1, 'kept');
    const callImpl = (async (method: string) => {
      if (method === 'inbox') return { messages: order.includes('ack') ? [] : [message], cursor: 1, remaining: 0 };
      if (method === 'ack') { order.push(saved.has(CHAT_STORAGE_KEY) ? 'ack' : 'ack-before-save'); return { ok: true }; }
      return {};
    }) as never;
    const first = renderHook(() => useChat({ enabled: true, callImpl, storage, intervalMs: 60_000 }));
    await waitFor(() => expect(order).toEqual(['ack']));
    first.unmount();
    const second = renderHook(() => useChat({ enabled: false, callImpl, storage }));
    const key = Object.keys(second.result.current.chat.conversations)[0];
    expect(second.result.current.chat.conversations[key].entries.map((e) => ('body' in e ? e.body : e.kind))).toEqual(['kept']);
  });
});

describe('useChat aggregate bounds (#93)', () => {
  it('enforces bounds under sustained ingress from many senders via polling', async () => {
    // Simulate a flood: each poll page returns messages from different senders.
    let seq = 0;
    let pageNum = 0;
    const totalPages = 300; // 300 pages × 100 messages = 30,000 messages from 300 senders
    const callImpl: Call = async (method) => {
      if (method === 'inbox') {
        if (pageNum >= totalPages) {
          return { ok: true, messages: [], cursor: 0, remaining: 0 };
        }
        const batch = pageNum;
        pageNum++;
        const messages = Array.from({ length: INBOX_PAGE }, (_, i) => {
          seq++;
          return inboxMessage(
            `flood_${batch}_${i}`, seq, `flood body ${batch}-${i}`,
            { account: 'attacker', agentId: `agent_${batch}` },
          );
        });
        return { ok: true, messages, cursor: seq, remaining: totalPages - pageNum > 0 ? 1 : 0 };
      }
      if (method === 'ack') return { ok: true };
      return {};
    };
    const storage = memoryStorage();
    const { result } = renderHook(() => useChat({
      enabled: true, callImpl: callImpl as never, intervalMs: 10, storage,
    }));
    // Wait for several polls to process.
    await waitFor(() => {
      const convCount = Object.keys(result.current.chat.conversations).length;
      return expect(convCount).toBeGreaterThan(0);
    }, { timeout: 10_000 });
    // Let polls run for a while to accumulate many messages.
    await new Promise((r) => setTimeout(r, 500));
    // Verify aggregate bounds are held.
    const chat = result.current.chat;
    const convCount = Object.keys(chat.conversations).length;
    expect(convCount).toBeLessThanOrEqual(MAX_CONVERSATIONS);
    let totalEntries = 0;
    for (const c of Object.values(chat.conversations)) totalEntries += c.entries.length;
    expect(totalEntries).toBeLessThanOrEqual(MAX_AGGREGATE_ENTRIES);
  }, 30_000);  // a 30,000-message flood: slow on a loaded CI runner
});

describe('useChat asides and approvals (#122, #85, #86)', () => {
  const quietBridge = (async (method: string) => (method === 'inbox' ? { messages: [], cursor: 0, remaining: 0 } : { ok: true })) as never;

  it('shows the open soul’s asides and pending approvals, and decides through agent-bot', async () => {
    const afters: (string | null)[] = [];
    const decisions: [string, string][] = [];
    let pending = [{ proposalId: 'p1', agentId: 'agent_p', soul: 'luna', tool: 'Bash', summary: 'git push',
      createdAt: '2026-10-05T10:00:00Z', expiresAt: null, status: 'pending' }];
    const feed: AgentBotFeed = {
      asides: async (_agentId, after) => {
        afters.push(after);
        return after === null
          ? { asides: [{ id: 'aside_1', at: '2026-10-05T09:00:00Z', dir: 'out', via: 'send_message', reshown: false,
            peer: { address: 'user/agent_c', agentId: 'agent_c', principal: null, name: null },
            messageId: 'm1', replyTo: null, correlation: null, teamId: 'agent_p', body: 'check CI' }], next: null }
          : { asides: [], next: null };
      },
      approvals: async () => pending,
      decide: async (proposalId, decision) => {
        decisions.push([proposalId, decision]);
        pending = [];
        return { ...pending[0], proposalId, agentId: 'agent_p', soul: null, tool: 'Bash', summary: 'git push', createdAt: '',
          expiresAt: null, status: decision === 'deny' ? 'denied' : 'approved' };
      },
    };
    const roster = [
      { account: 'user', agentId: 'agent_p', name: 'luna', harness: null, parent: null, presence: 'joined' as const, unacked: 0, lastWake: null },
      { account: 'user', agentId: 'agent_c', name: 'scout', harness: null, parent: 'agent_p', presence: 'joined' as const, unacked: 0, lastWake: null },
    ];
    const { result } = renderHook(() => useChat({ enabled: true, callImpl: quietBridge, intervalMs: 60_000, storage: memoryStorage(), feed, roster }));
    act(() => result.current.open('user/agent_p'));
    await waitFor(() => expect(conversationOf(result.current.chat, 'user/agent_p').entries).toHaveLength(2));
    const [aside, approval] = conversationOf(result.current.chat, 'user/agent_p').entries;
    expect(aside).toMatchObject({ kind: 'aside', from: 'luna', to: 'scout', body: 'check CI', team: 'luna' });
    expect(approval).toMatchObject({ kind: 'approval_request', id: 'p1', tool: 'Bash', args: 'git push', risk: 'external', status: 'pending' });
    expect(unreadOf(result.current.chat, 'user/agent_p')).toBe(0);

    await act(() => result.current.resolve!('user/agent_p', 'p1', 'approved_session'));
    expect(decisions).toEqual([]);
    await act(() => result.current.resolve!('user/agent_p', 'p1', 'approved'));
    expect(decisions).toEqual([['p1', 'approve']]);
    expect(conversationOf(result.current.chat, 'user/agent_p').entries[1]).toMatchObject({ id: 'p1', status: 'approved', deciding: false });
  });

  it('keeps a failed decision pending with its reason', async () => {
    const feed: AgentBotFeed = {
      asides: async () => null,
      approvals: async () => [{ proposalId: 'p1', agentId: 'agent_p', soul: null, tool: null, summary: 'rm -rf dist',
        createdAt: '2026-10-05T10:00:00Z', expiresAt: null, status: 'pending' }],
      decide: async () => { throw new BridgeError('presence-declined', 'the owner did not confirm'); },
    };
    const { result } = renderHook(() => useChat({ enabled: true, callImpl: quietBridge, intervalMs: 60_000, storage: memoryStorage(), feed }));
    act(() => result.current.open('user/agent_p'));
    await waitFor(() => expect(conversationOf(result.current.chat, 'user/agent_p').entries).toHaveLength(1));
    await act(() => result.current.resolve!('user/agent_p', 'p1', 'denied'));
    expect(conversationOf(result.current.chat, 'user/agent_p').entries[0])
      .toMatchObject({ status: 'pending', deciding: false, error: 'the owner did not confirm', tool: 'tool' });
  });
});

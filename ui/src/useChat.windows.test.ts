import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { conversationOf, emptyChat, mergeIncoming, toStored } from './model/chat';
import { inboxMessage, sampleApprovals } from './model/fixtures';
import { APPROVALS_STORAGE_KEY, CHAT_STORAGE_KEY, useChat } from './useChat';

afterEach(() => { cleanup(); });

function memoryStorage(initial: Record<string, string> = {}) {
  const saved = new Map(Object.entries(initial));
  return { saved, getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => { saved.set(k, v); } };
}

describe('useChat across the app\'s windows (#223)', () => {
  it('shows what another window stored, and saves back what only it holds', () => {
    const storage = memoryStorage();
    const { result } = renderHook(() => useChat({ enabled: false, storage }));
    const other = mergeIncoming(emptyChat, [inboxMessage('msg_1', 1)]).state;
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: CHAT_STORAGE_KEY, newValue: toStored(other) })); });
    expect(conversationOf(result.current.chat, 'user/agent_p').entries.map((e) => e.id)).toEqual(['msg_1']);
    // Nothing of its own yet: it does not write.
    expect(storage.saved.has(CHAT_STORAGE_KEY)).toBe(false);
    act(() => result.current.open('user/agent_p'));
    const later = mergeIncoming(other, [inboxMessage('msg_2', 2)]).state;
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: CHAT_STORAGE_KEY, newValue: toStored(later) })); });
    // On screen here, so read here, and saved back read for the others.
    expect(JSON.parse(storage.saved.get(CHAT_STORAGE_KEY)!).conversations['user/agent_p'].unread).toBe(0);
    expect(conversationOf(result.current.chat, 'user/agent_p').entries).toHaveLength(2);
  });

  it('a window that does not poll shows the approvals another one read', () => {
    const stored = JSON.stringify({ approvals: sampleApprovals.slice(0, 1) });
    const storage = memoryStorage({ [APPROVALS_STORAGE_KEY]: stored });
    const { result } = renderHook(() => useChat({ enabled: false, storage }));
    expect(result.current.approvals?.records.map((r) => r.proposalId)).toEqual(['prop_2']);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: APPROVALS_STORAGE_KEY, newValue: JSON.stringify({ approvals: sampleApprovals }) }));
    });
    expect(result.current.approvals?.records.map((r) => r.proposalId)).toEqual(['prop_2', 'prop_1']);
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: APPROVALS_STORAGE_KEY, newValue: 'nope' })); });
    expect(result.current.approvals?.records).toHaveLength(2);
  });

  it('a polling window shares the approvals it reads', async () => {
    const storage = memoryStorage();
    const feed = { asides: async () => null, approvals: async () => [...sampleApprovals], decide: async () => { throw new Error('no'); } };
    const quiet = (async (method: string) => (method === 'inbox' ? { messages: [], cursor: 0, remaining: 0 } : {})) as never;
    renderHook(() => useChat({ enabled: true, callImpl: quiet, intervalMs: 60_000, storage, feed }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(JSON.parse(storage.saved.get(APPROVALS_STORAGE_KEY)!).approvals).toHaveLength(2);
  });
});

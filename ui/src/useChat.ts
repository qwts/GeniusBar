// Chat with souls (#17): polls this principal's inbox every 5 seconds and
// sends from the composer. History is saved to the web view's storage
// before each ack, because an acknowledged message leaves the broker.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BridgeError, call, inApp } from './bridge';
import {
  addSent,
  beginSend,
  canSend,
  emptyComposer,
  fromStored,
  markRead,
  toStored,
  mergeIncoming,
  sendFailed,
  sendSucceeded,
  type ChatState,
  type Composer,
} from './model/chat';

export const INBOX_INTERVAL_MS = 5_000;
/** The broker's largest read page, and the most ids one ack takes. */
export const INBOX_PAGE = 100;
/** Bound on pages per poll, so a flood cannot pin the poller. */
const MAX_PAGES = 20;

interface InboxPage {
  messages: unknown[];
  cursor: number;
  remaining: number;
}

const asBridgeError = (error: unknown) =>
  error instanceof BridgeError ? error : new BridgeError('bridge-error', String(error));

/**
 * One poll: page through the unacked mailbox by cursor while more remain.
 * Each page is stored (via `store`, which returns the ids it now holds)
 * before those ids, and only those, are acked. Starts from the beginning
 * each time, so ids whose ack failed are re-read and acked next poll.
 */
export async function pollInbox(callImpl: typeof call, store: (messages: unknown[]) => string[],
  acked: (ids: string[]) => void = () => {}):
  Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  try {
    let after = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await callImpl<InboxPage>('inbox', { after, limit: INBOX_PAGE });
      const messages = Array.isArray(result?.messages) ? result.messages : [];
      const stored = store(messages);
      if (stored.length) {
        await callImpl('ack', { ids: stored });
        acked(stored);
      }
      if (!(result.remaining > 0) || messages.length === 0 || !(result.cursor > after)) break;
      after = result.cursor;
    }
    return { ok: true };
  } catch (error) {
    const e = asBridgeError(error);
    return { ok: false, code: e.code, message: e.message };
  }
}

export type SendOutcome =
  | { ok: true; messageId: string; seq: number | null; duplicate: boolean }
  | { ok: false; code: string; message: string };

/** Send one body to a soul's `account/agentId` address with the given key. */
export async function sendMessage(callImpl: typeof call, to: string, body: string, key: string): Promise<SendOutcome> {
  try {
    const result = await callImpl<{ messageId: string; seq?: number; duplicate?: boolean }>('send', { to, body, key });
    if (typeof result?.messageId !== 'string') return { ok: false, code: 'bad-response', message: 'send returned no message id' };
    return { ok: true, messageId: result.messageId, seq: typeof result.seq === 'number' ? result.seq : null,
      duplicate: result.duplicate === true };
  } catch (error) {
    const e = asBridgeError(error);
    return { ok: false, code: e.code, message: e.message };
  }
}

/** Where chat history is kept; the app's web view local storage by default. */
export type ChatStorage = Pick<Storage, 'getItem' | 'setItem'>;
export const CHAT_STORAGE_KEY = 'geniusbar.chat';

function defaultStorage(): ChatStorage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export interface ChatOptions {
  storage?: ChatStorage | null;
  enabled?: boolean;
  callImpl?: typeof call;
  newKey?: () => string;
  now?: () => number;
  intervalMs?: number;
}

export interface ChatApi {
  chat: ChatState;
  composers: Readonly<Record<string, Composer>>;
  /** The conversation on screen, or null; it is marked read as messages arrive. */
  open: (key: string | null) => void;
  setDraft: (key: string, draft: string) => void;
  send: (key: string) => Promise<void>;
}

export function useChat({
  enabled = inApp(),
  callImpl = call,
  newKey = () => crypto.randomUUID(),
  now = Date.now,
  intervalMs = INBOX_INTERVAL_MS,
  storage = defaultStorage(),
}: ChatOptions = {}): ChatApi {
  const saved = useRef<ChatStorage | null>(storage);
  const [initial] = useState(() => {
    try { return fromStored(storage?.getItem(CHAT_STORAGE_KEY) ?? null); } catch { return fromStored(null); }
  });
  // The ref is the source of truth so a poll stores, and saves,
  // synchronously before it acks; state mirrors it for rendering.
  const store = useRef<ChatState>(initial);
  const [chat, setChat] = useState<ChatState>(initial);
  // Ids stored but not yet acked; kept on disk past the STORED_ENTRIES window.
  const unacked = useRef<Set<string>>(new Set());
  /** Applies `fn` and saves; returns false when the history could not be saved. */
  const update = useCallback((fn: (s: ChatState) => ChatState): boolean => {
    store.current = fn(store.current);
    setChat(store.current);
    if (!saved.current) return false;
    try {
      saved.current.setItem(CHAT_STORAGE_KEY, toStored(store.current, unacked.current));
      return true;
    } catch {
      return false;
    }
  }, []);

  const composerRef = useRef<Record<string, Composer>>({});
  const [composers, setComposers] = useState<Readonly<Record<string, Composer>>>({});
  const updateComposer = useCallback((key: string, fn: (c: Composer) => Composer) => {
    composerRef.current = { ...composerRef.current, [key]: fn(composerRef.current[key] ?? emptyComposer) };
    setComposers(composerRef.current);
  }, []);

  const openKey = useRef<string | null>(null);
  const deps = useRef({ callImpl, newKey, now });
  deps.current = { callImpl, newKey, now };

  const inFlight = useRef(false);
  const poll = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      // Without a saved copy an ack would delete the only one, so an
      // unsaved page is left in the mailbox to be read again next poll.
      await pollInbox(deps.current.callImpl, (messages) => {
        let stored: string[] = [];
        const ok = update((s) => {
          const merged = mergeIncoming(s, messages, openKey.current);
          stored = merged.stored;
          stored.forEach((id) => unacked.current.add(id));
          return merged.state;
        });
        return ok ? stored : [];
      }, (ids) => ids.forEach((id) => unacked.current.delete(id)));
    } finally {
      inFlight.current = false;
    }
  }, [update]);

  useEffect(() => {
    if (!enabled) return;
    void poll();
    const timer = setInterval(() => { void poll(); }, intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs, poll]);

  const open = useCallback((key: string | null) => {
    openKey.current = key;
    if (key !== null) update((s) => markRead(s, key));
  }, [update]);

  const setDraft = useCallback((key: string, draft: string) => {
    updateComposer(key, (c) => ({ ...c, draft }));
  }, [updateComposer]);

  const send = useCallback(async (key: string) => {
    const current = composerRef.current[key] ?? emptyComposer;
    if (!canSend(current)) return;
    const started = beginSend(current, deps.current.newKey);
    updateComposer(key, () => started.composer);
    const outcome = await sendMessage(deps.current.callImpl, key, started.body, started.key);
    if (outcome.ok) {
      const saved = update((s) => addSent(s, key,
        { messageId: outcome.messageId, body: started.body, at: deps.current.now(), seq: outcome.seq }));
      // Delivered but unsaved: keep the draft and its key, so sending again
      // is a broker duplicate that retries the save without a second copy.
      updateComposer(key, (c) => saved ? sendSucceeded(c, started.body)
        : sendFailed(c, 'not-saved', ''));
    } else {
      updateComposer(key, (c) => sendFailed(c, outcome.code, outcome.message));
    }
  }, [update, updateComposer]);

  return useMemo(() => ({ chat, composers, open, setDraft, send }), [chat, composers, open, setDraft, send]);
}

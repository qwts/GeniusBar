// Chat with souls (#17): pure state for conversations, unread counts and
// the composer's idempotency keys. Display and bookkeeping only; the
// broker decides who may message whom.
//
// Message shape, from agent-comms lib/broker/mailbox.mjs (send/read):
//   { id: 'msg_<uuid>', seq, at: epoch ms, from, to, kind, body, refs,
//     correlation, replyTo, depth, wake }
// where an endpoint is { account, agentId, verification? } for a soul or
// { principal } for a principal. A principal's mailbox only ever holds
// messages from souls, and its own sends are not echoed back to it.

/** A message as the principal client's `inbox` returns it. */
export interface InboxMessage {
  id: string;
  seq: number;
  at: number;
  from: { account?: string; agentId?: string; principal?: string; verification?: string };
  to: { account?: string; agentId?: string; principal?: string };
  kind: string;
  body: string;
  refs?: string[];
  correlation?: string | null;
  replyTo?: string | null;
  depth?: number;
  wake?: string;
}

/** One line of a conversation, either direction. Bodies are plain text. */
export interface ChatEntry {
  id: string;
  direction: 'in' | 'out';
  body: string;
  /** Epoch ms: broker time for incoming, local time for sent. */
  at: number;
  /** Broker sequence when known; orders entries sent in the same ms. */
  seq: number | null;
}

export interface Conversation {
  /** Oldest first, so the newest renders at the bottom. */
  entries: readonly ChatEntry[];
  unread: number;
}

export interface ChatState {
  /** Keyed by `account/agentId`, the roster key and the send address. */
  conversations: Readonly<Record<string, Conversation>>;
  /** Every message id held, incoming or sent, for dedupe. */
  ids: ReadonlySet<string>;
}

export const emptyChat: ChatState = { conversations: {}, ids: new Set() };

const EMPTY_CONVERSATION: Conversation = { entries: [], unread: 0 };

export function conversationOf(state: ChatState, key: string): Conversation {
  return state.conversations[key] ?? EMPTY_CONVERSATION;
}

export function unreadOf(state: ChatState, key: string): number {
  return state.conversations[key]?.unread ?? 0;
}

/**
 * Conversation key for an incoming message's sender, or null when the
 * message is not a well-formed message from a soul. Such messages are
 * neither stored nor acked.
 */
export function senderKey(message: unknown): string | null {
  const m = message as Partial<InboxMessage> | null;
  if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id) return null;
  if (typeof m.body !== 'string' || typeof m.at !== 'number' || typeof m.seq !== 'number') return null;
  if (typeof m.kind !== 'string' || typeof m.to?.principal !== 'string' || !m.to.principal) return null;
  const from = m.from;
  if (!from || typeof from.account !== 'string' || typeof from.agentId !== 'string') return null;
  if (!from.account || !from.agentId) return null;
  return `${from.account}/${from.agentId}`;
}

function byTime(a: ChatEntry, b: ChatEntry): number {
  if (a.at !== b.at) return a.at - b.at;
  if (a.seq !== null && b.seq !== null) return a.seq - b.seq;
  return 0;
}

function addEntry(state: ChatState, key: string, entry: ChatEntry, unreadDelta: number): ChatState {
  const prev = conversationOf(state, key);
  const entries = [...prev.entries, entry].sort(byTime);
  const ids = new Set(state.ids);
  ids.add(entry.id);
  return {
    conversations: { ...state.conversations, [key]: { entries, unread: prev.unread + unreadDelta } },
    ids,
  };
}

/**
 * Store a page of inbox messages, ignoring ids already held. Returns the
 * new state and the ids now stored (fresh and previously held alike):
 * exactly the ids that are safe to ack. Messages to the open conversation
 * arrive read.
 */
export function mergeIncoming(state: ChatState, messages: readonly unknown[], openKey: string | null = null):
  { state: ChatState; stored: string[] } {
  let next = state;
  const stored: string[] = [];
  for (const raw of messages) {
    const key = senderKey(raw);
    if (key === null) continue;
    const m = raw as InboxMessage;
    if (!next.ids.has(m.id)) {
      next = addEntry(next, key, {
        id: m.id, direction: 'in', body: m.body, at: m.at, seq: m.seq,
      }, key === openKey ? 0 : 1);
    }
    if (!stored.includes(m.id)) stored.push(m.id);
  }
  return { state: enforceAggregateBounds(next), stored };
}

/** Record a message this principal sent once `send` succeeded. */
export function addSent(state: ChatState, key: string,
  sent: { messageId: string; body: string; at: number; seq?: number | null }): ChatState {
  if (state.ids.has(sent.messageId)) return state;
  return enforceAggregateBounds(addEntry(state, key, {
    id: sent.messageId, direction: 'out', body: sent.body, at: sent.at, seq: sent.seq ?? null,
  }, 0));
}

export function markRead(state: ChatState, key: string): ChatState {
  const prev = state.conversations[key];
  if (!prev || prev.unread === 0) return state;
  return { ...state, conversations: { ...state.conversations, [key]: { ...prev, unread: 0 } } };
}

// ---- Composer -------------------------------------------------------------

/**
 * One conversation's composer. `pending` remembers the key of the last
 * attempt that did not succeed, so retrying the same draft resends with
 * the same key and the broker returns the original message instead of
 * delivering it twice.
 */
export interface Composer {
  draft: string;
  pending: { body: string; key: string } | null;
  sending: boolean;
  error: string | null;
}

export const emptyComposer: Composer = { draft: '', pending: null, sending: false, error: null };

export function canSend(composer: Composer): boolean {
  return !composer.sending && composer.draft.trim() !== '';
}

/**
 * The idempotency key for sending `body`: the pending key when this is a
 * retry of the same text, otherwise a fresh one. A changed draft is a new
 * message; reusing its key would be a broker `conflict`.
 */
export function sendKey(composer: Composer, body: string, newKey: () => string): string {
  return composer.pending && composer.pending.body === body ? composer.pending.key : newKey();
}

/** Start a send; returns the composer and the exact body and key to send. */
export function beginSend(composer: Composer, newKey: () => string):
  { composer: Composer; body: string; key: string } {
  const body = composer.draft;
  const key = sendKey(composer, body, newKey);
  return { composer: { ...composer, pending: { body, key }, sending: true, error: null }, body, key };
}

/** The send landed: clear the draft, but only if it was not edited meanwhile. */
export function sendSucceeded(composer: Composer, body: string): Composer {
  return { draft: composer.draft === body ? '' : composer.draft, pending: null, sending: false, error: null };
}

/** The send failed: keep the draft and its key, show the error inline. */
export function sendFailed(composer: Composer, code: string, message: string): Composer {
  return { ...composer, sending: false, error: sendErrorText(code, message) };
}

export function sendErrorText(code: string, _message: string): string {
  switch (code) {
    case 'unknown-recipient':
      return 'This companion cannot receive your messages: it may have left, or it does not accept messages from you.';
    case 'rate-limited':
      return 'Too many messages in the last minute. Wait a moment, then send again.';
    case 'mailbox-full':
      return 'This companion’s mailbox is full. Send again once it has read some messages.';
    case 'message-too-large':
      return 'This message is too large to send. Shorten it and try again.';
    case 'broker-unreachable':
    case 'broker-timeout':
      return 'GeniusBar can’t connect right now. Your draft is safe here; try sending again in a moment.';
    case 'not-saved':
      return 'Sent, but your history could not be saved. Send again to retry saving; it will not be delivered twice.';
    default:
      return 'GeniusBar couldn’t send your message. Try again, and ask for help if the problem continues.';
  }
}

// ---- Aggregate bounds (#93) -----------------------------------------------

/** Hard cap on the number of conversations retained in memory. */
export const MAX_CONVERSATIONS = 200;

/** Hard cap on the total number of entries across all conversations. */
export const MAX_AGGREGATE_ENTRIES = 10_000;

/**
 * Enforces aggregate memory bounds on the chat state:
 * 1. Evicts oldest conversations when count exceeds MAX_CONVERSATIONS.
 * 2. Evicts oldest entries across all conversations when total exceeds
 *    MAX_AGGREGATE_ENTRIES, dropping conversations that become empty.
 */
export function enforceAggregateBounds(state: ChatState): ChatState {
  let convs = state.conversations;
  let ids = state.ids;

  // 1. Bound conversation count: evict oldest conversations first.
  const keys = Object.keys(convs);
  if (keys.length > MAX_CONVERSATIONS) {
    // Sort conversations by latest entry time ascending (oldest last-activity first).
    const sorted = keys
      .map((k) => {
        const entries = convs[k].entries;
        const latest = entries.length > 0 ? entries[entries.length - 1].at : 0;
        return { key: k, latest };
      })
      .sort((a, b) => a.latest - b.latest);
    const evictCount = keys.length - MAX_CONVERSATIONS;
    const evictKeys = new Set(sorted.slice(0, evictCount).map((s) => s.key));
    const nextConvs: Record<string, Conversation> = {};
    const nextIds = new Set<string>();
    for (const [k, c] of Object.entries(convs)) {
      if (evictKeys.has(k)) continue;
      nextConvs[k] = c;
      for (const e of c.entries) nextIds.add(e.id);
    }
    convs = nextConvs;
    ids = nextIds;
  }

  // 2. Bound aggregate entry count: evict the globally oldest entries. Each
  // conversation's entries are already in time order, so the oldest entry
  // overall is always one of the heads: pick the oldest head `excess` times
  // instead of sorting every entry on each call.
  let total = 0;
  for (const c of Object.values(convs)) total += c.entries.length;
  if (total > MAX_AGGREGATE_ENTRIES) {
    const convKeys = Object.keys(convs);
    const dropped = new Map<string, number>();  // entries evicted from the front, per conversation
    for (let excess = total - MAX_AGGREGATE_ENTRIES; excess > 0; excess--) {
      let oldestKey: string | null = null;
      let oldest: ChatEntry | null = null;
      for (const k of convKeys) {
        const head = convs[k].entries[dropped.get(k) ?? 0];
        if (head === undefined) continue;
        if (oldest === null || byTime(head, oldest) < 0) { oldest = head; oldestKey = k; }
      }
      if (oldestKey === null) break;
      dropped.set(oldestKey, (dropped.get(oldestKey) ?? 0) + 1);
    }
    // Rebuild conversations without the evicted entries; empty ones go.
    const nextConvs: Record<string, Conversation> = {};
    const nextIds = new Set<string>();
    for (const [k, c] of Object.entries(convs)) {
      const n = dropped.get(k) ?? 0;
      if (n === 0) {
        nextConvs[k] = c;
      } else {
        const entries = c.entries.slice(n);
        if (entries.length === 0) continue;
        nextConvs[k] = { entries, unread: Math.min(c.unread, entries.length) };
      }
      for (const e of nextConvs[k].entries) nextIds.add(e.id);
    }
    convs = nextConvs;
    ids = nextIds;
  }

  if (convs === state.conversations) return state;
  return { conversations: convs, ids };
}

// Persistence. Acknowledged messages leave the broker mailbox, so the app's
// copy is the only one: it is saved before each ack and reloaded at start.

/** Entries kept per conversation on disk; older ones are dropped. */
export const STORED_ENTRIES = 500;

/**
 * Serializes the newest STORED_ENTRIES of each conversation, plus every
 * entry in `keep`: messages not yet acked must survive on disk however old,
 * or a failed ack followed by a later one would lose them.
 */
export function toStored(state: ChatState, keep: ReadonlySet<string> = new Set()): string {
  const conversations: Record<string, Conversation> = {};
  for (const [key, c] of Object.entries(state.conversations)) {
    const from = c.entries.length - STORED_ENTRIES;
    conversations[key] = { entries: c.entries.filter((e, i) => i >= from || keep.has(e.id)), unread: c.unread };
  }
  return JSON.stringify({ v: 1, conversations });
}

const isEntry = (e: unknown): e is ChatEntry => {
  const x = e as ChatEntry;
  return typeof x?.id === 'string' && (x.direction === 'in' || x.direction === 'out')
    && typeof x.body === 'string' && typeof x.at === 'number' && (x.seq === null || typeof x.seq === 'number');
};

/** Rebuilds a saved state, dropping anything malformed; empty on bad input. */
export function fromStored(text: string | null): ChatState {
  if (!text) return emptyChat;
  let saved: { v?: unknown; conversations?: unknown };
  try { saved = JSON.parse(text); } catch { return emptyChat; }
  if (saved?.v !== 1 || !saved.conversations || typeof saved.conversations !== 'object') return emptyChat;
  const conversations: Record<string, Conversation> = {};
  const ids = new Set<string>();
  for (const [key, value] of Object.entries(saved.conversations as Record<string, unknown>)) {
    const c = value as { entries?: unknown; unread?: unknown };
    if (!Array.isArray(c?.entries)) continue;
    const entries = c.entries.filter(isEntry);
    entries.forEach((e) => ids.add(e.id));
    const unread = Number.isInteger(c.unread) && (c.unread as number) >= 0 ? (c.unread as number) : 0;
    conversations[key] = { entries, unread: Math.min(unread, entries.length) };
  }
  return enforceAggregateBounds({ conversations, ids });
}

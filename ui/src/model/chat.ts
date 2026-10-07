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

import { displayName, type CensusRow } from './census';

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

// ---- Entry kinds (Lovable Phase 2, #122) -----------------------------------
//
// A conversation holds text messages (from the broker, as before) and, once
// agent-bot puts them on the chat stream, tool calls, approval requests and
// asides between agents. Field names follow the Lovable model
// (src/model/chat.ts); text entries keep GeniusBar's shape and need no
// `kind`, so everything stored or built before still is a text entry.

export type ToolStatus = 'running' | 'success' | 'failed';
export type ApprovalStatus = 'pending' | 'approved' | 'approved_session' | 'denied';
/** How the owner answers an approval request. */
export type ApprovalDecision = Exclude<ApprovalStatus, 'pending'>;
export type Risk = 'safe' | 'external' | 'destructive';

interface EntryBase {
  id: string;
  /** Epoch ms: broker time for incoming, local time for sent. */
  at: number;
  /** Broker sequence when known; orders entries sent in the same ms. */
  seq: number | null;
}

/** One message of a conversation, either direction. Bodies are untrusted text (rendered as safe Markdown). */
export interface TextEntry extends EntryBase {
  kind?: 'text';
  direction: 'in' | 'out';
  body: string;
}

/** A tool the companion ran, with its outcome. */
export interface ToolCallEntry extends EntryBase {
  kind: 'tool_call';
  tool: string;
  args: string;
  status: ToolStatus;
  output?: string | undefined;
  /** Unified-diff lines ("+…" / "-…") when the tool changed a file. */
  diff?: string | undefined;
}

/** A tool call waiting for (or answered by) the owner. */
export interface ApprovalEntry extends EntryBase {
  kind: 'approval_request';
  tool: string;
  args: string;
  risk: Risk;
  status: ApprovalStatus;
  /** A decision is on its way (the daemon is asking the owner to confirm). */
  deciding?: boolean | undefined;
  /** Why the last decision did not land; the request stays pending. */
  error?: string | null | undefined;
}

/** Background coordination between two agents, not addressed to the owner. */
export interface AsideEntry extends EntryBase {
  kind: 'aside';
  from: string;
  to: string;
  body: string;
  /** The other agent's answer, shown inline under the aside. */
  reply?: string | undefined;
  /** Team the exchange happened in (lead's name). */
  team?: string | undefined;
}

/** One line of a conversation. */
export type ChatEntry = TextEntry | ToolCallEntry | ApprovalEntry | AsideEntry;

export function isTextEntry(entry: ChatEntry): entry is TextEntry {
  return entry.kind === undefined || entry.kind === 'text';
}

/** Approval requests still waiting for an answer, oldest first. */
export function pendingApprovals(entries: readonly ChatEntry[]): ApprovalEntry[] {
  return entries.filter(
    (e): e is ApprovalEntry => e.kind === 'approval_request' && e.status === 'pending',
  );
}

/**
 * Whether a tool call must stop for approval: never in Auto-Pilot, never
 * for read-only tools, otherwise unless the tool was approved for the
 * session.
 */
export function needsApproval(
  risk: Risk,
  mode: 'safe' | 'autopilot',
  sessionApproved: ReadonlySet<string>,
  tool: string,
): boolean {
  if (mode === 'autopilot') return false;
  if (risk === 'safe') return false;
  return !sessionApproved.has(tool);
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

// ---- Asides and approvals from agent-bot (#122, #85, #86) -----------------
//
// agent-bot 0.10.13 records the agent-comms messages that entered or left a
// soul's context (`soul asides <soul> --json`) and lists the tool calls
// waiting on the owner (`approvals list --json`). These turn its lines into
// conversation entries; the bridge only relays them.

export interface AsidePeer {
  address: string | null;
  agentId: string | null;
  principal: string | null;
  name: string | null;
}

/** One line of agent-bot's aside journal for a soul. */
export interface AsideRecord {
  id: string;
  /** ISO time. */
  at: string;
  /** Out: the soul sent it; in: it entered the soul's context. */
  dir: 'in' | 'out';
  via: string;
  /** Thread context shown again in a later turn, not a new message. */
  reshown: boolean;
  peer: AsidePeer;
  messageId: string | null;
  replyTo: string | null;
  correlation: string | null;
  teamId: string | null;
  body: string;
}

/** A pending (or just decided) proposal from `approvals list|approve|deny --json`. */
export interface ApprovalRecord {
  proposalId: string;
  agentId: string;
  soul: string | null;
  tool: string | null;
  summary: string;
  createdAt: string;
  expiresAt: string | null;
  status: string;
  /** How far an approval reaches (agent-bot-identity #486); older bundles leave it out. */
  scope?: 'once' | 'session' | undefined;
  /**
   * The decision, `approved_session` for a session grant; null while open.
   * Older bundles leave it out: read `status` then.
   */
  decision?: string | null | undefined;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const stringOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function normalizeAside(raw: unknown): AsideRecord | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.at !== 'string' || typeof raw.body !== 'string') return null;
  if (raw.dir !== 'in' && raw.dir !== 'out') return null;
  const peer = isObject(raw.peer) ? raw.peer : {};
  return {
    id: raw.id, at: raw.at, dir: raw.dir, via: typeof raw.via === 'string' ? raw.via : '', reshown: raw.reshown === true,
    peer: {
      address: stringOrNull(peer.address), agentId: stringOrNull(peer.agentId),
      principal: stringOrNull(peer.principal), name: stringOrNull(peer.name),
    },
    messageId: stringOrNull(raw.messageId), replyTo: stringOrNull(raw.replyTo),
    correlation: stringOrNull(raw.correlation), teamId: stringOrNull(raw.teamId), body: raw.body,
  };
}

/** A `soul asides --json` page, keeping well-formed asides; null when it is not one. */
export function normalizeAsides(raw: unknown): { asides: AsideRecord[]; next: string | null } | null {
  if (!isObject(raw) || !Array.isArray(raw.asides)) return null;
  return {
    asides: raw.asides.map(normalizeAside).filter((a): a is AsideRecord => a !== null),
    next: stringOrNull(raw.next),
  };
}

export function normalizeApproval(raw: unknown): ApprovalRecord | null {
  if (!isObject(raw) || typeof raw.proposalId !== 'string' || typeof raw.agentId !== 'string'
    || typeof raw.status !== 'string') return null;
  return {
    proposalId: raw.proposalId, agentId: raw.agentId, soul: stringOrNull(raw.soul), tool: stringOrNull(raw.tool),
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '', expiresAt: stringOrNull(raw.expiresAt),
    status: raw.status,
    ...(raw.scope === 'once' || raw.scope === 'session' ? { scope: raw.scope } : {}),
    ...(raw.decision === null || typeof raw.decision === 'string' ? { decision: raw.decision } : {}),
  };
}

/** An `approvals list --json` result, keeping well-formed rows; null when it is not one. */
export function normalizeApprovals(raw: unknown): ApprovalRecord[] | null {
  if (!isObject(raw) || !Array.isArray(raw.approvals)) return null;
  return raw.approvals.map(normalizeApproval).filter((a): a is ApprovalRecord => a !== null);
}

type RosterRow = Pick<CensusRow, 'agentId' | 'name' | 'parent'>;

/** The top of a soul's parent chain in the roster, or null when it is not there. */
function teamRoot(agentId: string, roster: readonly RosterRow[]): RosterRow | null {
  const byId = new Map(roster.map((row) => [row.agentId, row]));
  let row = byId.get(agentId);
  for (let depth = 0; row && row.parent !== null && depth < 64; depth += 1) {
    const parent = byId.get(row.parent);
    if (!parent) break;
    row = parent;
  }
  return row ?? null;
}

/**
 * A soul's asides as conversation entries, oldest first: "A → B" with B's
 * answer as the reply when a later aside from the same peer replies to it
 * (by message id, or the same correlation). Thread context shown again and
 * messages to or from a principal (the owner's own chat) are left out. The
 * team is the shared lead's name when both souls are in one team.
 */
export function asideEntries(agentId: string, records: readonly AsideRecord[], roster: readonly RosterRow[] = []): AsideEntry[] {
  const rows = records.filter((r) => !r.reshown && r.peer.principal === null && (r.peer.agentId ?? r.peer.address) !== null);
  const self = roster.find((row) => row.agentId === agentId);
  const selfName = self ? displayName(self) : agentId;
  const selfRoot = teamRoot(agentId, roster);
  const used = new Set<string>();
  const entries: AsideEntry[] = [];
  rows.forEach((r, i) => {
    if (used.has(r.id)) return;
    const peerKey = r.peer.agentId ?? r.peer.address;
    const answer = rows.slice(i + 1).find((a) => !used.has(a.id) && a.dir !== r.dir
      && (a.peer.agentId ?? a.peer.address) === peerKey
      && ((r.messageId !== null && a.replyTo === r.messageId) || (r.correlation !== null && a.correlation === r.correlation)));
    if (answer) used.add(answer.id);
    const peerRow = r.peer.agentId ? roster.find((row) => row.agentId === r.peer.agentId) : undefined;
    const peerName = r.peer.name ?? (peerRow ? displayName(peerRow) : peerKey ?? 'unknown');
    const peerRoot = r.peer.agentId ? teamRoot(r.peer.agentId, roster) : null;
    const team = selfRoot && peerRoot && selfRoot.agentId === peerRoot.agentId ? displayName(selfRoot) : undefined;
    const at = Date.parse(r.at);
    entries.push({
      id: `aside:${r.id}`, kind: 'aside',
      from: r.dir === 'out' ? selfName : peerName,
      to: r.dir === 'out' ? peerName : selfName,
      body: r.body,
      ...(answer ? { reply: answer.body } : {}),
      ...(team ? { team } : {}),
      at: Number.isFinite(at) ? at : 0, seq: null,
    });
  });
  return entries;
}

/** What GeniusBar knows locally about a proposal: a decision in flight, failed, or landed. */
export interface LocalApproval {
  agentId: string;
  entry: ApprovalEntry;
}

/**
 * A soul's approval requests as entries: each pending proposal for it (the
 * daemon has no risk levels yet, so every one reads as external), overlaid
 * with a local decision in flight or failed, plus proposals decided here
 * that have since left the pending list, so the card shows the answer.
 */
export function approvalEntries(agentId: string, records: readonly ApprovalRecord[],
  local: ReadonlyMap<string, LocalApproval> = new Map()): ApprovalEntry[] {
  const entries: ApprovalEntry[] = [];
  const listed = new Set<string>();
  for (const r of records) {
    if (r.agentId !== agentId || r.status !== 'pending') continue;
    listed.add(r.proposalId);
    const at = Date.parse(r.createdAt);
    const base: ApprovalEntry = {
      id: r.proposalId, kind: 'approval_request', tool: r.tool ?? 'tool', args: r.summary, risk: 'external',
      status: 'pending', at: Number.isFinite(at) ? at : 0, seq: null,
    };
    const mine = local.get(r.proposalId)?.entry;
    entries.push(mine ? { ...base, status: mine.status, deciding: mine.deciding, error: mine.error } : base);
  }
  for (const [id, mine] of local) {
    if (mine.agentId === agentId && !listed.has(id) && mine.entry.status !== 'pending') entries.push(mine.entry);
  }
  return entries.sort(byTime);
}

/**
 * Replaces one conversation's entries of `kind` (asides or approvals, which
 * agent-bot reports whole each time) with `entries`. Returns the same state
 * when nothing changed. Never counts as unread.
 */
export function withSideEntries(state: ChatState, key: string, kind: 'aside' | 'approval_request',
  entries: readonly ChatEntry[]): ChatState {
  const prev = state.conversations[key];
  const all = prev?.entries ?? [];
  const old = all.filter((e) => e.kind === kind);
  const fresh = [...entries].sort(byTime);
  if (JSON.stringify(old) === JSON.stringify(fresh)) return state;
  const ids = new Set(state.ids);
  old.forEach((e) => ids.delete(e.id));
  fresh.forEach((e) => ids.add(e.id));
  const next = [...all.filter((e) => e.kind !== kind), ...fresh].sort(byTime);
  return enforceAggregateBounds({
    conversations: { ...state.conversations, [key]: { entries: next, unread: prev?.unread ?? 0 } },
    ids,
  });
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
    const lists = convKeys.map((k) => convs[k].entries);
    const dropped = new Array<number>(convKeys.length).fill(0);  // evicted from the front, per conversation
    for (let excess = total - MAX_AGGREGATE_ENTRIES; excess > 0; excess--) {
      let oldestAt = -1;
      let oldest: ChatEntry | null = null;
      for (let i = 0; i < lists.length; i++) {
        const head = lists[i][dropped[i]];
        if (head === undefined) continue;
        if (oldest === null || byTime(head, oldest) < 0) { oldest = head; oldestAt = i; }
      }
      if (oldestAt < 0) break;
      dropped[oldestAt]++;
    }
    // Rebuild conversations without the evicted entries; empty ones go.
    const nextConvs: Record<string, Conversation> = {};
    const nextIds = new Set<string>();
    convKeys.forEach((k, i) => {
      const c = convs[k];
      if (dropped[i] === 0) {
        nextConvs[k] = c;
      } else {
        const entries = c.entries.slice(dropped[i]);
        if (entries.length === 0) return;
        nextConvs[k] = { entries, unread: Math.min(c.unread, entries.length) };
      }
      for (const e of nextConvs[k].entries) nextIds.add(e.id);
    });
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

// Only text entries are persisted for now; the other kinds come from the
// live stream and are not restored.
const isEntry = (e: unknown): e is TextEntry => {
  const x = e as TextEntry;
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

/**
 * Another window's saved history folded into this one (#223): every window
 * of the app polls and acks the same inbox and saves to the same storage,
 * so each takes in what the others stored. Text entries this window lacks
 * are added in time order; unread counts follow the other window's, the
 * newest writer's, except the conversation on screen here, which stays
 * read. `ahead` says this window holds saved entries (or a read) the other
 * lacks, so it saves back and the windows agree; nothing is ever removed.
 */
export function mergeStored(state: ChatState, other: ChatState, openKey: string | null = null): { state: ChatState; ahead: boolean } {
  let next = state;
  const put = (key: string, conversation: Conversation, ids = next.ids) => {
    next = { conversations: { ...next.conversations, [key]: conversation }, ids };
  };
  for (const [key, theirs] of Object.entries(other.conversations)) {
    const fresh = theirs.entries.filter((e) => !next.ids.has(e.id));
    if (fresh.length) {
      const mine = conversationOf(next, key);
      const ids = new Set(next.ids);
      fresh.forEach((e) => ids.add(e.id));
      put(key, { entries: [...mine.entries, ...fresh].sort(byTime), unread: mine.unread }, ids);
    }
    const mine = conversationOf(next, key);
    const unread = key === openKey ? 0 : Math.min(theirs.unread, mine.entries.length);
    if (mine.unread !== unread) put(key, { ...mine, unread });
  }
  next = next === state ? state : enforceAggregateBounds(next);
  // Only what toStored would save counts, or windows holding more than
  // STORED_ENTRIES would save back to each other for ever.
  const ahead = Object.entries(next.conversations).some(([key, c]) => {
    const saved = c.entries.slice(-STORED_ENTRIES).filter(isEntry);
    return saved.some((e) => !other.ids.has(e.id))
      || (key === openKey && (other.conversations[key]?.unread ?? 0) > 0);
  });
  return { state: next, ahead };
}

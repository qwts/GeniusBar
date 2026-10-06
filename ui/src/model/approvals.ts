// The GeniusBar menu's "Waiting for your approval" list and the counts on
// its header and tray badge (#85, Lovable GeniusBarItem). Built from the
// pending proposals useChat already polls from agent-bot; display only.
import { displayName, shortAgentId, type CensusRow } from './census';
import type { ApprovalRecord, LocalApproval } from './chat';

/** One card in the menu's approval list. */
export interface MenuApproval {
  proposalId: string;
  agentId: string;
  /** The companion it is for, when the census lists it; its name opens that chat. */
  soul: CensusRow | null;
  name: string;
  tool: string;
  /** What the tool would run, shown in monospace. */
  command: string;
  /** Milliseconds since the epoch; 0 when agent-bot gave no time. */
  createdAt: number;
  deciding: boolean;
  error: string | null;
}

/**
 * Pending proposals across every companion, oldest first. A proposal
 * decided here leaves the list at once, before agent-bot's next listing;
 * one whose decision is in flight or failed stays, carrying that state.
 */
export function menuApprovals(records: readonly ApprovalRecord[],
  local: ReadonlyMap<string, LocalApproval> = new Map(), roster: readonly CensusRow[] = []): MenuApproval[] {
  const seen = new Set<string>();
  const items: MenuApproval[] = [];
  for (const r of records) {
    if (r.status !== 'pending' || seen.has(r.proposalId)) continue;
    seen.add(r.proposalId);
    const mine = local.get(r.proposalId)?.entry;
    if (mine && mine.status !== 'pending') continue;
    const soul = roster.find((row) => row.agentId === r.agentId) ?? null;
    const at = Date.parse(r.createdAt);
    items.push({
      proposalId: r.proposalId,
      agentId: r.agentId,
      soul,
      name: soul ? displayName(soul) : r.soul ?? (shortAgentId(r) || r.agentId),
      tool: r.tool ?? 'tool',
      command: r.summary,
      createdAt: Number.isFinite(at) ? at : 0,
      deciding: mine?.deciding === true,
      error: mine?.deciding ? null : mine?.error ?? null,
    });
  }
  return items.sort((a, b) => a.createdAt - b.createdAt || a.proposalId.localeCompare(b.proposalId));
}

/**
 * Companions the census reports as busy. Today's census carries only
 * watching/joined/left, so this is 0 until it reports a busy state.
 */
export function workingCount(roster: readonly Pick<CensusRow, 'presence'>[]): number {
  return roster.filter((row) => {
    const presence: string = row.presence;
    return presence === 'working' || presence === 'busy';
  }).length;
}

/** The count badge's text: nothing at 0, capped at 99+. */
export function badgeText(count: number): string | null {
  if (!(count > 0)) return null;
  return count > 99 ? '99+' : String(Math.floor(count));
}

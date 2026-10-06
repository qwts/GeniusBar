// The desktop's floating Dudle (#122, Lovable FloatingDudle): which soul it
// shows, what state it draws, and who the computer-use perimeter names.
// Display only; nothing here acts on a soul.
import { workingCount } from './approvals';
import { displayName, soulKey, type CensusRow, type SoulNode } from './census';

/**
 * The first team lead the desktop shows (not hidden, not left), else the
 * first soul that has not left, else the first soul; null for no souls.
 */
export function floatingLead(forest: readonly SoulNode[], hidden: readonly string[] = []): CensusRow | null {
  const shown = new Set(hidden);
  const lead = forest.find((n) => n.soul.presence !== 'left' && !shown.has(soulKey(n.soul)));
  if (lead) return lead.soul;
  const all: CensusRow[] = [];
  const walk = (nodes: readonly SoulNode[]) => nodes.forEach((n) => { all.push(n.soul); walk(n.children); });
  walk(forest);
  return all.find((s) => s.presence !== 'left') ?? all[0] ?? null;
}

/** The states the floating Dudle draws (a subset of the Dudle's). */
export type FloatingState = 'idle' | 'working' | 'awaiting';

export interface FloatingInputs {
  roster: readonly CensusRow[];
  /** Pending approvals across every companion. */
  approvals: number;
  /** Agent IDs mid-turn, when agent-bot reports them. */
  busy?: ReadonlySet<string>;
  /** Agent IDs driving the screen (daemon status `computerUse`). */
  computerUse?: ReadonlySet<string>;
}

/**
 * As the design: awaiting while any approval waits, working while any soul
 * is busy (the census presence, a mid-turn report, or driving the screen),
 * idle otherwise.
 */
export function floatingState({ roster, approvals, busy, computerUse }: FloatingInputs): FloatingState {
  if (approvals > 0) return 'awaiting';
  const live = new Set(roster.filter((s) => s.presence !== 'left').map((s) => s.agentId));
  const any = (ids?: ReadonlySet<string>) => [...(ids ?? [])].some((id) => live.has(id));
  if (workingCount(roster) > 0 || any(busy) || any(computerUse)) return 'working';
  return 'idle';
}

/**
 * The name the perimeter shows: the first roster soul driving the screen,
 * else the agent ID the daemon reported; null when none is.
 */
export function computerUserName(roster: readonly CensusRow[], computerUse: ReadonlySet<string> = new Set()): string | null {
  if (computerUse.size === 0) return null;
  const soul = roster.find((s) => computerUse.has(s.agentId));
  return soul ? displayName(soul) : [...computerUse][0];
}

/** The next quick-menu item for an arrow key, wrapping; null for other keys. */
export function menuStep(key: string, index: number, count: number): number | null {
  if (count === 0) return null;
  if (key === 'ArrowDown' || key === 'ArrowRight') return (index + 1) % count;
  if (key === 'ArrowUp' || key === 'ArrowLeft') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

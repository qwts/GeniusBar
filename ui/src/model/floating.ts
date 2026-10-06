// The desktop's floating Dudle (#122, Lovable FloatingDudle): which soul it
// shows, what state it draws, who the computer-use perimeter names, and
// which souls its Stop halts. Pure; nothing here acts on a soul.
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

/** How long Escape must be held to halt computer use (the design's ~0.6 s). */
export const HALT_HOLD_MS = 600;

/**
 * How long Stop shows "stopping…" waiting for the daemon to drop the souls
 * from `computerUse`, before offering Stop again.
 */
export const STOP_SETTLE_MS = 15_000;

/** The perimeter's Stop: ready, waiting for the souls to settle, or failed. */
export type StopPhase =
  | { phase: 'ready' }
  | { phase: 'stopping'; agentIds: readonly string[] }
  | { phase: 'failed'; message: string };

/** The agent IDs Stop halts: every soul the daemon reports driving the screen. */
export function stopTargets(computerUse: ReadonlySet<string> = new Set()): string[] {
  return [...computerUse];
}

/**
 * The next Stop phase as the daemon reports computer use: "stopping" ends
 * once none of the stopped souls drives the screen; a failure clears when
 * nobody does.
 */
export function settleStop(stop: StopPhase, computerUse: ReadonlySet<string> = new Set()): StopPhase {
  if (stop.phase === 'stopping' && !stop.agentIds.some((id) => computerUse.has(id))) return { phase: 'ready' };
  if (stop.phase === 'failed' && computerUse.size === 0) return { phase: 'ready' };
  return stop;
}

/**
 * The quick menu's Pause all / Resume item (Lovable `paused ? Play : Pause`):
 * which icon and wording it shows for the fleet's state.
 */
export function pauseQuickAction(fleetPaused: boolean): { icon: 'play' | 'pause'; label: 'quick.resume' | 'quick.pause' } {
  return fleetPaused ? { icon: 'play', label: 'quick.resume' } : { icon: 'pause', label: 'quick.pause' };
}

/** How long a failed "Toggle computer use" stays by the floating Dudle. */
export const COMPUTER_USE_ERROR_MS = 15_000;

/**
 * The quick menu's "Toggle computer use" (Lovable `setComputerUse`) as the
 * owner's per-soul switch: off while the lead's computer use is on, on
 * while it is off; null when agent-bot cannot say, so nothing is changed.
 */
export function computerUseToggle(current: boolean | null): 'on' | 'off' | null {
  if (current === null) return null;
  return current ? 'off' : 'on';
}

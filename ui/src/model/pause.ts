// Pause all / Resume (#122, Lovable `togglePause`) over agent-bot's
// `soul pause` / `soul resume` (agent-bot-identity #478). agent-bot keeps
// each soul's `paused` flag and holds its wakes, launches and chat; this
// only says which souls the one fleet-wide toggle acts on. Pure.
import type { PopulationEntry } from '../bridge';

export type PauseEntry = Pick<PopulationEntry, 'agentId' | 'managed' | 'paused' | 'status'>;

/** The fleet the toggle covers: souls GeniusBar manages that are not archived. */
const inFleet = (e: PauseEntry) => e.managed && e.status !== 'retired';

/** The design's `paused`: at least one managed, unarchived soul is paused. */
export function fleetPaused(entries: readonly PauseEntry[]): boolean {
  return entries.some((e) => inFleet(e) && e.paused === true);
}

/** Pause all: every managed, unarchived soul (pausing a paused one is a no-op). */
export function pauseTargets(entries: readonly PauseEntry[]): string[] {
  return entries.filter(inFleet).map((e) => e.agentId);
}

/** Resume: every paused soul that is not archived, managed or not. */
export function resumeTargets(entries: readonly PauseEntry[]): string[] {
  return entries.filter((e) => e.paused === true && e.status !== 'retired').map((e) => e.agentId);
}

/** What the toggle does now: resume while the fleet is paused, else pause all. */
export function pauseAction(entries: readonly PauseEntry[]): { action: 'pause' | 'resume'; agentIds: string[] } {
  return fleetPaused(entries)
    ? { action: 'resume', agentIds: resumeTargets(entries) }
    : { action: 'pause', agentIds: pauseTargets(entries) };
}

/** The entries with each soul agent-bot answered for set as it said. */
export function applyPaused<T extends PauseEntry>(entries: readonly T[], answers: readonly { agentId: string; paused: boolean }[]): T[] {
  const now = new Map(answers.map((a) => [a.agentId, a.paused]));
  return entries.map((e) => (now.has(e.agentId) ? { ...e, paused: now.get(e.agentId) } : e));
}

export type PauseFailure = { code: string; message: string };

/**
 * Runs `act` for every soul in parallel. Returns the answers that came back
 * and the first failure in `agentIds` order (null when all succeeded).
 */
export async function actOnAll<R extends { agentId: string; paused: boolean }>(agentIds: readonly string[],
  act: (agentId: string) => Promise<R>): Promise<{ answers: R[]; failure: PauseFailure | null }> {
  const settled = await Promise.allSettled(agentIds.map((id) => act(id)));
  const answers = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
  const rejected = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (!rejected) return { answers, failure: null };
  const e = rejected.reason as { code?: unknown; message?: unknown };
  return { answers, failure: {
    code: typeof e?.code === 'string' ? e.code : 'soul-pause-failed',
    message: typeof e?.message === 'string' ? e.message : String(rejected.reason),
  } };
}

// Folds one census attempt into the connection snapshot, as R1's AppState
// refresh did, with errors told apart by their stable code.
import type { DaemonStatus, SoulComms } from '../bridge';
import type { CensusRow, SoulRole } from './census';
import { brokerErrorCode, STARTING_WINDOW_MS, statusErrors, type ConnectionSnapshot } from './status';

export type CensusOutcome =
  | { ok: true; souls: readonly CensusRow[] }
  | { ok: false; code: string; message: string };

const UNREACHABLE = new Set(['broker-unreachable', 'broker-timeout', 'broker-untrusted']);
const UNPAIRED = new Set(['unauthenticated', 'not-approved', 'credential-invalid', 'keychain-read-failed']);

/**
 * `servicesInstalled` says GeniusBar's login services are registered (#118):
 * an unreachable broker that has never answered in this run is then
 * "starting" for up to STARTING_WINDOW_MS of continuous failures, not a
 * machine that needs setup. False (or not known) keeps the old behaviour.
 */
export function applyCensus(prev: ConnectionSnapshot, outcome: CensusOutcome, now: Date,
  servicesInstalled = false): ConnectionSnapshot {
  if (outcome.ok) {
    return { ...prev, bridgeConnected: true, loadingCredential: false, unpaired: false,
      brokerUnreachable: false, lastError: null, lastRefresh: now, starting: false, failingSince: null };
  }
  const lastError = brokerErrorCode(outcome.code, outcome.message);
  // The shell reports bridge-* codes while Node starts or restarts.
  if (outcome.code.startsWith('bridge-')) {
    return { ...prev, bridgeConnected: false,
      lastError: statusErrors.bridge };
  }
  if (UNPAIRED.has(outcome.code)) {
    return { ...prev, bridgeConnected: true, loadingCredential: false, unpaired: true, lastError,
      starting: false, failingSince: null };
  }
  // Keep the last census on screen and flag the outage (R1 behaviour).
  const brokerUnreachable = UNREACHABLE.has(outcome.code) || prev.brokerUnreachable;
  const failingSince = brokerUnreachable ? prev.failingSince ?? now : null;
  const starting = servicesInstalled && failingSince !== null && prev.lastRefresh === null
    && now.getTime() - failingSince.getTime() < STARTING_WINDOW_MS;
  return { ...prev, bridgeConnected: true, loadingCredential: false, unpaired: false,
    brokerUnreachable, lastError, starting, failingSince };
}

/**
 * The desktop's avatar badges (#122), by agent ID: `comms` for souls with
 * agent comms on (they wake on new messages), `computerUse` for souls the
 * daemon says are driving the screen right now.
 */
export interface SoulBadges {
  comms: ReadonlySet<string>;
  computerUse: ReadonlySet<string>;
  /** Souls with a turn in flight (daemon status `busy`), for the floating Dudle. */
  busy: ReadonlySet<string>;
  /**
   * Declared Dudle hues by agent ID, from the same `population_list` read;
   * absent before it answers or from a bundle without the list.
   */
  hues?: ReadonlyMap<string, number>;
  /**
   * Declared roles by agent ID (agent-bot-identity #535), from the same read;
   * absent before it answers or from a bundle without the list.
   */
  roles?: ReadonlyMap<string, SoulRole>;
}

export const noBadges: SoulBadges = { comms: new Set(), computerUse: new Set(), busy: new Set() };

/** Souls driving the screen; none when the daemon cannot say or is down. */
export function computerUseOf(status: DaemonStatus | null): ReadonlySet<string> {
  return new Set(status?.running ? status.computerUse.map((c) => c.agentId) : []);
}

/** Souls mid-turn; none when the daemon cannot say, is down, or is too old to report it. */
export function busyOf(status: DaemonStatus | null): ReadonlySet<string> {
  return new Set(status?.running ? status.busy ?? [] : []);
}

/** Souls whose agent comms agent-bot reports on; a soul it cannot answer for has no badge. */
export function commsOf(states: readonly (Pick<SoulComms, 'agentId' | 'comms'> | null)[]): ReadonlySet<string> {
  return new Set(states.flatMap((s) => (s?.comms ? [s.agentId] : [])));
}

/**
 * The visible souls with comms on, from one `population_list` read (#137).
 * The list covers every soul agent-bot knows, so it is narrowed to `agentIds`.
 */
export function commsAmong(entries: readonly Pick<SoulComms, 'agentId' | 'comms'>[], agentIds: readonly string[]): ReadonlySet<string> {
  const visible = new Set(agentIds);
  return commsOf(entries.filter((e) => visible.has(e.agentId)));
}

/** Same members, so a poll that changed nothing keeps the old set and skips a render. */
export function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/** Declared hues by agent ID from one `population_list` read; souls without one are left out. */
export function huesOf(entries: readonly { agentId: string; appearance?: { hue: number } }[]): ReadonlyMap<string, number> {
  return new Map(entries.flatMap((e) => (e.appearance ? [[e.agentId, e.appearance.hue] as const] : [])));
}

/** Same hues, so a poll that changed nothing keeps the old map and skips a render. */
export function sameHues(a: ReadonlyMap<string, number> | undefined, b: ReadonlyMap<string, number>): boolean {
  return a !== undefined && a.size === b.size && [...a].every(([id, hue]) => b.get(id) === hue);
}

/** Declared roles by agent ID from one `population_list` read; souls with neither a role nor a role line are left out. */
export function rolesOf(entries: readonly { agentId: string; role?: string | null; roleLine?: string | null }[]): ReadonlyMap<string, SoulRole> {
  return new Map(entries.flatMap((e) => (e.role || e.roleLine
    ? [[e.agentId, { ...(e.role ? { role: e.role } : {}), ...(e.roleLine ? { roleLine: e.roleLine } : {}) }] as const]
    : [])));
}

/** Same roles, so a poll that changed nothing keeps the old map and skips a render. */
export function sameRoles(a: ReadonlyMap<string, SoulRole> | undefined, b: ReadonlyMap<string, SoulRole>): boolean {
  return a !== undefined && a.size === b.size
    && [...a].every(([id, r]) => b.get(id)?.role === r.role && b.get(id)?.roleLine === r.roleLine);
}

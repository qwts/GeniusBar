// Folds one census attempt into the connection snapshot, as R1's AppState
// refresh did, with errors told apart by their stable code.
import type { DaemonStatus, SoulComms } from '../bridge';
import type { CensusRow } from './census';
import { brokerErrorMessage, type ConnectionSnapshot } from './status';

export type CensusOutcome =
  | { ok: true; souls: readonly CensusRow[] }
  | { ok: false; code: string; message: string };

const UNREACHABLE = new Set(['broker-unreachable', 'broker-timeout', 'broker-untrusted']);
const UNPAIRED = new Set(['unauthenticated', 'not-approved', 'credential-invalid', 'keychain-read-failed']);

export function applyCensus(prev: ConnectionSnapshot, outcome: CensusOutcome, now: Date): ConnectionSnapshot {
  if (outcome.ok) {
    return { ...prev, bridgeConnected: true, loadingCredential: false, unpaired: false,
      brokerUnreachable: false, lastError: null, lastRefresh: now };
  }
  const lastError = brokerErrorMessage(outcome.code, outcome.message);
  // The shell reports bridge-* codes while Node starts or restarts.
  if (outcome.code.startsWith('bridge-')) {
    return { ...prev, bridgeConnected: false,
      lastError: 'GeniusBar had trouble starting its background service. Try reopening GeniusBar.' };
  }
  if (UNPAIRED.has(outcome.code)) {
    return { ...prev, bridgeConnected: true, loadingCredential: false, unpaired: true, lastError };
  }
  // Keep the last census on screen and flag the outage (R1 behaviour).
  return { ...prev, bridgeConnected: true, loadingCredential: false, unpaired: false,
    brokerUnreachable: UNREACHABLE.has(outcome.code) || prev.brokerUnreachable, lastError };
}

/**
 * The desktop's avatar badges (#122), by agent ID: `comms` for souls with
 * agent comms on (they wake on new messages), `computerUse` for souls the
 * daemon says are driving the screen right now.
 */
export interface SoulBadges {
  comms: ReadonlySet<string>;
  computerUse: ReadonlySet<string>;
}

export const noBadges: SoulBadges = { comms: new Set(), computerUse: new Set() };

/** Souls driving the screen; none when the daemon cannot say or is down. */
export function computerUseOf(status: DaemonStatus | null): ReadonlySet<string> {
  return new Set(status?.running ? status.computerUse.map((c) => c.agentId) : []);
}

/** Souls whose agent comms agent-bot reports on; a soul it cannot answer for has no badge. */
export function commsOf(states: readonly (SoulComms | null)[]): ReadonlySet<string> {
  return new Set(states.flatMap((s) => (s?.comms ? [s.agentId] : [])));
}

/** Same members, so a poll that changed nothing keeps the old set and skips a render. */
export function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

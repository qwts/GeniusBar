// Folds one census attempt into the connection snapshot, as R1's AppState
// refresh did, with errors told apart by their stable code.
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
  if (outcome.code.startsWith('bridge-')) return { ...prev, bridgeConnected: false, lastError };
  if (UNPAIRED.has(outcome.code)) {
    return { ...prev, bridgeConnected: true, loadingCredential: false, unpaired: true, lastError };
  }
  // Keep the last census on screen and flag the outage (R1 behaviour).
  return { ...prev, bridgeConnected: true, loadingCredential: false, unpaired: false,
    brokerUnreachable: UNREACHABLE.has(outcome.code) || prev.brokerUnreachable, lastError };
}

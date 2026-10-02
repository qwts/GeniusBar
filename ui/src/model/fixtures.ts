// The fixed fake census and health from R1's snapshot test, for tests and
// for previewing the popup before the bridge (#7) supplies real rows.
import type { CensusRow } from './census';
import { disconnected, type ConnectionSnapshot } from './status';

export const sampleCensus: readonly CensusRow[] = [
  {
    account: 'user',
    agentId: 'agent_p',
    name: 'luna',
    harness: 'codex',
    parent: null,
    presence: 'joined',
    unacked: 0,
    lastWake: '2026-01-01T00:00:01Z',
    verification: 'verified',
    hardened: true,
    daemonWatching: true,
  },
  {
    account: 'user',
    agentId: 'agent_c',
    name: null,
    harness: null,
    parent: 'agent_p',
    presence: 'watching',
    unacked: 3,
    lastWake: null,
  },
  {
    account: 'user',
    agentId: 'agent_gone',
    name: 'old',
    harness: null,
    parent: null,
    presence: 'left',
    unacked: 0,
    lastWake: null,
  },
];

export const sampleConnection: ConnectionSnapshot = {
  ...disconnected,
  bridgeConnected: true,
  health: {
    ok: true,
    uptimeMs: 12_000,
    eventLogBytes: 512,
    pairings: { accounts: 1, principals: 2 },
    watches: 3,
  },
};

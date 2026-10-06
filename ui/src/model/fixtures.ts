// The fixed fake census and health from R1's snapshot test, for tests and
// for previewing the popup before the bridge (#7) supplies real rows.
import type { CensusRow } from './census';
import type { ApprovalRecord, ChatEntry, InboxMessage } from './chat';
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

/** A message as the broker's read returns it to a principal (#17). */
export function inboxMessage(id: string, seq: number, body = `body ${id}`,
  from = { account: 'user', agentId: 'agent_p' }): InboxMessage {
  return {
    id, seq, at: 1_000 + seq, from: { ...from, verification: 'verified' }, to: { principal: 'principal_x' },
    kind: 'message', body, refs: [], correlation: null, replyTo: null, depth: 0, wake: 'waiting',
  };
}

/**
 * One session showing every entry kind (#122), for the preview: Markdown
 * text both ways, tool calls in each state, approvals pending and answered,
 * and an aside with its reply. Times follow the inbox fixtures.
 */
export const sampleSessionEntries: readonly ChatEntry[] = [
  { id: 'kind_1', direction: 'out', body: 'Can you fix the **flaky census test** and push?', at: 2_000, seq: null },
  {
    id: 'kind_2', direction: 'in', at: 2_100, seq: null,
    body: 'Sure. Plan:\n1. Run the suite\n2. Patch `census.test.ts`\n3. Push to `fix/census`\n\nDetails in [the issue](https://github.com/qwts/GeniusBar/issues/117).',
  },
  { id: 'kind_3', kind: 'tool_call', tool: 'terminal', args: 'npm test -- census', status: 'failed', output: '1 failed: census › orders by seq', at: 2_200, seq: null },
  {
    id: 'kind_4', kind: 'tool_call', tool: 'edit_file', args: 'ui/src/model/census.test.ts', status: 'success', at: 2_300, seq: null,
    output: 'Edited 2 lines', diff: '@@ -41,2 +41,2 @@\n-  expect(rows).toEqual(sorted);\n+  expect(rows.map(key)).toEqual(sorted.map(key));',
  },
  { id: 'kind_5', kind: 'aside', from: 'luna', to: 'scout', body: 'Is CI on main green right now?', reply: 'Yes, last run passed 4 minutes ago.', team: 'luna', at: 2_400, seq: null },
  { id: 'kind_6', kind: 'tool_call', tool: 'terminal', args: 'npm test', status: 'running', at: 2_500, seq: null },
  { id: 'kind_7', kind: 'approval_request', tool: 'browser', args: 'open https://github.com/qwts/GeniusBar/actions', risk: 'external', status: 'approved_session', at: 2_600, seq: null },
  { id: 'kind_8', kind: 'approval_request', tool: 'terminal', args: 'git push origin fix/census', risk: 'external', status: 'pending', at: 2_700, seq: null },
];

/** Two proposals waiting on the owner, as `approvals list --json` gives them (#85). */
export const sampleApprovals: readonly ApprovalRecord[] = [
  {
    proposalId: 'prop_2', agentId: 'agent_c', soul: null, tool: 'terminal', summary: "psql -c 'VACUUM FULL ledger'",
    createdAt: '2026-10-05T10:04:00Z', expiresAt: '2026-10-05T10:19:00Z', status: 'pending',
  },
  {
    proposalId: 'prop_1', agentId: 'agent_p', soul: 'luna', tool: 'Bash', summary: 'git push origin main',
    createdAt: '2026-10-05T10:01:00Z', expiresAt: '2026-10-05T10:16:00Z', status: 'pending',
  },
];

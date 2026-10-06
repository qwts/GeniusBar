// The fixed fake census and health from R1's snapshot test, for tests and
// for previewing the popup before the bridge (#7) supplies real rows.
import type { SoulColdWake, SoulMode, SoulModel, SoulPopulation } from '../bridge';
import type { AuditRecord } from './audit';
import type { CensusRow } from './census';
import type { ApprovalRecord, ChatEntry, InboxMessage } from './chat';
import type { SoulBadges } from './refresh';
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

/** Six audit records across luna and agent_c, newest last as `audit list --json` gives them (#122). */
export const sampleAudit: readonly AuditRecord[] = [
  { at: '2026-10-05T09:58:00Z', event: 'credential-mint', principalId: 'principal_1', agentId: 'agent_c', operation: 'mint', detail: 'harness token for codex' },
  { at: '2026-10-05T10:00:12Z', event: 'permission', principalId: 'principal_1', transport: 'hook', agentId: 'agent_c', operation: 'terminal', decision: 'deny', detail: "terminal: psql -c 'VACUUM FULL ledger'" },
  { at: '2026-10-05T10:01:00Z', event: 'credential-mint', principalId: 'principal_1', agentId: 'agent_p', operation: 'mint', detail: 'harness token for codex' },
  { at: '2026-10-05T10:01:30Z', event: 'permission', principalId: 'principal_1', transport: 'hook', agentId: 'agent_p', operation: 'Bash', decision: 'allow', detail: 'Bash: git status' },
  { at: '2026-10-05T10:02:05Z', event: 'approval-decision', principalId: 'principal_1', agentId: 'agent_p', operation: 'prop_1', decision: 'approve', detail: 'Bash: git push origin main' },
  { at: '2026-10-05T10:03:40Z', event: 'permission', principalId: 'principal_1', transport: 'hook', agentId: 'agent_p', operation: 'Bash', decision: 'allow', detail: 'Bash: npm test' },
];

/**
 * agent-bot's census records for the preview's souls (#122): luna has a
 * GitHub App, scout's claude sign-in expired (the banner), the rest joined
 * without an App.
 */
export const samplePopulation: Readonly<Record<string, SoulPopulation>> = {
  agent_p: { agentId: 'agent_p', appSlug: 'luna-geniusbar', harnessAuth: null },
  agent_s: { agentId: 'agent_s', appSlug: null, harnessAuth: { status: 'expired', harness: 'claude', since: '2026-10-05T09:40:00Z' } },
  agent_c: { agentId: 'agent_c', appSlug: null, harnessAuth: null },
};

/** Wake on new messages per soul (`soul cold-wake show --json`, #122): luna wakes, others do not. */
export const sampleColdWake: Readonly<Record<string, SoulColdWake>> = {
  agent_p: { on: true, lane: 'acp' },
  agent_s: { on: false, lane: null },
  agent_c: { on: false, lane: null },
};

/** Execution mode per soul (`soul mode show --json`, #122): luna is on Auto-Pilot (the banner), others Safe Mode. */
export const sampleModes: Readonly<Record<string, SoulMode>> = {
  agent_p: 'autopilot',
  agent_s: 'safe',
  agent_c: 'safe',
};

/**
 * Model per soul (`soul model show --json`, #128): luna chose Opus from its
 * harness's three, scout keeps the harness default from its list, and the
 * rest have not run a turn, so their harness has listed nothing yet.
 */
export const sampleModels: Readonly<Record<string, SoulModel>> = {
  agent_p: {
    model: 'claude-opus-4-1',
    listedAt: '2026-10-05T09:30:00.000Z',
    available: [
      { modelId: 'claude-opus-4-1', name: 'Opus 4.1', description: 'Most capable, for complex work' },
      { modelId: 'claude-sonnet-4-5', name: 'Sonnet 4.5', description: 'Fast and capable, for everyday work' },
      { modelId: 'claude-haiku-4-5', name: 'Haiku 4.5', description: 'Fastest, for quick answers' },
    ],
  },
  agent_s: {
    model: null,
    listedAt: '2026-10-05T09:35:00.000Z',
    available: [
      { modelId: 'default', name: 'Default (recommended)', description: null },
      { modelId: 'opus', name: 'Opus', description: 'Opus for complex tasks' },
    ],
  },
  agent_c: { model: null, available: null, listedAt: null },
};

/** Desktop badges for preview (#122): luna has agent comms on, agent_c drives the screen. */
export const sampleBadges: SoulBadges = { comms: new Set(['agent_p']), computerUse: new Set(['agent_c']), busy: new Set() };

/**
 * The floating Dudle's states for preview (`&dudle=`, #122): idle (nothing
 * pending), working (luna mid-turn), awaiting (the pending approvals) and
 * computer (agent_c drives the screen, so the perimeter shows).
 */
export const sampleFloating: Readonly<Record<'idle' | 'working' | 'awaiting' | 'computer', {
  approvals: boolean; busy: ReadonlySet<string>; computerUse: ReadonlySet<string>;
}>> = {
  idle: { approvals: false, busy: new Set(), computerUse: new Set() },
  working: { approvals: false, busy: new Set(['agent_p']), computerUse: new Set() },
  awaiting: { approvals: true, busy: new Set(), computerUse: new Set() },
  computer: { approvals: false, busy: new Set(), computerUse: new Set(['agent_c']) },
};

/**
 * Finder-opened packages as `soul locate` describes them, for the launch
 * form (preview `&open=copy` or `&open=described`): a copy of luna's folder,
 * which must be named to fork (#110), and a package whose soul.json gives a
 * name, description and preferred harness (#120).
 */
export const sampleOpenedPackages: Readonly<Record<'copy' | 'described', {
  path: string; name?: string; description?: string; preferredHarnesses?: string[]; copyOf?: { name: string | null; agentId: string };
}>> = {
  copy: { path: '/Users/user/Desktop/luna copy.soul', copyOf: { name: 'luna', agentId: 'agent_p' } },
  described: {
    path: '/Users/user/Desktop/Helper.soul',
    name: 'Helper - Starter',
    description: 'A starter companion that answers questions about this Mac.',
    preferredHarnesses: ['opencode', 'claude'],
  },
};

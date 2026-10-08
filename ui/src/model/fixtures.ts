// The fixed fake census and health from R1's snapshot test, for tests and
// for previewing the popup before the bridge (#7) supplies real rows.
import type { PreparedRevision, RemovalPlan, RemovalPlanEntry, RemovalScope, SoulColdWake, SoulMode, SoulModel, SoulPopulation, SoulProfile, SoulTemplateList, SoulEnvironment } from '../bridge';
import type { SandboxStatus } from '../components/Sandbox';
import type { AuditRecord } from './audit';
import type { CensusRow } from './census';
import type { HostCapabilities, HostTool, HostToolId, HostToolState } from './host';
import type { PauseEntry } from './pause';
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
 * without an App. The owner turned scout's computer use off
 * (agent-bot-identity #482); luna and agent_c may use the computer.
 */
export const samplePopulation: Readonly<Record<string, SoulPopulation>> = {
  agent_p: { agentId: 'agent_p', appSlug: 'luna-geniusbar', harnessAuth: null, computerUse: true },
  agent_s: { agentId: 'agent_s', appSlug: null, harnessAuth: { status: 'expired', harness: 'claude', since: '2026-10-05T09:40:00Z' }, computerUse: false },
  agent_c: { agentId: 'agent_c', appSlug: null, harnessAuth: null, computerUse: true },
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
      { modelId: 'default', name: 'Default (recommended)', description: null, recommended: true },
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
    name: 'Helper - Genius',
    description: 'A starter companion that answers questions about this Mac.',
    preferredHarnesses: ['opencode', 'claude'],
  },
};

/**
 * `population list` pause flags for preview (`&paused=1`) and tests (#122):
 * luna is paused (agent-bot `soul pause`), so the menu bar shows the
 * "Companions paused" chip; agent_c runs; an archived soul stays paused.
 */
export const samplePaused: readonly PauseEntry[] = [
  { agentId: 'agent_p', managed: true, paused: true, status: 'active' },
  { agentId: 'agent_c', managed: true, paused: false, status: 'active' },
  { agentId: 'agent_gone', managed: true, paused: true, status: 'retired' },
];

/**
 * agent-bot `soul templates --json` for the launch form's soul picker (#65):
 * three templates, then "Custom soul" (preview and tests).
 */
export const sampleTemplates: SoulTemplateList = {
  templates: [
    { name: 'Coder', description: 'Writes and reviews code in your repositories.', preferredHarnesses: ['claude', 'opencode'], defaultHarness: 'claude',
      package: '/Users/user/Souls/Coder.soul', revision: null, source: 'souls-root' },
    { name: 'Researcher', description: 'Reads the web and your files, then reports back.', preferredHarnesses: ['opencode'], defaultHarness: 'opencode',
      package: '/Users/user/Souls/Researcher.soul', revision: null, source: 'souls-root' },
    { name: 'Genius', description: 'A friendly first companion and GeniusBar’s guide.', preferredHarnesses: [], defaultHarness: null,
      package: '/Applications/GeniusBar.app/Contents/Resources/souls/starter.soul', revision: null, source: 'bundled' },
  ],
  soulsRoot: '/Users/user/Souls',
  errors: [],
};

/**
 * agent-bot `soul profile agent_p --json` for the Customize dialog (#64):
 * luna's profile, the files its harness loads, its SOP and own skills, a
 * declared GitHub App (name and status only), and one SOP error (preview
 * and tests). `sampleProfileFiles` holds the text files' contents.
 */
export const sampleProfile: SoulProfile = {
  agentId: 'agent_p',
  profile: {
    name: 'luna',
    displayName: 'Luna',
    description: 'Leads the team: splits work into tasks, hands them to subagents and reviews what comes back.',
    harness: 'claude',
    package: '/Users/user/Souls/Luna.soul',
    revision: '2026.10.1',
    template: false,
    parentId: null,
    status: 'active',
    appearance: null,
    skillsDisabled: [],
  },
  files: [
    { path: 'soul.md', kind: 'soul', size: 214, modifiedAt: '2026-10-01T09:12:00.000Z', text: true },
    { path: 'CLAUDE.md', kind: 'generated', size: 1024, modifiedAt: '2026-10-05T18:40:00.000Z', text: true },
    { path: '.claude/settings.json', kind: 'harness-settings', size: 312, modifiedAt: '2026-10-05T18:40:00.000Z', text: true },
    { path: 'skills/triage/SKILL.md', kind: 'skill', size: 540, modifiedAt: '2026-09-28T11:00:00.000Z', text: true },
    { path: 'skills/triage/diagram.png', kind: 'skill', size: 20480, modifiedAt: '2026-09-28T11:00:00.000Z', text: false },
  ],
  skills: [
    { name: 'review', source: 'sop', path: 'sop/skills/review/SKILL.md', commit: '3f9c2a1d7e', enabled: true },
    { name: 'ship', source: 'sop', path: 'sop/skills/ship/SKILL.md', commit: '3f9c2a1d7e', enabled: true },
    { name: 'triage', source: 'soul', path: 'skills/triage/SKILL.md', commit: null, enabled: true },
  ],
  credentials: [{ name: 'luna-geniusbar', provider: 'github', status: 'declared' }],
  sop: {
    resolved: { source: 'qwts/agent-sop', commit: '3f9c2a1d7e' },
    override: { path: 'agent-sop.toml', workflows: ['workflows/release.toml'] },
  },
  errors: [{ area: 'skills', message: 'skills/draft/SKILL.md is not UTF-8 text' }],
};

/**
 * `soul revision prepare` for sampleProfile's soul (#268): the engine's word
 * on what the Customize dialog may edit. soul.json goes through the Profile
 * fields; the generated CLAUDE.md and the harness settings are not staged.
 */
export const samplePreparedRevision: PreparedRevision = {
  agentId: 'agent_p',
  soulDir: '/Users/user/Souls/Luna.soul',
  staging: '/Users/user/Souls/Luna.soul/.soul-state/tmp/revision-44430c4f-05a7-417b-9c3f-36bb4bc2a2eb',
  revision: '2026.10.1',
  parentRevision: null,
  files: [
    { path: 'skills/triage/SKILL.md', classification: 'definition', kind: 'skill', editable: true, text: true, size: 540, mode: '100644' },
    { path: 'skills/triage/diagram.png', classification: 'definition', kind: 'skill', editable: true, text: false, size: 20480, mode: '100644' },
    { path: 'soul.json', classification: 'definition', kind: 'soul', editable: false, text: true, size: 412, mode: '100644' },
    { path: 'soul.md', classification: 'definition', kind: 'soul', editable: true, text: true, size: 214, mode: '100644' },
  ],
  excluded: { workingState: ['worktrees', '.soul-state'], generated: ['.claude/settings.json', 'CLAUDE.md'] },
  expiresAt: '2026-10-08T09:12:00.000Z',
};

export const sampleProfileFiles: Readonly<Record<string, string>> = {
  'soul.md': '# Luna\n\nRole: Lead\n\nYou are Luna, a GeniusBar companion. Split the work, hand it out, and review what comes back.\n',
  'CLAUDE.md': '<!-- generated by agent-bot from soul.md; do not edit -->\n# Luna\n\nRole: Lead\n',
  '.claude/settings.json': '{\n  "permissions": {\n    "defaultMode": "default"\n  }\n}\n',
  'skills/triage/SKILL.md': '---\nname: triage\ndescription: Sort new issues by area and urgency.\n---\n\nRead the issue, label it, and say who should take it.\n',
};

/**
 * agent-bot's removal plans for the preview (#283; agent-bot-identity #625):
 * luna leads agent_c, which leads Sprocket, offline and nested two deep.
 * Archiving only luna makes agent_c independent and leaves Sprocket under
 * it; archiving the team takes all three, and agent_c running blocks that.
 * Every other soul stands alone. The engine computes this; nothing here
 * infers a team from the census.
 */
export function sampleRemovalPlan(agentId: string, scope: RemovalScope): RemovalPlan {
  const capabilities = { plan: true, team: true, independent: true, restore: false, delete: false };
  const entry = (id: string, name: string | null, displayName: string, depth: number, running: boolean | null, parentId: string | null = null, harness: string | null = null): RemovalPlanEntry =>
    ({ agentId: id, name, displayName, status: 'active', harness, parentId, running, depth });
  if (agentId !== 'agent_p') {
    const soul = sampleCensus.find((s) => s.agentId === agentId);
    return { schemaVersion: 1, scope, agentId, capabilities, archived: [entry(agentId, soul?.name ?? null, soul?.name ?? agentId, 0, false, soul?.parent ?? null, soul?.harness ?? null)], independent: [], unchanged: [] };
  }
  const luna = entry('agent_p', 'luna', 'luna', 0, false, null, 'codex');
  const child = entry('agent_c', null, 'agent_c', 1, true, 'agent_p');
  const sprocket = entry('agent_s', 'sprocket', 'Sprocket', 2, false, 'agent_c');
  return scope === 'team'
    ? { schemaVersion: 1, scope, agentId, capabilities, archived: [luna, child, sprocket], independent: [], unchanged: [] }
    : { schemaVersion: 1, scope, agentId, capabilities, archived: [luna], independent: [child], unchanged: [sprocket] };
}
const lunaRoot = '/Users/user/Souls/Luna.soul';

/**
 * agent-bot `soul env --json` descriptors for the Environment section (#268;
 * preview and tests). luna's comes from the bundled 0.10.52 engine with
 * every capability: one declared runtime missing (node), one partial-read
 * error (the generated output could not be checked), a pending migration
 * (its Agent Space is a link outside the soul), codex's sign-in still on
 * the host, and a provider secret missing. No state is invented: readiness
 * is what the engine would report. scout's is an older engine (0.10.46,
 * `env` and `revision-prepare` only), the real capture of a built soul, so
 * nothing capability-gated is offered for it. Other souls have none: the
 * preview answers offline for them.
 */
export const sampleEnvironments: Readonly<Record<string, SoulEnvironment>> = {
  agent_p: {
    schemaVersion: 1,
    engine: { version: '0.10.52', contractVersion: 1, capabilities: ['env', 'revision-prepare', 'runtimes', 'providers', 'tool-homes', 'memory', 'history'] },
    identity: { agentId: 'agent_p', name: 'luna', displayName: 'Luna', status: 'active', harness: 'codex', revision: '2026.10.1', parentRevision: null, template: false, formatVersion: 2 },
    root: { soulDir: lunaRoot, soulsRoot: '/Users/user/Souls', source: 'environment', registered: true, marker: 'ok', copies: [], device: 16777229 },
    components: [
      { id: 'manifest', path: 'soul.json', classification: 'definition', present: true, retention: 'durable' },
      { id: 'instructions', path: 'AGENTS.md', classification: 'definition', present: true, retention: 'durable' },
      { id: 'skills', path: 'skills', classification: 'definition', present: true, retention: 'durable', entries: ['triage'] },
      { id: 'hooks', path: 'hooks', classification: 'definition', present: false, retention: 'durable' },
      { id: 'tools-bin', path: 'bin', classification: 'definition', present: false, retention: 'durable' },
      { id: 'workflows', path: 'workflows', classification: 'definition', present: true, retention: 'durable', entries: ['release.toml'] },
      { id: 'sop', path: 'sop', classification: 'definition', present: true, retention: 'durable' },
      { id: 'harness-pins', path: 'package.json', classification: 'definition', present: false, retention: 'durable' },
      { id: 'generated', path: null, classification: 'generated', present: true, retention: 'reconstructible', paths: ['.codex/', 'AGENTS.md', '.mcp.json'], drift: null },
      { id: 'workspaces', path: 'worktrees', classification: 'workspace', present: true, retention: 'durable', entries: [{ name: 'main', location: 'inside', branch: 'main' }] },
      { id: 'home', path: '.soul-state/home', classification: 'private-home', present: true, retention: 'durable', git: false, built: true, harnessInstall: 'codex' },
      { id: 'tool-state', path: '.soul-state/tools', classification: 'private-home', present: false, retention: 'durable',
        entries: [{ harness: 'codex', path: '.soul-state/tools/codex', routing: [], containment: 'shared-host', reason: 'the sign-in is not in the soul', hostPath: '/Users/user/.codex', signIn: 'missing', hostSignIn: 'present', note: null }] },
      { id: 'credentials', path: '.soul-state/credentials', classification: 'private-home', present: false, retention: 'durable', exportable: false, declared: 'luna-geniusbar', secrets: ['openai-key'] },
      { id: 'runtimes', path: '.soul-state/runtimes', classification: 'runtime', present: false, retention: 'reconstructible' },
      { id: 'memory', path: '.soul-state/space', classification: 'memory', present: true, retention: 'durable', location: 'linked', target: '/Users/user/space/luna', contained: false, spacePath: '/Users/user/space/luna', status: 'ready' },
      { id: 'history', path: '.soul-state/runs', classification: 'history', present: true, retention: 'durable', mirror: '.soul-state/runs', turns: 42, revisions: 3, mirrored: true,
        external: [{ what: 'revision journal', path: '/Users/user/.local/state/agent-bot/soul-revisions/agent_p', present: true }, { what: 'task turns', path: '/Users/user/.local/state/agent-bot/task-turns.jsonl', present: true }], confinementLog: false },
      { id: 'cache', path: '.soul-state/cache', classification: 'cache', present: false, retention: 'reconstructible' },
      { id: 'temp', path: '.soul-state/tmp', classification: 'temp', present: false, retention: 'disposable', entries: [] },
      { id: 'host-tools', path: null, classification: 'external', present: true, retention: null,
        entries: [{ name: 'agent-bot', path: '/Applications/GeniusBar.app/Contents/Resources/components/agent-bot/agent-bot', source: 'engine' }, { name: 'git', path: '/usr/bin/git', source: 'host' }] },
    ],
    classification: { enum: ['definition', 'generated', 'workspace', 'runtime', 'private-home', 'memory', 'history', 'cache', 'temp', 'external'], rules: [] },
    harnesses: { selected: 'codex', declared: [{ name: 'codex', kind: 'npm', package: '@openai/codex', version: '0.52.0', source: 'package.json' }], installed: [{ name: 'codex', kind: 'npm', package: '@openai/codex', version: '0.52.0', location: '.soul-state/home', status: 'ok' }], launchable: true },
    runtimes: { declared: { node: { version: '24.11.1' } }, installed: [], missing: [{ name: 'node', version: '24.11.1', declared: '24', requiredBy: [], reason: 'not provisioned' }], unsupported: [] },
    providers: {
      declared: [{ harness: 'codex', id: 'openai', name: 'OpenAI', baseUrl: null, envKey: 'OPENAI_API_KEY', wireApi: 'responses', credential: 'openai-key', store: 'keychain', status: 'secret-missing' }],
      secrets: [{ name: 'openai-key', store: 'keychain', status: 'missing', usedBy: ['codex'] }],
      invalid: [],
    },
    launch: { supported: true, lane: 'acp', cwd: `${lunaRoot}/.soul-state/home`, routing: { HOME: 'host', PATH: 'host', TMPDIR: 'host', toolHome: 'host' },
      limitations: [{ harness: 'codex', message: "codex's native state (/Users/user/.codex) stays shared on the host with every other soul: the sign-in is not in the soul" }] },
    readiness: {
      ready: false,
      problems: [
        { code: 'runtime-missing', severity: 'warning', component: 'runtimes', message: 'node 24.11.1 is declared but not installed in the soul; the next launch installs it.', action: 'agent-bot soul runtimes install agent_p' },
        { code: 'provider-secret-missing', severity: 'error', component: 'credentials', message: "codex's provider openai needs the secret \"openai-key\" (OPENAI_API_KEY), which is not stored for this soul", action: 'agent-bot soul secret agent_p set openai-key' },
        { code: 'tool-signin-missing', severity: 'warning', component: 'tool-state', message: "codex's sign-in is on the host (/Users/user/.codex) but not in the soul's tool home, so the launch keeps the shared host store; adopt it once to contain this soul", action: 'agent-bot soul env migrate agent_p --adopt-host-signin --harness codex' },
        { code: 'memory-not-contained', severity: 'warning', component: 'memory', message: "The Agent Space is a link to /Users/user/space/luna, outside the soul; the soul's memory does not travel with its folder until it is moved inside.", action: 'agent-bot soul env migrate agent_p --space-into-soul' },
      ],
    },
    migration: { status: 'pending', journal: '.soul-state/migration.json', steps: [
      { id: 'space-into-soul', status: 'pending', from: '/Users/user/space/luna', to: `${lunaRoot}/.soul-state/space` },
      { id: 'adopt-host-signin:codex', status: 'pending', from: '/Users/user/.codex', to: `${lunaRoot}/.soul-state/tools/codex` },
    ] },
    retention: { durable: ['manifest', 'instructions', 'skills', 'hooks', 'tools-bin', 'workflows', 'sop', 'harness-pins', 'workspaces', 'home', 'tool-state', 'credentials', 'memory', 'history'], reconstructible: ['generated', 'runtimes', 'cache'], disposable: ['temp'] },
    errors: [{ area: 'generated', message: 'Generated output could not be checked: AGENTS.md is not UTF-8 text' }],
  },
  agent_s: {
    schemaVersion: 1,
    engine: { version: '0.10.46', contractVersion: 1, capabilities: ['env', 'revision-prepare'] },
    identity: { agentId: 'agent_s', name: 'scout', displayName: 'Scout', status: 'active', harness: 'claude', revision: null, parentRevision: null, template: null, formatVersion: 2 },
    root: { soulDir: '/Users/user/Souls/Scout.soul', soulsRoot: '/Users/user/Souls', source: 'environment', registered: true, marker: 'ok', copies: [], device: 16777229 },
    components: [
      { id: 'manifest', path: 'soul.json', classification: 'definition', present: true, retention: 'durable' },
      { id: 'instructions', path: 'AGENTS.md', classification: 'definition', present: true, retention: 'durable' },
      { id: 'skills', path: 'skills', classification: 'definition', present: true, retention: 'durable', entries: ['hello'] },
      { id: 'generated', path: null, classification: 'generated', present: true, retention: 'reconstructible', paths: ['.claude/', 'CLAUDE.md'], drift: [] },
      { id: 'home', path: '.soul-state/home', classification: 'private-home', present: true, retention: 'durable', git: false, built: true, harnessInstall: null },
      { id: 'tool-state', path: '.soul-state/tools', classification: 'private-home', present: false, retention: 'durable',
        entries: [{ harness: 'claude', path: '.soul-state/tools/claude', routing: [], containment: 'shared-host', hostPath: '/Users/user/.claude', signIn: 'unknown' }] },
      { id: 'runtimes', path: '.soul-state/runtimes', classification: 'runtime', present: false, retention: 'reconstructible' },
      { id: 'memory', path: '.soul-state/space', classification: 'memory', present: true, retention: 'durable', location: 'linked', target: '/Users/user/space/scout', contained: false, spacePath: '/Users/user/space/scout', status: 'missing' },
      { id: 'history', path: '.soul-state/runs', classification: 'history', present: false, retention: 'durable', external: [], confinementLog: false },
      { id: 'temp', path: '.soul-state/tmp', classification: 'temp', present: false, retention: 'disposable', entries: [] },
    ],
    classification: { enum: ['definition', 'generated', 'workspace', 'runtime', 'private-home', 'memory', 'history', 'cache', 'temp', 'external'], rules: [] },
    harnesses: { selected: 'claude', declared: [], installed: [], launchable: false },
    runtimes: { declared: { node: { version: '24.11.1' } }, installed: [], missing: [{ name: 'node', version: '24.11.1', reason: 'not provisioned' }], unsupported: [] },
    providers: {},
    launch: { supported: true, lane: 'acp', cwd: '/Users/user/Souls/Scout.soul/.soul-state/home', routing: { HOME: 'host', PATH: 'host', TMPDIR: 'host' },
      limitations: [{ harness: 'claude', message: "claude's native state (/Users/user/.claude) is shared on the host with every other soul until the launch environment contract routes it into the soul" }] },
    readiness: { ready: true, problems: [] },
    migration: { status: 'pending', journal: '.soul-state/migration.json', steps: [{ id: 'space-into-soul', status: 'pending', from: '/Users/user/space/scout', to: '/Users/user/Souls/Scout.soul/.soul-state/space' }] },
    retention: { durable: ['manifest', 'instructions', 'skills', 'home', 'tool-state', 'memory', 'history'], reconstructible: ['generated', 'runtimes'], disposable: ['temp'] },
    errors: [],
  },
};

/**
 * The sandbox as `agent-bot sandbox status --json` reports it (#66), for the
 * preview's Sandboxing card and account dialog: the switch on, GeniusBar's
 * default account `geniusbar-agent` ready, luna sandboxed on it, agent_c
 * running as the owner, and no SOP pack; the preview's scenarios vary it.
 */
export const sampleSandbox: SandboxStatus = {
  enabled: true,
  provider: 'standard_macos_account',
  account: 'geniusbar-agent',
  status: 'ready',
  steps: [],
  souls: [
    { agentId: 'agent_p', name: 'luna', override: 'inherit', sandboxed: true, runsAs: 'geniusbar-agent', source: 'global', rule: null, reason: null },
    { agentId: 'agent_c', name: 'agent_c', override: 'unrestricted', sandboxed: false, runsAs: 'user', source: 'override', rule: null, reason: null },
  ],
  sop: { state: 'none', decides: false, repository: null, commit: null, rules: 0, message: null },
};

/** The owner's steps agent-bot lists for an account that does not exist yet, as `sandbox plan` prints them. */
export const sampleSandboxSteps = (account: string): SandboxStatus['steps'] => [
  { id: 'create-account', title: `Create the standard account ${account}`, run: 'owner-admin',
    commands: [`sudo sysadminctl -addUser ${account} -fullName "GeniusBar Agent" -password -`], done: false,
    note: 'Either command; the first asks for a password for the new account. Leave it a Standard account: no admin rights.' },
  { id: 'standard-account', title: `${account} has no admin rights`, run: 'owner-admin', commands: [`sudo dseditgroup -o edit -d ${account} -t user admin`], done: null },
  { id: 'dev-tools', title: 'Apple command-line tools are installed (shared by every account)', run: 'owner', commands: ['xcode-select --install'], done: true },
  { id: 'broker-group', title: `${account} may reach the agent-comms broker`, run: 'owner-admin', commands: [`sudo dseditgroup -o edit -a ${account} -t user agent-comms`], done: null },
  { id: 'pair', title: `Pair ${account} with the broker`, run: 'account', commands: ['agent-comms account pair --broker user'], done: false },
  { id: 'harness-sign-in', title: `Sign the harnesses in as ${account}`, run: 'account', commands: ['claude'], done: null },
];

const hostTool = (id: HostToolId, state: HostToolState, message: string | null = null): HostTool => ({ id, bundled: true, state, message });

/**
 * Host capability results (#46), as `host_capabilities` reports them: a
 * Mac with every bundled tool ready, and a Windows PC in each state the
 * design shows (an unsigned development build, as CI's Windows installer
 * is until the signing secrets exist).
 */
export const sampleHosts: Readonly<Record<'macos' | 'windows' | 'windowsChecking' | 'windowsMissing' | 'windowsFailed' | 'windowsMixed', HostCapabilities>> = {
  macos: {
    platform: 'macos',
    tools: [hostTool('git', 'ready'), hostTool('node', 'ready'), hostTool('cli', 'ready')],
    build: { signed: null, updater: true },
  },
  windows: {
    platform: 'windows',
    tools: [hostTool('git', 'ready'), hostTool('node', 'ready'), hostTool('cli', 'ready')],
    build: { signed: false, updater: false },
  },
  windowsChecking: {
    platform: 'windows',
    tools: [hostTool('git', 'checking'), hostTool('node', 'checking'), hostTool('cli', 'checking')],
    build: { signed: false, updater: false },
  },
  windowsMissing: {
    platform: 'windows',
    tools: [hostTool('git', 'missing'), hostTool('node', 'ready'), hostTool('cli', 'ready')],
    build: { signed: false, updater: false },
  },
  windowsFailed: {
    platform: 'windows',
    tools: [hostTool('git', 'ready'), hostTool('node', 'ready'), hostTool('cli', 'failed', 'agent-bot: access denied (example host message)')],
    build: { signed: false, updater: false },
  },
  // The design's screenshot: one row in each reported state.
  windowsMixed: {
    platform: 'windows',
    tools: [hostTool('git', 'ready'), hostTool('node', 'missing'), hostTool('cli', 'failed', 'access denied (example host message)')],
    build: { signed: false, updater: false },
  },
};

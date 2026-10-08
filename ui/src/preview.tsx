// Dev-only preview (`npm run dev`, then /preview.html?mode=tray|window,
// plus &select=<agent id> to open a companion (its Audit log tab shows
// sampleAudit; its Details show samplePopulation and sampleColdWake, and
// &select=agent_s shows the expired sign-in banner; &select=agent_p shows
// luna on Auto-Pilot from sampleModes, its banner and the mode switch, and
// luna's Model row from sampleModels; its Launch… form has the Model field), or
// &open=<path> to open a package as Finder would (&open=copy for a copied
// folder that must be named, &open=described for a package whose soul.json
// prefills the form; &select=agent_p then Launch… relaunches luna with no
// Name field); window mode shows luna's
// comms badge and agent_c's computer-use badge from sampleBadges, and
// Archive / Remove… archive locally, refusing while luna "runs"; the
// computer-use perimeter shows, and &dudle=idle|working|awaiting|computer
// also shows the floating Dudle's button (off in the app) in one state from
// sampleFloating; with &dudle=computer the perimeter's Stop "stops" agent_c
// after a moment, and hold Esc does the same); window mode's Pause all /
// Resume (quick menu, and the "Companions paused" chip) act on an in-memory
// samplePaused, and &paused=1 starts with luna paused so the chip shows;
// Details (and ⓘ) show the Computer use row from samplePopulation (scout's
// is off), and with &dudle=… the quick menu's "Toggle computer use" flips
// the lead's (luna's), as agent-bot `soul computer-use` would; Launch… shows
// the soul picker with sampleTemplates' three templates and "Custom soul"
// (&templates=0 shows the form an agent-bot without `soul templates` gives);
// ⓘ offers Customize…, showing sampleProfile read-only for any companion
// (&customize=1 opens it on load for the selected one, &customize=0 hides it
// as an agent-bot without `soul profile` would);
// &sandbox=editable|locked|missing|gated|unknown shows the Sandboxing card
// on sampleSandbox and its Edit account… dialog (#66) in that scenario
// (luna's chip menu has it too; locked = the SOP pack decides luna's
// account; missing = a saved account agent-bot finds absent, with its
// steps; gated = an agent-bot without `sandbox account`; unknown = a save
// agent-bot answers unclearly, then re-read);
// &surface=team|session|audit|customize|launch (with &soul=user/agent_p,
// and &tab= / &action=archive for a session) shows that native window's
// page (#223), and what it opens opens in a new tab:
// &host=windows|macos shows the first launch (#46) on an empty roster with
// a Platform switch and, on Windows, each bundled tool's state (Starting…,
// Ready, Missing, Couldn't start) and the build note; Retry "probes" again:
// the app on the fixed fixtures, without Tauri. Not part of the build.
import { StrictMode, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App, AppProviders, type AppMode } from './App';
import type { Archiver } from './components/ArchiveDialog';
import type { ComputerUseSwitch, SurfaceRequest } from './bridge';
import { parseSurface } from './model/surface';
import { AuditSurface } from './surfaces/AuditSurface';
import { CustomizeSurface } from './surfaces/CustomizeSurface';
import { LaunchSurface } from './surfaces/LaunchSurface';
import { SessionSurface } from './surfaces/SessionSurface';
import { TeamSurface } from './surfaces/TeamSurface';
import type { Stopper } from './components/FloatingDudle';
import { AuditSourceContext, type AuditSource } from './components/AuditLog';
import { SoulSourceContext, type SoulSource } from './components/SoulNotices';
import { EnvironmentSourceContext, type EnvironmentSource } from './components/EnvironmentSection';
import type { CensusRow } from './model/census';
import { emptyChat, emptyComposer, mergeIncoming, type ChatState } from './model/chat';
import { inboxMessage, sampleApprovals, sampleAudit, sampleBadges, sampleCensus, sampleColdWake, sampleConnection, sampleEnvironments, sampleFloating, sampleHosts, sampleModels, sampleModes, sampleOpenedPackages, samplePaused, samplePopulation, samplePreparedRevision, sampleProfile, sampleProfileFiles, sampleRemovalPlan, sampleSandbox, sampleSandboxSteps, sampleSessionEntries, sampleTemplates } from './model/fixtures';
import type { SandboxSource, SandboxStatus } from './components/Sandbox';
import { HOST_TOOLS, checkingHost, type HostCapabilities, type HostToolId, type HostToolState } from './model/host';
import type { Starter } from './components/FirstLaunch';
import type { Pauser } from './usePause';
import type { TemplateLister } from './useSoulTemplates';
import { BridgeError, type SoulEnvironment } from './bridge';
import { ProfileSourceContext, type ProfileSource } from './useSoulProfile';
import { CustomizeDialog } from './components/CustomizeDialog';
import { I18nProvider } from './lib/i18n';
import type { ChatApi } from './useChat';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-600.css';
import './styles.css';

const row = (agentId: string, name: string, harness: string, parent: string | null, presence: CensusRow['presence'] = 'joined'): CensusRow =>
  ({ account: 'user', agentId, name, harness, parent, presence, unacked: 0, lastWake: null });

const census: CensusRow[] = [
  ...sampleCensus,
  row('agent_s', 'scout', 'claude', 'agent_p'),
  row('agent_q', 'quill', 'codex', 'agent_s'),
  row('agent_n', 'nova', 'claude', null),
  row('agent_b', 'beacon', 'codex', 'agent_n'),
  row('agent_e', 'ember', 'claude', 'agent_n', 'watching'),
];

const { state: inbox } = mergeIncoming(emptyChat, [
  inboxMessage('msg_1', 1, 'Morning! I finished the census refactor.\nWant me to open a PR?', { account: 'user', agentId: 'agent_p' }),
  inboxMessage('msg_2', 2, 'scout found two flaky tests; quill is on them.', { account: 'user', agentId: 'agent_p' }),
  inboxMessage('msg_3', 3, 'hello from agent_c', { account: 'user', agentId: 'agent_c' }),
]);

// luna's chat also shows every entry kind (#122) without a broker.
const lunaKey = 'user/agent_p';
const luna = inbox.conversations[lunaKey];
const state: ChatState = {
  conversations: { ...inbox.conversations, [lunaKey]: { ...luna, entries: [...luna.entries, ...sampleSessionEntries] } },
  ids: new Set([...inbox.ids, ...sampleSessionEntries.map((e) => e.id)]),
};

// The Audit log tab (#122) reads the fixture rather than agent-bot.
const audit: AuditSource = async (agentId) => sampleAudit.filter((r) => agentId === null || r.agentId === agentId);

// Details rows and the sign-in banner (#122) read fixtures; changes land
// locally, as agent-bot would apply them once the owner approves.
const population = { ...samplePopulation };
const wakes = { ...sampleColdWake };
const modes = { ...sampleModes };
const models = { ...sampleModels };
const soulSource: SoulSource = {
  population: async (agentId) => population[agentId] ?? null,
  coldWake: async (agentId) => wakes[agentId] ?? null,
  setColdWake: async (agentId, on) => (wakes[agentId] = { on, lane: on ? 'acp' : null }),
  signedIn: async (_harness, agentId) => (agentId in population ? true : null),
  signIn: async (_harness, agentId) => {
    const record = population[agentId];
    if (record) population[agentId] = { ...record, harnessAuth: null };
    return true;
  },
  mode: async (agentId) => modes[agentId] ?? null,
  setMode: async (agentId, mode) => (modes[agentId] = mode),
  model: async (agentId) => models[agentId] ?? null,
  setModel: async (agentId, model) => (models[agentId] = { ...(models[agentId] ?? { available: null, listedAt: null }), model }),
};

// The owner's computer-use switch (#122) on the same records.
const computerUseSwitch: ComputerUseSwitch = {
  supported: async () => true,
  read: async (agentId) => population[agentId]?.computerUse ?? null,
  set: async (agentId, on) => {
    const record = population[agentId];
    if (record) population[agentId] = { ...record, computerUse: on };
    return { agentId, computerUse: on };
  },
};

// The Environment section (#268) on sampleEnvironments: luna's install and
// migrations "succeed" as the engine would report them once the owner
// approves; scout's older engine offers none; the rest read as offline,
// and the archived soul as an engine without `soul env`.
const environments: Record<string, SoulEnvironment> = { ...sampleEnvironments };
const environmentSource: EnvironmentSource = {
  environment: async (agentId) => {
    const env = environments[agentId];
    if (env) return env;
    throw new BridgeError(agentId === 'agent_gone' ? 'soul-env-unsupported' : 'soul-env-unavailable', 'no environment in the preview');
  },
  installRuntime: async (agentId, runtime) => {
    const env = environments[agentId];
    if (!env) throw new BridgeError('soul-not-found', 'Soul not found.');
    const row = env.runtimes.missing.find((r) => r.name === runtime);
    if (!row) throw new BridgeError('runtime-install-failed', `${runtime} is not declared`);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const installed = { ...row, source: 'catalog', path: `${env.root.soulDir}/.soul-state/runtimes/${runtime}/${row.version}`, bin: 'bin' };
    environments[agentId] = {
      ...env,
      runtimes: { ...env.runtimes, installed: [...env.runtimes.installed, installed], missing: env.runtimes.missing.filter((r) => r.name !== runtime) },
      readiness: { ...env.readiness, problems: env.readiness.problems.filter((p) => !(p.code === 'runtime-missing' && typeof p.message === 'string' && p.message.startsWith(`${runtime} `))) },
    };
    return { agentId, ready: environments[agentId].readiness.ready, installed: [runtime], skipped: [], harnesses: [],
      runtimes: [{ name: runtime, status: 'installed', version: typeof row.version === 'string' ? row.version : null, lastError: null }] };
  },
  migrate: async (agentId, kind, harness, plan = false) => {
    const env = environments[agentId];
    if (!env) throw new BridgeError('soul-not-found', 'Soul not found.');
    await new Promise((resolve) => setTimeout(resolve, 800));
    if (kind === 'complete') {
      // Every step still pending, as `--complete --plan` lists them with a note; the apply marks them done.
      const pending = env.migration.steps.filter((s) => s.status !== 'done' && s.status !== 'skipped');
      if (plan) return { agentId, operation: 'complete', decision: 'planned', steps: pending.map((s) => ({ ...s, note: s.status === 'pending' ? 'not started' : `interrupted while ${s.status}; resumed` })) };
      if (pending.length === 0) return { agentId, operation: 'complete', decision: 'skipped', steps: [] };
      environments[agentId] = {
        ...env,
        components: env.components.map((c) => (c.id === 'memory' ? { ...c, location: 'inside', contained: true, target: null } : c)),
        readiness: { ...env.readiness, problems: env.readiness.problems.filter((p) => p.code !== 'memory-not-contained' && p.code !== 'tool-signin-missing') },
        migration: { ...env.migration, status: 'none', steps: env.migration.steps.map((s) => ({ ...s, status: 'done' })) },
      };
      return { agentId, operation: 'complete', decision: 'completed', steps: pending.map((s) => ({ ...s, status: 'done', note: s.id === 'space-into-soul' ? 'copied 2 file(s), 0 link(s); source retired' : 'copied auth.json' })) };
    }
    const id = kind === 'space-into-soul' ? 'space-into-soul' : `adopt-host-signin:${harness ?? env.harnesses.selected ?? ''}`;
    const code = kind === 'space-into-soul' ? 'memory-not-contained' : 'tool-signin-missing';
    const steps = env.migration.steps.map((s) => (s.id === id ? { ...s, status: 'done' } : s));
    const pending = steps.some((s) => s.status === 'pending');
    environments[agentId] = {
      ...env,
      components: env.components.map((c) => (kind === 'space-into-soul' && c.id === 'memory' ? { ...c, location: 'inside', contained: true, target: null }
        : kind === 'adopt-host-signin' && c.id === 'tool-state' ? { ...c, present: true, entries: (Array.isArray(c.entries) ? c.entries : []).map((e) => (e && typeof e === 'object' && (e as { harness?: unknown }).harness === harness ? { ...e, signIn: 'present', containment: 'soul' } : e)) } : c)),
      readiness: { ...env.readiness, problems: env.readiness.problems.filter((p) => p.code !== code) },
      migration: { ...env.migration, status: pending ? 'pending' : 'none', steps },
    };
    return { agentId, operation: kind, decision: kind === 'space-into-soul' ? 'migrated' : 'adopted',
      steps: steps.filter((s) => s.id === id).map((s) => ({ ...s, note: kind === 'space-into-soul' ? null : 'copied auth.json' })) };
  },
  // A clean as agent-bot 0.10.54 plans one: two cache entries and a runtime
  // cache removable, a fresh revision staging kept; the apply "removes" them.
  clean: async (agentId, { plan }) => {
    const env = environments[agentId];
    if (!env) throw new BridgeError('soul-not-found', 'Soul not found.');
    await new Promise((resolve) => setTimeout(resolve, 800));
    const root = env.root.soulDir ?? '';
    const row = (component: string, relative: string, classification: string, retention: 'reconstructible' | 'disposable', kind: string, files: number, bytes: number) =>
      ({ component, relative, path: `${root}/${relative}`, classification, retention, kind, files, bytes, reason: null, error: null });
    const removable = [
      row('cache', '.soul-state/cache/index.db', 'cache', 'reconstructible', 'cache-entry', 1, 12288),
      row('cache', '.soul-state/cache/skills', 'cache', 'reconstructible', 'cache-entry', 14, 1_572_864),
      row('runtimes', '.soul-state/runtimes/node/npm-cache', 'runtime', 'reconstructible', 'runtime-cache', 212, 48_234_496),
    ];
    const kept = [{ ...row('temp', '.soul-state/tmp/revision-00000000-0000-4000-8000-000000000001', 'temp', 'disposable', 'revision-staging', 0, 0), files: null, bytes: null,
      reason: "a revision staging within its 24-hour window may be a host's edit in progress; agent-bot soul revision prepare --discard removes it" }];
    const files = removable.reduce((sum, r) => sum + r.files, 0);
    const bytes = removable.reduce((sum, r) => sum + r.bytes, 0);
    const base = { agentId, soulDir: root, components: ['cache', 'temp', 'runtimes'], removable, removed: [], failed: [], kept, files, bytes };
    return plan ? { ...base, applied: false, decision: 'planned' } : { ...base, applied: true, decision: 'cleaned', removed: removable };
  },
};

// The Sandboxing card and its account dialog (#66) on sampleSandbox, in the
// scenario &sandbox= names; absent, the card stays hidden as it is without
// agent-bot. A save lands locally as agent-bot would once the owner approves.
function previewSandbox(scenario: string): SandboxSource {
  const sop = { state: 'ok', decides: true, repository: 'qwts/sop', commit: 'abcdef0123456789abcdef0123456789abcdef01', rules: 1, message: null };
  let current: SandboxStatus = scenario === 'locked'
    ? { ...sampleSandbox, sop, souls: sampleSandbox.souls.map((s) => (s.agentId === 'agent_p' ? { ...s, runsAs: 'gb-luna', source: 'sop', rule: 'soul:luna' } : s)) }
    : sampleSandbox;
  const withAccount = (account: string): SandboxStatus => {
    const missing = scenario === 'missing' && account !== sampleSandbox.account;
    return { ...current, account, status: missing ? 'missing' : 'ready', steps: missing ? sampleSandboxSteps(account) : [],
      souls: current.souls.map((s) => (s.sandboxed && s.source !== 'sop' ? { ...s, runsAs: account } : s)) };
  };
  return {
    status: async () => current,
    set: async (on) => { current = { ...current, enabled: on }; return { enabled: on, provider: current.provider, account: current.account }; },
    override: async (agentId, override) => {
      const row = current.souls.find((s) => s.agentId === agentId);
      if (!row) throw new BridgeError('soul-not-found', 'Soul not found.');
      const sandboxed = override === 'inherit' ? current.enabled : override === 'sandboxed';
      const next = { ...row, override, sandboxed, runsAs: sandboxed ? current.account : 'user', source: override === 'inherit' ? 'global' as const : 'override' as const };
      current = { ...current, souls: current.souls.map((s) => (s.agentId === agentId ? next : s)) };
      return next;
    },
    pairings: async () => [],
    approve: async () => ({}),
    account: async (name) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (scenario === 'unknown') { current = withAccount(name); throw new BridgeError('sandbox-failed', 'agent-bot sandbox: no answer'); }
      current = withAccount(name);
      return { enabled: current.enabled, provider: current.provider, account: name };
    },
    accountSupported: async () => scenario !== 'gated',
  };
}

// The Customize dialog (#64): sampleProfile for whichever companion asks.
const profileSource: ProfileSource = {
  profile: async (agentId) => {
    if (new URLSearchParams(location.search).get('customize') === '0') throw new BridgeError('soul-profile-unsupported', 'no soul profile');
    return { ...sampleProfile, agentId };
  },
  file: async (agentId, path) => {
    const contents = sampleProfileFiles[path];
    if (contents === undefined) throw new BridgeError('soul-profile-file-denied', 'Profile file is not in the inventory.');
    return { agentId, path, size: contents.length, contents };
  },
  prepare: async (agentId) => ({ ...samplePreparedRevision, agentId }),
  discard: async () => {},
};

// The first launch (#46) on an empty roster: the starter soul as the
// shell reports it, and the host as the scenario's switches say.
const previewStarter: Starter = { package: '/App/souls/starter.soul', account: 'friend', name: 'Genius', harnesses: ['claude', 'codex'], devTools: true };
const TOOL_STATES: readonly HostToolState[] = ['checking', 'ready', 'missing', 'failed'];
interface HostScenario { platform: 'macos' | 'windows'; states: Record<HostToolId, HostToolState>; signed: boolean }
function scenarioHost(s: HostScenario): HostCapabilities {
  if (s.platform === 'macos') return sampleHosts.macos;
  return {
    platform: 'windows',
    tools: HOST_TOOLS.map((id) => ({ id, bundled: true, state: s.states[id], message: s.states[id] === 'failed' ? 'access denied (example host message)' : null })),
    build: { signed: s.signed, updater: s.signed },
  };
}

/** The scenario's switches, under the popup: Platform, each tool's state, signing. */
function HostControls({ scenario, onChange }: { scenario: HostScenario; onChange: (next: HostScenario) => void }) {
  const chip = (on: boolean) => `rounded border px-2 py-0.5 text-xs ${on ? 'border-amber-500 bg-amber-500/20' : 'border-neutral-600'}`;
  return (
    <div className="grid gap-2 text-xs" style={{ width: 384, margin: '0 16px 16px' }}>
      <div className="flex items-center gap-2">
        <span>Platform:</span>
        {(['macos', 'windows'] as const).map((platform) => (
          <button key={platform} type="button" className={chip(scenario.platform === platform)} onClick={() => onChange({ ...scenario, platform })}>{platform === 'macos' ? 'macOS' : 'Windows'}</button>
        ))}
        {scenario.platform === 'windows' && (
          <label className="ml-auto flex items-center gap-1"><input type="checkbox" checked={scenario.signed} onChange={(e) => onChange({ ...scenario, signed: e.target.checked })} />signed + updater</label>
        )}
      </div>
      {scenario.platform === 'windows' && HOST_TOOLS.map((id) => (
        <div key={id} className="flex items-center gap-2">
          <span className="w-10">{id}</span>
          {TOOL_STATES.map((state) => (
            <button key={state} type="button" className={chip(scenario.states[id] === state)} onClick={() => onChange({ ...scenario, states: { ...scenario.states, [id]: state } })}>{state}</button>
          ))}
        </div>
      ))}
    </div>
  );
}

function Preview() {
  const params = new URLSearchParams(location.search);
  const mode = (params.get('mode') === 'window' ? 'window' : 'tray') as AppMode;
  // &host=windows|macos: the first launch (#46) with the scenario's switches.
  const hostParam = params.get('host');
  const [scenario, setScenario] = useState<HostScenario | null>(hostParam === 'windows' || hostParam === 'macos'
    ? { platform: hostParam, states: { git: 'ready', node: 'missing', cli: 'failed' }, signed: false } : null);
  // Retry: every row says Starting… for a moment, then the switches' states again.
  const [probing, setProbing] = useState(false);
  const previewHost = scenario ? (probing ? checkingHost(scenarioHost(scenario)) : scenarioHost(scenario)) : undefined;
  const recheckHost = () => { setProbing(true); setTimeout(() => setProbing(false), 900); };
  const [composers, setComposers] = useState<ChatApi['composers']>({});
  const [chatState, setChatState] = useState(state);
  // The menu's approval list (#85): two pending proposals, decided locally.
  const dudle = params.get('dudle') ?? '';
  const floating = Object.hasOwn(sampleFloating, dudle) ? sampleFloating[dudle as keyof typeof sampleFloating] : null;
  const [records, setRecords] = useState(floating && !floating.approvals ? [] : sampleApprovals);
  const chat: ChatApi = {
    chat: chatState,
    composers,
    open: () => {},
    setDraft: (key, draft) => setComposers((c) => ({ ...c, [key]: { ...(c[key] ?? emptyComposer), draft } })),
    send: async () => {},
    // Answers approvals locally, as agent-bot would once the owner confirms.
    resolve: async (key, entryId, decision) => setChatState((s) => {
      const c = s.conversations[key];
      if (!c) return s;
      const entries = c.entries.map((e) => (e.id === entryId && e.kind === 'approval_request' ? { ...e, status: decision } : e));
      return { ...s, conversations: { ...s.conversations, [key]: { ...c, entries } } };
    }),
    approvals: { records, local: new Map() },
    decide: async (proposalId) => setRecords((r) => r.filter((p) => p.proposalId !== proposalId)),
  };
  // Archive (#94, #283) on the fixtures: agent_c is running, so it is locked
  // and blocks luna's team; luna's plan shows its nested team; others go.
  const [souls, setSouls] = useState(census);
  const archiver = useMemo<Archiver>(() => ({
    running: async (agentId) => agentId === 'agent_c',
    plan: async (agentId, scope) => sampleRemovalPlan(agentId, scope),
    remove: async (agentId, scope = 'soul') => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      const plan = sampleRemovalPlan(agentId, scope);
      const gone = new Set(plan.archived.map((e) => e.agentId));
      setSouls((list) => list.filter((s) => !gone.has(s.agentId)).map((s) => (s.parent && gone.has(s.parent) ? { ...s, parent: null } : s)));
      const named = ({ agentId: id, name, displayName }: { agentId: string; name: string | null; displayName: string }) => ({ agentId: id, name, displayName });
      return {
        agentId, name: null, comms: 'left', archived: [{ from: `/souls/${agentId}`, to: `/souls/.archive/${agentId}` }],
        effects: { scope, archived: plan.archived.map((e) => ({ agentId: e.agentId, name: e.displayName, comms: 'left' })), independent: plan.independent.map((e) => ({ ...named(e), formerParentId: agentId })), notArchived: [] },
      };
    },
  }), []);
  // The perimeter's Stop (#122) on the fixtures: the daemon drops the soul from
  // computer use a moment after agent-bot `soul stop` answers.
  const [driving, setDriving] = useState<ReadonlySet<string> | null>(null);
  const stopper = useMemo<Stopper>(() => ({
    supported: async () => true,
    stop: async (agentId) => {
      setTimeout(() => setDriving(new Set()), 1500);
      return { agentId, stopped: true };
    },
  }), []);
  // Pause all / Resume (#122) on the fixtures, as agent-bot `soul pause` would.
  const pauser = useMemo<Pauser>(() => {
    let entries = samplePaused.map((e) => ({ ...e, paused: params.get('paused') === '1' ? e.paused : false }));
    const set = (agentId: string, paused: boolean) => {
      entries = entries.map((e) => (e.agentId === agentId ? { ...e, paused } : e));
      return { agentId, paused };
    };
    return {
      supported: async () => true,
      list: async () => entries,
      pause: async (agentId) => ({ ...set(agentId, true), stopped: false }),
      resume: async (agentId) => set(agentId, false),
    };
  }, []);
  // The launch form's soul picker (#65), as agent-bot `soul templates` would list it.
  const templateLister = useMemo<TemplateLister | undefined>(() => (params.get('templates') === '0' ? undefined : async () => sampleTemplates), []);
  const sandboxScenario = params.get('sandbox');
  const sandboxSource = useMemo<SandboxSource | null>(() => (sandboxScenario ? previewSandbox(sandboxScenario) : null), [sandboxScenario]);
  const opened = params.get('open');
  const fixture = opened === 'copy' || opened === 'described' ? sampleOpenedPackages[opened] : null;
  const openedPackage = opened ? { id: 1, checking: false, error: null, path: opened, ...fixture } : undefined;
  const app = <App mode={mode} select={params.get('select')} openedPackage={openedPackage} census={scenario ? [] : souls} badges={floating ? { ...sampleBadges, computerUse: driving ?? floating.computerUse, busy: floating.busy } : sampleBadges} stopper={stopper} pauser={pauser} computerUseSwitch={computerUseSwitch} templateLister={templateLister} profileSource={profileSource} sandboxSource={sandboxSource} floatingButton={floating !== null} archiver={archiver} connection={{ ...sampleConnection, lastRefresh: new Date() }} chat={chat}
    onRefresh={() => {}} onRemoveServices={async () => {}} updates={{ status: { state: 'idle', version: null }, act: () => {} }}
    starter={scenario ? previewStarter : undefined} host={previewHost} onRecheckHost={recheckHost} devTools={{ install: async () => {}, recheck: () => {} }}
    launcher={{ state: { phase: 'idle' }, launch: async () => {}, reset: () => {} }} />;
  // &customize=1: the Customize dialog open on load, for the selected companion (or luna).
  const [customizing, setCustomizing] = useState(params.get('customize') === '1');
  const customized = souls.find((s) => s.agentId === (params.get('select') ?? 'agent_p')) ?? souls[0];
  const dialog = customizing && customized && (
    <I18nProvider><ProfileSourceContext.Provider value={profileSource}>
      <CustomizeDialog soul={customized} onClose={() => setCustomizing(false)} />
    </ProfileSourceContext.Provider></I18nProvider>
  );
  // A native window's page (#223) on the same fixtures; what it opens, a new tab opens.
  const query = parseSurface(location.search);
  if (query.surface !== null && query.surface !== 'tray' && query.surface !== 'window') {
    const data = { census: souls, loaded: true, chat, badges: sampleBadges, win: null };
    const open = async ({ surface, soul, tab, action }: SurfaceRequest) => {
      const next = new URLSearchParams({ surface, ...(soul ? { soul } : {}), ...(tab ? { tab } : {}), ...(action ? { action } : {}) });
      window.open(`?${next}`, '_blank');
    };
    const launcher = { state: { phase: 'idle' as const }, launch: async () => {}, reset: () => {} };
    return (
      <AppProviders profileSource={profileSource} computerUseSwitch={computerUseSwitch} sandboxSource={sandboxSource}>
        {query.surface === 'team' && <TeamSurface {...data} soul={query.soul} open={open} />}
        {query.surface === 'session' && <SessionSurface {...data} soul={query.soul} tab={query.tab} action={query.action} open={open} launcher={launcher} archiver={archiver} />}
        {query.surface === 'audit' && <AuditSurface {...data} soul={query.soul} />}
        {query.surface === 'customize' && <CustomizeSurface {...data} soul={query.soul} />}
        {query.surface === 'launch' && <LaunchSurface {...data} launcher={launcher} open={open} listTemplates={templateLister} />}
      </AppProviders>
    );
  }
  // The tray popup is a fixed 384×560 window (tauri.conf.json).
  const controls = scenario && <HostControls scenario={scenario} onChange={(next) => { setProbing(false); setScenario(next); }} />;
  return <>{mode === 'tray' ? <div style={{ width: 384, height: 560, margin: 16, outline: '1px solid #444' }}>{app}</div> : app}{controls}{dialog}</>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><AuditSourceContext.Provider value={audit}><SoulSourceContext.Provider value={soulSource}><EnvironmentSourceContext.Provider value={environmentSource}><Preview /></EnvironmentSourceContext.Provider></SoulSourceContext.Provider></AuditSourceContext.Provider></StrictMode>);

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
// &surface=team|session|audit|customize|launch (with &soul=user/agent_p,
// and &tab= / &action=archive for a session) shows that native window's
// page (#223), and what it opens opens in a new tab:
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
import { inboxMessage, sampleApprovals, sampleAudit, sampleBadges, sampleCensus, sampleColdWake, sampleConnection, sampleFloating, sampleModels, sampleModes, sampleOpenedPackages, samplePaused, samplePopulation, sampleRemovalPlan, sampleSessionEntries, samplePreparedRevision, sampleProfile, sampleProfileFiles, sampleTemplates, sampleEnvironments } from './model/fixtures';
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
  migrate: async (agentId, kind, harness) => {
    const env = environments[agentId];
    if (!env) throw new BridgeError('soul-not-found', 'Soul not found.');
    await new Promise((resolve) => setTimeout(resolve, 800));
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
};

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

function Preview() {
  const params = new URLSearchParams(location.search);
  const mode = (params.get('mode') === 'window' ? 'window' : 'tray') as AppMode;
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
  const opened = params.get('open');
  const fixture = opened === 'copy' || opened === 'described' ? sampleOpenedPackages[opened] : null;
  const openedPackage = opened ? { id: 1, checking: false, error: null, path: opened, ...fixture } : undefined;
  const app = <App mode={mode} select={params.get('select')} openedPackage={openedPackage} census={souls} badges={floating ? { ...sampleBadges, computerUse: driving ?? floating.computerUse, busy: floating.busy } : sampleBadges} stopper={stopper} pauser={pauser} computerUseSwitch={computerUseSwitch} templateLister={templateLister} profileSource={profileSource} floatingButton={floating !== null} archiver={archiver} connection={{ ...sampleConnection, lastRefresh: new Date() }} chat={chat}
    onRefresh={() => {}} onRemoveServices={async () => {}} updates={{ status: { state: 'idle', version: null }, act: () => {} }}
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
      <AppProviders profileSource={profileSource} computerUseSwitch={computerUseSwitch}>
        {query.surface === 'team' && <TeamSurface {...data} soul={query.soul} open={open} />}
        {query.surface === 'session' && <SessionSurface {...data} soul={query.soul} tab={query.tab} action={query.action} open={open} launcher={launcher} archiver={archiver} />}
        {query.surface === 'audit' && <AuditSurface {...data} soul={query.soul} />}
        {query.surface === 'customize' && <CustomizeSurface {...data} soul={query.soul} />}
        {query.surface === 'launch' && <LaunchSurface {...data} launcher={launcher} open={open} listTemplates={templateLister} />}
      </AppProviders>
    );
  }
  // The tray popup is a fixed 384×560 window (tauri.conf.json).
  return <>{mode === 'tray' ? <div style={{ width: 384, height: 560, margin: 16, outline: '1px solid #444' }}>{app}</div> : app}{dialog}</>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><AuditSourceContext.Provider value={audit}><SoulSourceContext.Provider value={soulSource}><EnvironmentSourceContext.Provider value={environmentSource}><Preview /></EnvironmentSourceContext.Provider></SoulSourceContext.Provider></AuditSourceContext.Provider></StrictMode>);

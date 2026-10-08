import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AppWindow, ArrowLeft, Cpu, ExternalLink, Info, LogIn, MousePointer2, OctagonX, Palette, Radio, ShieldCheck, X, Zap } from 'lucide-react';
import { computerUseSupported, runtimeMetrics, setSoulComms, soulComms, type ComputerUseSwitch, type RuntimeMetrics, type RuntimeObservation, type SoulColdWake, type SoulComms, type SoulMode, type SoulModel, type SoulPopulation } from '../bridge';
import {
  availabilityNote,
  roleAndHarness,
  displayName,
  parentDisplayName,
  soulKey,
  type CensusRow,
  type SoulNode,
} from '../model/census';
import type { ApprovalDecision, ChatEntry, Composer } from '../model/chat';
import { soulHarnessLabel } from '../model/launch';
import { dudleFor } from '../model/dudle';
import { useI18n, type Translate } from '../lib/i18n';
import { escapeStaysInside, tabStep } from '../lib/keys';
import type { LaunchApi } from '../useLaunch';
import { useSoulProfile } from '../useSoulProfile';
import { AuditLog } from './AuditLog';
import { Conversation } from './Conversation';
import { CustomizeDialog } from './CustomizeDialog';
import { EnvironmentSection } from './EnvironmentSection';
import { liveState, presenceText, SoulDudle } from './FleetList';
import { useStop, type Stopper } from './FloatingDudle';
import type { DudleState } from './Dudle';
import { LaunchForm } from './LaunchForm';
import { MemoryPanel } from './MemoryPanel';
import { ModelSelect } from './ModelField';
import { ActsAs, GitHubAppRow, useIdentityApps } from './IdentityApps';
import { useSandbox } from './Sandbox';
import { runsAsText, SandboxChip } from './SandboxChip';
import { SoulNotices, SoulSourceContext, useSoulMode, useSoulModel, useSoulPopulation } from './SoulNotices';
import { GeniusNotice, GuideDialog } from './GuideDialog';
import { isGuideSoul } from '../model/guide';
import { SurfaceOpenerContext } from '../surfaces/opener';
import { preferenceActions, usePreferences, windowChoiceOf, type WindowChoice } from '../state/preferences';
import { Select } from './Select';

/** The conversation with this soul, when chat is available (#17). */
export interface SoulChat {
  entries: readonly ChatEntry[];
  composer: Composer;
  onDraft: (draft: string) => void;
  onSend: () => void;
  /** Answers an approval request (#86); absent until agent-bot can. */
  onResolve?: (entryId: string, decision: ApprovalDecision) => void;
}

/** Launching souls (#18), with suggestions from the census. */
export interface LaunchProps {
  launcher: LaunchApi;
  accounts: readonly string[];
  harnesses: readonly string[];
  /** The viewer's default harness for new launches. */
  defaultHarness?: string | null;
}

export type SessionTab = 'chat' | 'tree' | 'memory' | 'audit' | 'details';
type Tab = SessionTab;

interface CompanionSessionProps {
  soul: CensusRow;
  forest: readonly SoulNode[];
  /** Full roster for the parent's name. */
  roster: readonly CensusRow[];
  paused?: boolean;
  chat?: SoulChat;
  launch?: LaunchProps;
  /** Opens another companion, from the delegation tree. */
  onOpen: (soul: CensusRow) => void;
  /** Leaves the session; Escape does the same. */
  onClose: () => void;
  /** The popup's back button; a desktop window has its own close button. */
  showBack?: boolean;
  /** The popup's pop-out (#264): the session, on its current tab, in its own window. Absent without native windows. */
  onPopOut?: (tab: SessionTab) => void;
  metricsRefresh?: number;
  /** The tab it opens on, when it has that tab (the floating Dudle's quick menu). */
  initialTab?: SessionTab;
  /** Agent IDs with a proposal waiting on the owner: the bouncing face, "Waiting for you". */
  awaiting?: ReadonlySet<string>;
  /** Agent IDs mid-turn (daemon status `busy`): the working face, "Working…". */
  busy?: ReadonlySet<string>;
  /** Agent IDs driving the screen (#122): while this soul is among them the header offers Stop. */
  computerUse?: ReadonlySet<string>;
  /** Halts this soul's turn (agent-bot `soul stop`); without one the header offers no Stop. */
  stopper?: Stopper;
}

/**
 * The session's Stop (#122): the perimeter's Stop for this one soul, in
 * the header while it drives the screen. The window's own Escape closes
 * the session, so here Stop is the button alone, with no Escape hold.
 */
export function SessionStop({ soul, computerUse, stopper }: { soul: CensusRow; computerUse?: ReadonlySet<string>; stopper?: Stopper }) {
  const { t } = useI18n();
  const driving = computerUse?.has(soul.agentId) ?? false;
  // Only this soul, so Stop never halts a teammate; empty once the daemon drops it, which settles "stopping".
  const targets = useMemo(() => new Set(driving ? [soul.agentId] : []), [driving, soul.agentId]);
  // Probed (an agent-bot run) only once a soul drives, not on every session opened.
  const stop = useStop(driving ? stopper : undefined, targets);
  if (!driving || !stop.offered) return null;
  const name = displayName(soul);
  return (
    <>
      <button type="button" onClick={() => { void stop.halt(); }} disabled={stop.phase.phase === 'stopping'}
        title={t('computerActive', { name })} aria-label={`${t('stop')}: ${t('computerActive', { name })}`}
        className="flex min-h-7 shrink-0 items-center gap-1 rounded-full bg-warning px-3 py-0.5 text-xs font-semibold text-warning-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70">
        <OctagonX className="size-3.5" aria-hidden /> {stop.phase.phase === 'stopping' ? t('stopping') : t('stop')}
      </button>
      {stop.phase.phase === 'failed' && (
        <p role="alert" className="m-0 basis-full truncate text-xs text-destructive">{t('stopFailed', { message: stop.phase.message })}</p>
      )}
    </>
  );
}

/**
 * One companion's session (R6): a header, then Chat, its team's delegation
 * tree, its memory (#268), its audit log, and the read-only details with
 * Launch, in the design's order. Without chat it opens on the details.
 */
export function CompanionSession({ soul, forest, roster, paused = false, chat, launch, onOpen, onClose, showBack = false, onPopOut, metricsRefresh = 0, initialTab, awaiting, busy, computerUse, stopper }: CompanionSessionProps) {
  const { t } = useI18n();
  const ids = useId();
  const back = useRef<HTMLButtonElement>(null);
  const tabs: Tab[] = chat ? ['chat', 'tree', 'memory', 'audit', 'details'] : ['tree', 'memory', 'audit', 'details'];
  const first: Tab = chat ? 'chat' : 'details';
  const [tab, setTab] = useState<Tab>(initialTab && tabs.includes(initialTab) ? initialTab : first);
  const active = tabs.includes(tab) ? tab : first;
  const name = displayName(soul);
  // As the design's `state={c.presence}`: waiting on you, working, else the census.
  const state = liveState(soul, awaiting, busy);
  useEffect(() => { if (showBack) back.current?.focus(); }, [showBack]);

  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      aria-label={`${name}, ${soul.agentId}`}
      onKeyDown={(e) => {
        // As the design: Escape in the composer, a field or an inner dialog stays there.
        if (e.key === 'Escape' && !escapeStaysInside(e.target, e.currentTarget)) onClose();
      }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2 md:px-8">
        {showBack && (
          <button ref={back} type="button" aria-label={t('back')} title={t('back')} onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
            <ArrowLeft className="size-4" aria-hidden />
          </button>
        )}
        <SoulDudle soul={soul} size={34} paused={paused} label={t('avatarFor', { name })} state={state} />
        <div className="min-w-[9rem] flex-1">
          <h2 className="m-0 truncate text-base font-semibold">{name}</h2>
          <p className="m-0 truncate text-xs text-muted-foreground">
            {roleAndHarness(soul)} · {presenceText(soul, state, t)}
          </p>
        </div>
      {/* Stop while this soul drives the screen (#122), then the design's segmented tabs at the header's right. */}
      <SessionStop soul={soul} computerUse={computerUse} stopper={stopper} />
      {showBack && <SandboxChip soul={soul} />}
      {showBack && <InfoButton soul={soul} state={state} inPopup />}
      {/* The pop-out (#264): no Lovable control for it; the ⓘ button's look. */}
      {onPopOut && (
        <button type="button" onClick={() => onPopOut(active)} aria-label={t('popOut')} title={t('popOut')}
          className="rounded p-1 text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring hover:text-foreground">
          <ExternalLink className="size-3.5" aria-hidden />
        </button>
      )}
      <div role="tablist" aria-label={name} className="ml-auto flex h-9 items-center gap-0.5 rounded-lg bg-muted p-1"
        onKeyDown={(e) => {
          // As Radix Tabs: Left / Right wrap, Home / End jump to the ends.
          const next = tabStep(e.key, tabs, active);
          if (!next) return;
          e.preventDefault();
          setTab(next);
          document.getElementById(`${ids}-tab-${next}`)?.focus();
        }}>
        {tabs.map((id) => (
          <button
            key={id}
            id={`${ids}-tab-${id}`}
            type="button"
            role="tab"
            aria-selected={active === id}
            aria-controls={`${ids}-panel`}
            tabIndex={active === id ? 0 : -1}
            onClick={() => setTab(id)}
            className={`rounded-md px-3 py-1 text-sm font-medium ring-offset-background outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${active === id
              ? 'bg-background text-foreground shadow' : 'text-muted-foreground'}`}
          >
            {t(`tab.${id}`)}
          </button>
        ))}
      </div>
      </div>
      <div id={`${ids}-panel`} role="tabpanel" aria-labelledby={`${ids}-tab-${active}`}
        className={`flex min-h-0 flex-1 flex-col ${active === 'chat' ? '' : 'overflow-y-auto overscroll-contain'}`}>
        {active === 'chat' && chat && (
          <ChatTab key={soulKey(soul)} soul={soul} chat={chat} paused={paused} refresh={metricsRefresh} />
        )}
        {active === 'tree' && <DelegationTree forest={forest} focus={soulKey(soul)} paused={paused} onOpen={onOpen} awaiting={awaiting} busy={busy} />}
        {active === 'memory' && <MemoryPanel soul={soul} refresh={metricsRefresh} />}
        {active === 'details' && <CompanionDetails soul={soul} roster={roster} launch={launch} metricsRefresh={metricsRefresh} awaiting={awaiting} busy={busy} />}
        {active === 'audit' && <AuditLog agentId={soul.agentId} roster={roster} />}
      </div>
    </section>
  );
}

/**
 * The chat tab: the soul's notices, then the conversation. As the design,
 * the composer is disabled while the companion is unavailable (left and
 * not woken by messages) or its harness sign-in has lapsed (the record
 * the sign-in notice reads). Genius's chat (#287) leads with the guide
 * banner, whose App guide opens here, so a pop-out window has it too;
 * focus returns to the banner's button when it closes. A companion is
 * taken for Genius by its display name, the template's: the package it
 * came from is not in the census, and reading its profile here would be
 * one agent-bot run per chat opened.
 */
function ChatTab({ soul, chat, paused, refresh }: { soul: CensusRow; chat: SoulChat; paused: boolean; refresh: number }) {
  const population = useSoulPopulation(soul.agentId, refresh);
  const signIn = population.record?.harnessAuth?.status;
  // A left companion the daemon still watches is asleep: a message wakes it.
  const gone = soul.presence === 'left' && !soul.daemonWatching;
  const blocked = gone || signIn === 'expired' || signIn === 'signed-out';
  const [guideOpen, setGuideOpen] = useState(false);
  const guideReturn = useRef<HTMLElement | null>(null);
  const name = displayName(soul);
  return (
    <>
      {isGuideSoul(name) && (
        <GeniusNotice name={name} onOpen={() => { guideReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setGuideOpen(true); }} />
      )}
      {guideOpen && <GuideDialog onClose={() => { setGuideOpen(false); guideReturn.current?.focus(); guideReturn.current = null; }} />}
      <SoulNotices soul={soul} refresh={refresh} population={population} />
      <Conversation name={displayName(soul)} entries={chat.entries} composer={chat.composer} onDraft={chat.onDraft} onSend={chat.onSend}
        dudle={dudleFor(soul)} paused={paused} onResolve={chat.onResolve} disabled={blocked} />
    </>
  );
}

function onOff(value: boolean | null | undefined, t: Translate): string {
  return value === true ? t('on') : value === false ? t('off') : t('unknown');
}

/**
 * Managed and agent-comms state (#71) for one soul. It comes from
 * agent-bot, which also decides whether it may change; this only shows it
 * and relays the toggle.
 */
export function useSoulComms(agentId: string, refresh = 0) {
  const [comms, setComms] = useState<SoulComms | null>(null);
  const [commsSaving, setCommsSaving] = useState(false);
  const [commsError, setCommsError] = useState<string | null>(null);
  // Every read and change takes a ticket; only the latest one, for the soul
  // still shown, may settle, so a consent dialog for one soul never
  // overwrites another's state. A refresh skips its read while a change is
  // in flight, so it never replaces that change's result with an older read.
  const commsTicket = useRef(0);
  const commsChanging = useRef(false);
  useEffect(() => {
    commsTicket.current += 1;
    commsChanging.current = false;
    setComms(null);
    setCommsError(null);
    setCommsSaving(false);
  }, [agentId]);
  useEffect(() => {
    if (commsChanging.current) return;
    const ticket = ++commsTicket.current;
    void soulComms(agentId).then((result) => { if (commsTicket.current === ticket) setComms(result); });
  }, [agentId, refresh]);
  const toggleComms = (on: boolean) => {
    const ticket = ++commsTicket.current;
    const latest = () => commsTicket.current === ticket;
    commsChanging.current = true;
    setCommsSaving(true);
    setCommsError(null);
    setSoulComms(agentId, on)
      .then((result) => { if (latest()) setComms(result); })
      .catch((error: unknown) => { if (latest()) setCommsError(error instanceof Error ? error.message : String(error)); })
      .finally(() => {
        if (!latest()) return;
        commsChanging.current = false;
        setCommsSaving(false);
      });
  };
  return { comms, saving: commsSaving, error: commsError, toggle: toggleComms };
}

/**
 * Whether the soul wakes on new messages (#122, agent-bot `soul
 * cold-wake`). Read when shown and on refresh; a change asks the owner
 * through agent-bot, and a refusal leaves the switch where it was. Tickets
 * work as in useSoulComms.
 */
export function useSoulColdWake(agentId: string, refresh = 0) {
  const source = useContext(SoulSourceContext);
  const [wake, setWake] = useState<SoulColdWake | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ticket = useRef(0);
  const changing = useRef(false);
  useEffect(() => {
    ticket.current += 1;
    changing.current = false;
    setWake(null);
    setError(null);
    setSaving(false);
  }, [agentId]);
  useEffect(() => {
    if (changing.current) return;
    const mine = ++ticket.current;
    void source.coldWake(agentId).then((result) => { if (ticket.current === mine) setWake(result); }, () => {});
  }, [agentId, refresh, source]);
  const toggle = (on: boolean) => {
    const mine = ++ticket.current;
    const latest = () => ticket.current === mine;
    changing.current = true;
    setSaving(true);
    setError(null);
    source.setColdWake(agentId, on)
      .then((result) => { if (latest()) setWake(result); })
      .catch((e: unknown) => { if (latest()) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => {
        if (!latest()) return;
        changing.current = false;
        setSaving(false);
      });
  };
  return { wake, saving, error, toggle };
}

export type SignInState = 'ok' | 'signed-out' | 'expired';

/**
 * The soul's harness sign-in: the failure agent-bot's census recorded when
 * there is one, else `harness auth status H --soul ID`, read once per soul
 * (not polled). Null while unknown.
 */
export function useHarnessSignIn(soul: CensusRow, record: SoulPopulation | null, loaded: boolean): SignInState | null {
  const source = useContext(SoulSourceContext);
  const [read, setRead] = useState<{ agentId: string; loggedIn: boolean | null } | null>(null);
  const harness = soul.harness;
  const ask = loaded && !record?.harnessAuth && Boolean(harness);
  useEffect(() => {
    if (!ask || !harness) return;
    let active = true;
    void source.signedIn(harness, soul.agentId).then(
      (loggedIn) => { if (active) setRead({ agentId: soul.agentId, loggedIn }); },
      () => { if (active) setRead({ agentId: soul.agentId, loggedIn: null }); },
    );
    return () => { active = false; };
  }, [ask, harness, soul.agentId, source]);
  if (record?.harnessAuth) return record.harnessAuth.status;
  if (read?.agentId !== soul.agentId || read.loggedIn === null) return null;
  return read.loggedIn ? 'ok' : 'signed-out';
}

const SIGN_IN_TEXT = { ok: 'login.ok', 'signed-out': 'login.signedOut', expired: 'login.expired' } as const;

/** The read-only fields, with Launch… when launching is available. */
/**
 * The owner's per-soul computer-use switch (agent-bot `soul computer-use`,
 * agent-bot-identity #482) for the Details rows. App provides agent-bot's in
 * the app; the preview and tests provide their own; none hides the rows.
 */
export const ComputerUseContext = createContext<ComputerUseSwitch | null>(null);

/**
 * Whether the soul may use the computer (#122): read from its census record
 * (`computerUse`) while the bundled agent-bot has `soul computer-use`
 * (probed once); a change asks the owner through agent-bot, then the record
 * is re-read. A refusal leaves the switch where it was. Null `on` hides the
 * row (an older bundle, or a record without the field).
 */
export function useSoulComputerUse(agentId: string, population: { record: SoulPopulation | null; reload: () => void }) {
  const source = useContext(ComputerUseContext);
  const [supported, setSupported] = useState(false);
  const [answer, setAnswer] = useState<{ basis: SoulPopulation | null; agentId: string; on: boolean } | null>(null);
  const [stopped, setStopped] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ticket = useRef(0);
  useEffect(() => {
    setSupported(false);
    if (!source) return;
    let current = true;
    computerUseSupported(source).then((ok) => { if (current) setSupported(ok); }, () => {});
    return () => { current = false; };
  }, [source]);
  useEffect(() => {
    ticket.current += 1;
    setAnswer(null);
    setStopped(false);
    setSaving(false);
    setError(null);
  }, [agentId]);
  const { record, reload } = population;
  // agent-bot's answer to a change holds until the record is read again.
  const held = answer && answer.agentId === agentId && answer.basis === record ? answer.on : undefined;
  const read = record?.agentId === agentId ? record.computerUse : undefined;
  const on = held ?? read;
  const change = (next: boolean) => {
    if (!source) return;
    const mine = ++ticket.current;
    const latest = () => ticket.current === mine;
    const basis = record;
    setSaving(true);
    setStopped(false);
    setError(null);
    source.set(agentId, next)
      .then((result) => {
        if (!latest()) return;
        setAnswer({ basis, agentId, on: result.computerUse });
        setStopped(result.stopped === true);
      })
      .catch((e: unknown) => {
        if (!latest()) return;
        const failure = e as { code?: unknown; message?: unknown };
        if (failure?.code === 'soul-computer-use-unsupported') setSupported(false);
        else setError(typeof failure?.message === 'string' ? failure.message : String(e));
      })
      .finally(() => {
        if (!latest()) return;
        setSaving(false);
        reload();
      });
  };
  return { on: supported && typeof on === 'boolean' ? on : null, stopped, saving, error, change };
}

export function CompanionDetails({ soul, roster = [], launch, metricsRefresh = 0, awaiting, busy }: {
  soul: CensusRow; roster?: readonly CensusRow[]; launch?: LaunchProps; metricsRefresh?: number;
  /** Live state for the Presence row, as the session header's: "Waiting for you" / "Working…". */
  awaiting?: ReadonlySet<string>; busy?: ReadonlySet<string>;
}) {
  const { t, lang } = useI18n();
  const [launching, setLaunching] = useState(false);
  const [metrics, setMetrics] = useState<RuntimeMetrics>({ unavailable: true });
  useEffect(() => {
    let active = true;
    setMetrics({ unavailable: true });
    void runtimeMetrics().then((result) => { if (active) setMetrics(result); });
    return () => { active = false; };
  }, [soul.agentId, metricsRefresh]);
  // As the design's tab, these read as text; their controls live in the ⓘ sheet.
  const { comms } = useSoulComms(soul.agentId, metricsRefresh);
  const { wake } = useSoulColdWake(soul.agentId, metricsRefresh);
  const populationRead = useSoulPopulation(soul.agentId, metricsRefresh);
  const { record: population, loaded: populationLoaded } = populationRead;
  const signIn = useHarnessSignIn(soul, population, populationLoaded);
  const execution = useSoulMode(soul.agentId, metricsRefresh);
  const computer = useSoulComputerUse(soul.agentId, populationRead);
  const chosenModel = useSoulModel(soul.agentId, metricsRefresh);
  const sandbox = useSandbox();
  const { reload: reloadSandbox } = sandbox;
  useEffect(() => { reloadSandbox(); }, [reloadSandbox, soul.agentId, metricsRefresh]);
  const sandboxed = sandbox.soul(soul.agentId);
  const identities = useIdentityApps();
  const { reload: reloadIdentities } = identities;
  useEffect(() => { reloadIdentities(); }, [reloadIdentities, soul.agentId, metricsRefresh]);
  const snapshot = 'unavailable' in metrics ? null : metrics;
  const observations = snapshot?.souls[soul.agentId]?.observations ?? [];
  const errors = snapshot?.errors.filter((error) => error.agentId === soul.agentId) ?? [];
  const metricValue = (observation: RuntimeObservation): ReactNode => {
    const value = observation.metric === 'context_used_tokens' && typeof observation.value === 'number'
      ? t('metrics.tokens', { count: observation.value.toLocaleString(lang) })
      : observation.value === 'unknown' ? t('unknown') : String(observation.value);
    const elapsed = (Date.now() - Date.parse(observation.observedAt)) / 1000;
    const unit = elapsed < 60 ? 'second' : elapsed < 3600 ? 'minute' : elapsed < 86400 ? 'hour' : 'day';
    const seconds = { second: 1, minute: 60, hour: 3600, day: 86400 }[unit];
    const age = Number.isFinite(elapsed)
      ? new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }).format(-Math.floor(Math.max(0, elapsed) / seconds), unit)
      : null;
    return <>{value}{age && <span className="ml-2 text-[11px] text-muted-foreground">{t('metrics.asOf', { source: observation.source, age })}</span>}</>;
  };
  const note = availabilityNote(soul);
  const parentName = parentDisplayName(soul, roster);
  let parent: ReactNode = '—';
  if (soul.parent !== null) {
    parent = parentName ? (
      <>
        {parentName}
        <span className="block text-[11px] text-muted-foreground">{soul.parent}</span>
      </>
    ) : (
      soul.parent
    );
  }

  const rows: [string, ReactNode][] = [
    [t('field.agentId'), <span className="selectable">{soul.agentId}</span>],
    [t('field.account'), soul.account],
    [t('field.harness'), soulHarnessLabel(soul)],
    // As the design: the live presence (awaiting / working), else the census.
    [t('field.presence'), presenceText(soul, liveState(soul, awaiting, busy), t)],
    [t('field.parent'), parent],
    [t('field.unacked'), String(soul.unacked)],
    [t('field.lastWake'), soul.lastWake ?? t('none')],
  ];
  // The design's Sandbox row (#66): agent-bot's resolution for this soul and
  // the account it runs as; the Account row above stays the census's.
  if (sandboxed) {
    rows.push([t('details.hardened'), (
      <>
        {sandboxed.sandboxed ? t('sandbox.on') : t('sandbox.off')}
        <span className="block font-sans text-[11px] text-muted-foreground">{runsAsText(sandboxed, t)}</span>
      </>
    )]);
  }
  // Principal-client fields that R1's census did not carry; shown only
  // when the bridge supplies them.
  if (soul.verification !== undefined) rows.push([t('field.verification'), soul.verification ?? t('none')]);
  if (soul.hardened !== undefined) rows.push([t('field.hardened'), onOff(soul.hardened, t)]);
  if (soul.daemonWatching !== undefined) rows.push([t('field.daemonWatching'), onOff(soul.daemonWatching, t)]);
  const model = observations.find((observation) => observation.metric === 'model_reported');
  const context = observations.find((observation) => observation.metric === 'context_used_tokens');
  if (model) rows.push([t('field.model'), metricValue(model)]);
  if (context) rows.push([t('field.context'), metricValue(context)]);
  // The owner's model choice (#128), beside what the soul last reported;
  // agent-bot applies it on the next turn. Absent while agent-bot cannot say.
  // As the design's read-only tab, this row and the four below are text; the
  // ⓘ sheet beside the tabs (both modes) holds their controls.
  if (chosenModel.setting) rows.push([t('model.choice'), chosenModel.setting.model ?? t('model.default')]);
  // As the design: Managed / Unmanaged only; whether it wakes is the Wake row.
  if (comms) rows.push([t('field.comms'), comms.managed ? t('comms.managed') : t('comms.unmanaged')]);
  // Details rows from the Lovable design (#122), each shown once agent-bot can say.
  if (wake) rows.push([t('details.wake'), onOff(wake.on, t)]);
  if (execution.mode) rows.push([t('mode.label'), execution.mode === 'autopilot' ? t('mode.autopilot') : t('mode.safe')]);
  // Computer use (#122, no Lovable screen): beside Execution mode.
  if (computer.on !== null) rows.push([t('computerUse.label'), onOff(computer.on, t)]);
  if (signIn) {
    rows.push([t('login.status'), (
      <span className={signIn === 'ok' ? 'text-success' : 'text-destructive'}>{t(SIGN_IN_TEXT[signIn])}</span>
    )]);
  }
  // The GitHub App row (#67, #122): the App this companion acts as, from
  // agent-bot's managed Apps; the census's App name while those are hidden.
  if (identities.apps) {
    rows.push([t('identity.actsAs'), <ActsAs agentId={soul.agentId} name={displayName(soul)} />]);
  } else if (population) {
    rows.push([t('keyd.title'), population.appSlug ? t('keyd.connected', { app: population.appSlug }) : t('keyd.none')]);
  }

  // As the design's Details tab: a bordered list, sans labels and mono values.
  return (
    <div className="grid gap-3 p-4 md:px-8">
      {note && <p className="m-0 text-sm text-muted-foreground">{note}</p>}
      <dl className="m-0 divide-y divide-border rounded-md border border-border text-sm">
        {rows.map(([term, value]) => (
          <div key={term} className="flex gap-3 px-3 py-2">
            <dt className="w-40 shrink-0 text-muted-foreground">{term}</dt>
            <dd className="m-0 min-w-0 flex-1 font-mono text-xs leading-5 [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
      {errors.map((error, index) => (
        <p key={index} className="m-0 text-[11px] text-muted-foreground">{t('metrics.collectorError', { source: error.source, message: error.message })}</p>
      ))}
      {/* The soul's environment (#268): what agent-bot's descriptor says, in the same scroll pane. */}
      <EnvironmentSection soul={soul} refresh={metricsRefresh} />
      {launch && launching && <LaunchForm {...launch} soul={soul} initialComms={comms?.comms} roster={roster} />}
      {launch && !launching && (
        <div className="flex justify-end">
          <button type="button" onClick={() => setLaunching(true)}
            className="min-h-8 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90">
            {t('launch')}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The design's Agent comms row (Lovable `CommsRow`): title, hint (or why
 * it is locked), Managed / Unmanaged in mono, and the switch. Absent while
 * agent-bot cannot say.
 */
export function CommsRow({ soul, refresh = 0 }: { soul: CensusRow; refresh?: number }) {
  const { t } = useI18n();
  const { comms, saving, error, toggle } = useSoulComms(soul.agentId, refresh);
  if (!comms) return null;
  return (
    <label className="flex items-start gap-3 p-3">
      <Radio className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
      <span className="flex-1">
        <span className="block text-sm font-medium">{t('field.comms')}</span>
        <span className="block text-xs text-muted-foreground">{comms.running ? t('comms.stopFirst') : t('comms.hint')}</span>
        <span className="block font-mono text-[11px] text-muted-foreground">{comms.managed ? t('comms.managed') : t('comms.unmanaged')}</span>
        {saving && <span className="block text-[11px] text-muted-foreground" role="status">{t('comms.saving')}</span>}
        {error && <span className="block text-[11px] text-destructive" role="alert">{t('comms.failed', { message: error })}</span>}
      </span>
      <input type="checkbox" role="switch" checked={comms.comms} disabled={comms.running || saving}
        aria-label={t('comms.toggle', { name: displayName(soul) })} onChange={(e) => toggle(e.target.checked)} />
    </label>
  );
}

/**
 * The design's wake switch (Lovable `DetailsButton`): title, hint (or why
 * it is locked) and the switch. Absent while agent-bot cannot say.
 */
export function WakeRow({ soul, refresh = 0 }: { soul: CensusRow; refresh?: number }) {
  const { t } = useI18n();
  const { wake, saving, error, toggle } = useSoulColdWake(soul.agentId, refresh);
  const { comms } = useSoulComms(soul.agentId, refresh);
  if (!wake) return null;
  const locked = comms?.running === true;
  const name = displayName(soul);
  return (
    <label className="flex items-start gap-3 p-3">
      <span className="flex-1">
        <span className="block text-sm font-medium">{t('details.wake')}</span>
        <span className="block text-xs text-muted-foreground">{locked ? t('comms.stopFirst') : t('details.wakeHint', { name })}</span>
        {saving && <span className="block text-[11px] text-muted-foreground" role="status">{t('comms.saving')}</span>}
        {error && <span className="block text-[11px] text-destructive" role="alert">{t('details.wakeFailed', { message: error })}</span>}
      </span>
      <input type="checkbox" role="switch" checked={wake.on} disabled={locked || saving}
        aria-label={t('details.wakeToggle', { name })} onChange={(e) => toggle(e.target.checked)} />
    </label>
  );
}

/**
 * The design's execution mode pill (Lovable `GeniusBarItem`): Safe Mode with
 * a shield, Auto-Pilot with a bolt in the warning colour, and the switch,
 * warning-coloured when on.
 */
function ModeSwitch({ soul, mode, saving, onChange }:
  { soul: CensusRow; mode: SoulMode; saving: boolean; onChange: (mode: SoulMode) => void }) {
  const { t } = useI18n();
  const auto = mode === 'autopilot';
  return (
    <label className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-sans text-xs ${auto ? 'border-warning text-warning' : 'border-border'}`}>
      {auto ? <Zap className="size-3" aria-hidden /> : <ShieldCheck className="size-3 text-success" aria-hidden />}
      <span>{auto ? t('mode.autopilot') : t('mode.safe')}</span>
      <input type="checkbox" role="switch" checked={auto} disabled={saving}
        aria-label={t('mode.toggle', { name: displayName(soul) })}
        style={auto ? { background: 'var(--warning)' } : undefined}
        onChange={(e) => onChange(e.target.checked ? 'autopilot' : 'safe')} />
    </label>
  );
}

/**
 * The design's Execution mode row in the ⓘ sheet. Absent while agent-bot
 * cannot say.
 */
export function ModeRow({ soul, refresh = 0 }: { soul: CensusRow; refresh?: number }) {
  const { t } = useI18n();
  const { mode, saving, error, change } = useSoulMode(soul.agentId, refresh);
  if (!mode) return null;
  return (
    <div className="flex items-start gap-3 p-3">
      {mode === 'autopilot'
        ? <Zap className="mt-0.5 size-4 text-warning" aria-hidden />
        : <ShieldCheck className="mt-0.5 size-4 text-muted-foreground" aria-hidden />}
      <span className="flex-1">
        <span className="block text-sm font-medium">{t('mode.label')}</span>
        {mode === 'safe' && <span className="block text-xs text-muted-foreground">{t('mode.safeHint')}</span>}
        {saving && <span className="block text-[11px] text-muted-foreground" role="status">{t('comms.saving')}</span>}
        {error && <span className="block text-[11px] text-destructive" role="alert">{t('mode.failed', { message: error })}</span>}
      </span>
      <ModeSwitch soul={soul} mode={mode} saving={saving} onChange={change} />
    </div>
  );
}

/** The computer-use switch, as the execution mode pill: icon, state and switch. */
function ComputerUseToggle({ soul, on, saving, onChange }:
  { soul: CensusRow; on: boolean; saving: boolean; onChange: (on: boolean) => void }) {
  const { t } = useI18n();
  return (
    <label className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 font-sans text-xs">
      <MousePointer2 className={`size-3 ${on ? 'text-foreground' : 'text-muted-foreground'}`} aria-hidden />
      <span>{on ? t('computerUse.on') : t('computerUse.off')}</span>
      <input type="checkbox" role="switch" checked={on} disabled={saving}
        aria-label={t('computerUse.toggle', { name: displayName(soul) })}
        onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/**
 * The computer-use row in the ⓘ sheet, laid out as the Execution mode row.
 * Absent while agent-bot cannot say.
 */
export function ComputerUseRow({ soul, refresh = 0 }: { soul: CensusRow; refresh?: number }) {
  const { t } = useI18n();
  const population = useSoulPopulation(soul.agentId, refresh);
  const { on, stopped, saving, error, change } = useSoulComputerUse(soul.agentId, population);
  if (on === null) return null;
  return (
    <div className="flex items-start gap-3 p-3">
      <MousePointer2 className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
      <span className="flex-1">
        <span className="block text-sm font-medium">{t('computerUse.label')}</span>
        {!on && <span className="block text-xs text-muted-foreground">{t('computerUse.hint')}</span>}
        {stopped && <span className="block text-[11px] text-muted-foreground" role="status">{t('computerUse.stopped')}</span>}
        {saving && <span className="block text-[11px] text-muted-foreground" role="status">{t('comms.saving')}</span>}
        {error && <span className="block text-[11px] text-destructive" role="alert">{t('computerUse.failed', { message: error })}</span>}
      </span>
      <ComputerUseToggle soul={soul} on={on} saving={saving} onChange={change} />
    </div>
  );
}

const modelField = 'h-8 w-full rounded-md border border-input bg-transparent px-2 font-sans text-xs text-foreground';

/**
 * The model select (#128) with its hints, saving line and refusal, as the
 * Details row and the ⓘ sheet row draw it. No Lovable design yet: it takes
 * the launch form's Harness select and the mode row's lines.
 */
function ModelControl({ soul, setting, saving, error, onChange }:
  { soul: CensusRow; setting: SoulModel; saving: boolean; error: string | null; onChange: (model: string | null) => void }) {
  const { t } = useI18n();
  const name = displayName(soul);
  return (
    <>
      <ModelSelect value={setting.model} choices={setting.available ?? []} label={t('model.choose', { name })}
        disabled={saving} commit="submit" onChange={onChange} className={modelField} />
      <span className="block font-sans text-[11px] text-muted-foreground">{t('model.hint', { name })}</span>
      {setting.available === null && <span className="block font-sans text-[11px] text-muted-foreground">{t('model.unlisted')}</span>}
      {saving && <span className="block text-[11px] text-muted-foreground" role="status">{t('comms.saving')}</span>}
      {error && <span className="block text-[11px] text-destructive" role="alert">{t('model.failed', { message: error })}</span>}
    </>
  );
}

/**
 * The model row in the ⓘ sheet (#128), laid out as the Execution mode row.
 * Absent while agent-bot cannot say.
 */
export function ModelRow({ soul, refresh = 0 }: { soul: CensusRow; refresh?: number }) {
  const { t } = useI18n();
  const { setting, saving, error, change } = useSoulModel(soul.agentId, refresh);
  if (!setting) return null;
  return (
    <div className="flex items-start gap-3 p-3">
      <Cpu className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
      <span className="grid min-w-0 flex-1 gap-1">
        <span className="block text-sm font-medium">{t('model.label')}</span>
        <ModelControl soul={soul} setting={setting} saving={saving} error={error} onChange={change} />
      </span>
    </div>
  );
}

/**
 * The design's harness sign-in and GitHub App rows. The App row shows the
 * key and carries Rotate key / Connect GitHub App once agent-bot's managed
 * Apps are readable (`GitHubAppRow`).
 */
export function SoulFactRows({ soul, refresh = 0 }: { soul: CensusRow; refresh?: number }) {
  const { t } = useI18n();
  const { record, loaded } = useSoulPopulation(soul.agentId, refresh);
  const signIn = useHarnessSignIn(soul, record, loaded);
  return (
    <>
      {signIn && (
        <div className="flex items-center gap-3 p-3">
          <LogIn className="size-4 text-muted-foreground" aria-hidden />
          <h3 className="m-0 flex-1 text-sm">{t('login.status')} · {soulHarnessLabel(soul)}</h3>
          <span className={`text-xs ${signIn === 'ok' ? 'text-success' : 'text-destructive'}`}>{t(SIGN_IN_TEXT[signIn])}</span>
        </div>
      )}
      {record && <GitHubAppRow agentId={soul.agentId} name={displayName(soul)} appSlug={record.appSlug} />}
    </>
  );
}

/**
 * Where this companion opens from the GeniusBar popup (#264): inside it, in
 * its own window, or as the app's "Open conversations in their own window"
 * says (the default). A per-viewer preference, kept with the others; no
 * Lovable design, so it takes the model row's layout and select.
 */
export function WindowRow({ soul }: { soul: CensusRow }) {
  const { t } = useI18n();
  const prefs = usePreferences();
  const key = soulKey(soul);
  const choice = windowChoiceOf(prefs, key);
  const app = prefs.ownWindows ? t('window.own') : t('window.popup');
  return (
    <div className="flex items-start gap-3 p-3">
      <AppWindow className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
      <span className="grid min-w-0 flex-1 gap-1">
        <label className="grid gap-1">
          <span className="block text-sm font-medium">{t('window.label')}</span>
          <Select wrapperClassName="w-full" value={choice} className="h-8 pl-2 font-sans text-xs"
            aria-label={t('window.labelFor', { name: displayName(soul) })}
            onChange={(e) => preferenceActions.setWindowFor(key, e.target.value as WindowChoice)}>
            <option value="inherit">{t('window.inherit', { value: app })}</option>
            <option value="popup">{t('window.popup')}</option>
            <option value="window">{t('window.own')}</option>
          </Select>
        </label>
        <span className="block text-xs text-muted-foreground">{t('window.hint')}</span>
      </span>
    </div>
  );
}

/**
 * ⓘ and the Details sheet (Lovable 19.29.22): the soul's actionable rows.
 * Wake on new messages, Agent comms, execution mode, computer use, model
 * (#128), harness sign-in and the GitHub App (key, Rotate / Connect), each once
 * agent-bot reports it; then Customize… (#64), once agent-bot answers
 * `soul profile` for the soul (asked each time the sheet opens).
 */
export function InfoButton({ soul, state, inPopup = false }: {
  soul: CensusRow;
  /** The live face for Customize…'s title Dudle (the design's `state={c.presence}`). */
  state?: DudleState;
  /**
   * The tray popup's own session (#264): Customize… opens its window only
   * when "Open conversations in their own window" is on, else the dialog
   * here; and the sheet offers where this companion opens.
   */
  inPopup?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const close = useRef<HTMLButtonElement>(null);
  const info = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => { if (open) close.current?.focus(); }, [open]);
  const { supported: customizable } = useSoulProfile(soul.agentId, open);
  const opener = useContext(SurfaceOpenerContext);
  const { ownWindows } = usePreferences();
  const openSurface = inPopup && !ownWindows ? null : opener;
  const name = displayName(soul);
  return (
    <>
      {customizing && <CustomizeDialog soul={soul} state={state} onClose={() => { setCustomizing(false); info.current?.focus(); }} />}
      <button ref={info} type="button" onClick={() => setOpen(true)} aria-label={t('details.title')} title={t('details.title')} aria-haspopup="dialog"
        className="rounded p-1 text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring hover:text-foreground">
        <Info className="size-3.5" aria-hidden />
      </button>
      {/* Portalled to the body: the companion window's transform would otherwise
          contain the fixed overlay, and a React pointerdown bubbling from the
          sheet would start a drag in the title bar that holds this button. */}
      {open && createPortal(
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
          onPointerDown={(e) => e.stopPropagation()}>
          <section role="dialog" aria-modal="true" aria-labelledby={titleId}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }}
            className="relative grid w-full max-w-md gap-4 rounded-lg border border-border bg-background p-6 shadow-lg">
            <button ref={close} type="button" onClick={() => setOpen(false)} aria-label={t('close')}
              className="absolute top-4 right-4 rounded-sm text-foreground opacity-70 outline-none hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring">
              <X className="size-4" aria-hidden />
            </button>
            <div className="grid gap-1.5 pr-6">
              <h2 id={titleId} className="m-0 text-lg leading-none font-semibold tracking-tight">{t('details.title')} · {name}</h2>
              <p className="m-0 text-sm text-muted-foreground">{roleAndHarness(soul, soulHarnessLabel)}</p>
            </div>
            <div className="divide-y divide-border rounded-md border border-border empty:hidden">
              <WakeRow soul={soul} />
              <CommsRow soul={soul} />
              <ModeRow soul={soul} />
              <ComputerUseRow soul={soul} />
              <ModelRow soul={soul} />
              <SoulFactRows soul={soul} />
              {(inPopup || opener) && <WindowRow soul={soul} />}
            </div>
            {customizable && (
              <div className="flex justify-end">
                <button type="button" aria-haspopup="dialog" onClick={() => {
                  setOpen(false);
                  // In the app Customize is its own window (#223); without one, the dialog here.
                  if (openSurface) openSurface({ surface: 'customize', soul: soulKey(soul) }).catch(() => setCustomizing(true));
                  else setCustomizing(true);
                }}
                  className="inline-flex min-h-8 items-center gap-2 rounded-md border border-border px-3 text-sm font-medium hover:bg-accent">
                  <Palette className="size-3.5" aria-hidden />
                  {t('edit.title')}
                </button>
              </div>
            )}
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}

/** The whole fleet as nested delegation (R6), the focused companion highlighted. */
export function DelegationTree({ forest, focus, paused, onOpen, awaiting, busy }:
  { forest: readonly SoulNode[]; focus: string; paused: boolean; onOpen: (soul: CensusRow) => void;
    awaiting?: ReadonlySet<string>; busy?: ReadonlySet<string> }) {
  const { t } = useI18n();
  if (forest.length === 0) return null;
  const node = (n: SoulNode): ReactNode => {
    const key = soulKey(n.soul);
    const state = liveState(n.soul, awaiting, busy);
    return (
      <li key={key}>
        <button
          type="button"
          aria-current={key === focus ? 'true' : undefined}
          onClick={() => onOpen(n.soul)}
          className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm ${key === focus
            ? 'border-primary bg-primary/10' : 'border-border bg-card hover:bg-accent'}`}
        >
          <SoulDudle soul={n.soul} size={22} paused={paused} state={state} />
          <span className="font-medium text-foreground">{displayName(n.soul)}</span>
          <span className="text-xs text-muted-foreground">{presenceText(n.soul, state, t)}</span>
        </button>
        {n.children.length > 0 && (
          <ul className="mt-2 ml-5 grid list-none gap-2 border-l border-border pl-5">{n.children.map(node)}</ul>
        )}
      </li>
    );
  };
  return <ul className="m-0 grid list-none gap-3 p-6" aria-label={t('tab.tree')}>{forest.map(node)}</ul>;
}

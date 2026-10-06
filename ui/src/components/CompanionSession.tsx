import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlarmClock, ArrowLeft, Cpu, Github, Info, LogIn, MousePointer2, Radio, ShieldCheck, X, Zap } from 'lucide-react';
import { computerUseSupported, runtimeMetrics, setSoulComms, soulComms, type ComputerUseSwitch, type RuntimeMetrics, type RuntimeObservation, type SoulColdWake, type SoulComms, type SoulMode, type SoulModel, type SoulPopulation } from '../bridge';
import {
  availabilityNote,
  displayHarness,
  displayName,
  parentDisplayName,
  soulKey,
  type CensusRow,
  type SoulNode,
} from '../model/census';
import type { ApprovalDecision, ChatEntry, Composer } from '../model/chat';
import { deriveDudle } from '../model/dudle';
import { teamNodeOf } from '../model/fleet';
import { useI18n, type Translate } from '../lib/i18n';
import type { LaunchApi } from '../useLaunch';
import { AuditLog } from './AuditLog';
import { Conversation } from './Conversation';
import { SoulDudle } from './FleetList';
import { LaunchForm } from './LaunchForm';
import { ModelSelect } from './ModelField';
import { SoulNotices, SoulSourceContext, useSoulMode, useSoulModel, useSoulPopulation } from './SoulNotices';

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

export type SessionTab = 'chat' | 'tree' | 'details' | 'audit';
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
  metricsRefresh?: number;
  /** The tab it opens on, when it has that tab (the floating Dudle's quick menu). */
  initialTab?: SessionTab;
}

/**
 * One companion's session (R6): a header, then Chat, its team's delegation
 * tree, and the read-only details with Launch. Without chat it opens on
 * the details.
 */
export function CompanionSession({ soul, forest, roster, paused = false, chat, launch, onOpen, onClose, showBack = false, metricsRefresh = 0, initialTab }: CompanionSessionProps) {
  const { t } = useI18n();
  const ids = useId();
  const back = useRef<HTMLButtonElement>(null);
  const tabs: Tab[] = chat ? ['chat', 'tree', 'details', 'audit'] : ['details', 'tree', 'audit'];
  const [tab, setTab] = useState<Tab>(initialTab && tabs.includes(initialTab) ? initialTab : tabs[0]);
  const active = tabs.includes(tab) ? tab : tabs[0];
  const name = displayName(soul);
  useEffect(() => { if (showBack) back.current?.focus(); }, [showBack]);

  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      aria-label={`${name}, ${soul.agentId}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2">
        {showBack && (
          <button ref={back} type="button" aria-label={t('back')} title={t('back')} onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
            <ArrowLeft className="size-4" aria-hidden />
          </button>
        )}
        <SoulDudle soul={soul} size={34} paused={paused} label={t('avatarFor', { name })} />
        <div className="min-w-[9rem] flex-1">
          <h2 className="m-0 truncate text-base font-semibold">{name}</h2>
          <p className="m-0 truncate text-xs text-muted-foreground">
            {displayHarness(soul)} · {t(`presence.${soul.presence}`)}
          </p>
        </div>
      {/* The design's segmented tabs, at the header's right. */}
      {showBack && <InfoButton soul={soul} />}
      <div role="tablist" aria-label={name} className="ml-auto flex gap-0.5 rounded-lg bg-muted p-1"
        onKeyDown={(e) => {
          const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
          if (!step) return;
          const next = tabs[(tabs.indexOf(active) + step + tabs.length) % tabs.length];
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
            className={`rounded-md px-2.5 py-1 text-xs font-medium ${active === id
              ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {t(`tab.${id}`)}
          </button>
        ))}
      </div>
      </div>
      <div id={`${ids}-panel`} role="tabpanel" aria-labelledby={`${ids}-tab-${active}`}
        className={`flex min-h-0 flex-1 flex-col ${active === 'chat' ? '' : 'overflow-y-auto'}`}>
        {active === 'chat' && chat && (
          <>
            <SoulNotices key={soulKey(soul)} soul={soul} refresh={metricsRefresh} />
            <Conversation name={name} entries={chat.entries} composer={chat.composer} onDraft={chat.onDraft} onSend={chat.onSend}
              dudle={deriveDudle(soul.agentId)} paused={paused} onResolve={chat.onResolve} />
          </>
        )}
        {active === 'tree' && <DelegationTree forest={forest} focus={soulKey(soul)} paused={paused} onOpen={onOpen} />}
        {active === 'details' && <CompanionDetails soul={soul} roster={roster} launch={launch} metricsRefresh={metricsRefresh} />}
        {active === 'audit' && <AuditLog agentId={soul.agentId} roster={roster} />}
      </div>
    </section>
  );
}

function yesNo(value: boolean | null | undefined, t: Translate): string {
  return value === true ? t('yes') : value === false ? t('no') : t('unknown');
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

export function CompanionDetails({ soul, roster = [], launch, metricsRefresh = 0 }: { soul: CensusRow; roster?: readonly CensusRow[]; launch?: LaunchProps; metricsRefresh?: number }) {
  const { t, lang } = useI18n();
  const [launching, setLaunching] = useState(false);
  const [metrics, setMetrics] = useState<RuntimeMetrics>({ unavailable: true });
  useEffect(() => {
    let active = true;
    setMetrics({ unavailable: true });
    void runtimeMetrics().then((result) => { if (active) setMetrics(result); });
    return () => { active = false; };
  }, [soul.agentId, metricsRefresh]);
  const { comms, saving: commsSaving, error: commsError, toggle: toggleComms } = useSoulComms(soul.agentId, metricsRefresh);
  const { wake, saving: wakeSaving, error: wakeError, toggle: toggleWake } = useSoulColdWake(soul.agentId, metricsRefresh);
  const populationRead = useSoulPopulation(soul.agentId, metricsRefresh);
  const { record: population, loaded: populationLoaded } = populationRead;
  const signIn = useHarnessSignIn(soul, population, populationLoaded);
  const execution = useSoulMode(soul.agentId, metricsRefresh);
  const computer = useSoulComputerUse(soul.agentId, populationRead);
  const chosenModel = useSoulModel(soul.agentId, metricsRefresh);
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
  let parent: ReactNode = t('none');
  if (soul.parent !== null) {
    parent = parentName ? (
      <>
        {parentName}
        <span className="muted small block font-mono">{soul.parent}</span>
      </>
    ) : (
      soul.parent
    );
  }

  const rows: [string, ReactNode][] = [
    [t('field.agentId'), <span className="selectable">{soul.agentId}</span>],
    [t('field.account'), soul.account],
    [t('field.harness'), displayHarness(soul)],
    [t('field.presence'), soul.presence],
    [t('field.parent'), parent],
    [t('field.unacked'), String(soul.unacked)],
    [t('field.lastWake'), soul.lastWake ?? t('none')],
  ];
  // Principal-client fields that R1's census did not carry; shown only
  // when the bridge supplies them.
  if (soul.verification !== undefined) rows.push([t('field.verification'), soul.verification ?? t('none')]);
  if (soul.hardened !== undefined) rows.push([t('field.hardened'), yesNo(soul.hardened, t)]);
  if (soul.daemonWatching !== undefined) rows.push([t('field.daemonWatching'), yesNo(soul.daemonWatching, t)]);
  const model = observations.find((observation) => observation.metric === 'model_reported');
  const context = observations.find((observation) => observation.metric === 'context_used_tokens');
  if (model) rows.push([t('field.model'), metricValue(model)]);
  if (context) rows.push([t('field.context'), metricValue(context)]);
  // The owner's model choice (#128), beside what the soul last reported;
  // agent-bot applies it on the next turn. Absent while agent-bot cannot say.
  if (chosenModel.setting) {
    rows.push([t('model.choice'), (
      <ModelControl soul={soul} setting={chosenModel.setting} saving={chosenModel.saving} error={chosenModel.error} onChange={chosenModel.change} />
    )]);
  }
  if (comms) {
    rows.push([t('field.managed'), comms.managed ? t('comms.managed') : t('comms.unmanaged')]);
    rows.push([t('field.comms'), (
      <>
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" role="switch" checked={comms.comms} disabled={comms.running || commsSaving}
            aria-label={t('comms.toggle', { name: displayName(soul) })}
            onChange={(e) => toggleComms(e.target.checked)} />
          <span>{comms.comms ? t('comms.on') : t('comms.off')}</span>
        </label>
        {comms.running && <span className="block text-[11px] text-muted-foreground">{t('comms.stopFirst')}</span>}
        {commsSaving && <span className="block text-[11px] text-muted-foreground" role="status">{t('comms.saving')}</span>}
        {commsError && <span className="error block text-[11px]" role="alert">{t('comms.failed', { message: commsError })}</span>}
      </>
    )]);
  }
  // Details rows from the Lovable design (#122), each shown once agent-bot
  // can say. Wake is locked while the soul runs, as comms is.
  if (wake) {
    const locked = comms?.running === true;
    rows.push([t('details.wake'), (
      <>
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" role="switch" checked={wake.on} disabled={locked || wakeSaving}
            aria-label={t('details.wakeToggle', { name: displayName(soul) })}
            onChange={(e) => toggleWake(e.target.checked)} />
          <span>{wake.on ? t('comms.on') : t('comms.off')}</span>
        </label>
        {locked && <span className="block text-[11px] text-muted-foreground">{t('comms.stopFirst')}</span>}
        {wakeSaving && <span className="block text-[11px] text-muted-foreground" role="status">{t('comms.saving')}</span>}
        {wakeError && <span className="error block text-[11px]" role="alert">{t('details.wakeFailed', { message: wakeError })}</span>}
      </>
    )]);
  }
  // Execution mode (#122): not locked while the soul runs; agent-bot applies
  // it on the next permission request.
  if (execution.mode) {
    rows.push([t('mode.label'), (
      <>
        <ModeSwitch soul={soul} mode={execution.mode} saving={execution.saving} onChange={execution.change} />
        {execution.mode === 'safe' && <span className="block text-[11px] text-muted-foreground">{t('mode.safeHint')}</span>}
        {execution.saving && <span className="block text-[11px] text-muted-foreground" role="status">{t('comms.saving')}</span>}
        {execution.error && <span className="error block text-[11px]" role="alert">{t('mode.failed', { message: execution.error })}</span>}
      </>
    )]);
  }
  // Computer use (#122, no Lovable screen): beside Execution mode, in its
  // style; agent-bot denies the soul's computer-use proposals while off.
  if (computer.on !== null) {
    rows.push([t('computerUse.label'), (
      <>
        <ComputerUseToggle soul={soul} on={computer.on} saving={computer.saving} onChange={computer.change} />
        {!computer.on && <span className="block text-[11px] text-muted-foreground">{t('computerUse.hint')}</span>}
        {computer.stopped && <span className="block text-[11px] text-muted-foreground" role="status">{t('computerUse.stopped')}</span>}
        {computer.saving && <span className="block text-[11px] text-muted-foreground" role="status">{t('comms.saving')}</span>}
        {computer.error && <span className="error block text-[11px]" role="alert">{t('computerUse.failed', { message: computer.error })}</span>}
      </>
    )]);
  }
  if (signIn) {
    rows.push([t('login.status'), (
      <span className={signIn === 'ok' ? 'text-success' : 'text-destructive'}>{t(SIGN_IN_TEXT[signIn])}</span>
    )]);
  }
  if (population) {
    rows.push([t('keyd.title'), population.appSlug ? t('keyd.connected', { app: population.appSlug }) : t('keyd.none')]);
  }

  // As the design's Details tab: a bordered list, sans labels and mono values.
  return (
    <div className="grid gap-3 p-4">
      {note && <p className="muted m-0">{note}</p>}
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
      {launch && launching && <LaunchForm {...launch} soul={soul} initialComms={comms?.comms} roster={roster} />}
      {launch && !launching && (
        <div className="flex justify-end">
          <button type="button" onClick={() => setLaunching(true)}
            className="min-h-8 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">
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
        {error && <span className="error block text-[11px]" role="alert">{t('comms.failed', { message: error })}</span>}
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
      <AlarmClock className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
      <span className="flex-1">
        <span className="block text-sm font-medium">{t('details.wake')}</span>
        <span className="block text-xs text-muted-foreground">{locked ? t('comms.stopFirst') : t('details.wakeHint', { name })}</span>
        {saving && <span className="block text-[11px] text-muted-foreground" role="status">{t('comms.saving')}</span>}
        {error && <span className="error block text-[11px]" role="alert">{t('details.wakeFailed', { message: error })}</span>}
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
        {error && <span className="error block text-[11px]" role="alert">{t('mode.failed', { message: error })}</span>}
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
        {error && <span className="error block text-[11px]" role="alert">{t('computerUse.failed', { message: error })}</span>}
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
      {error && <span className="error block text-[11px]" role="alert">{t('model.failed', { message: error })}</span>}
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
 * The design's harness sign-in and GitHub App rows. The App row is
 * read-only: agent-bot has no per-soul connect or rotate yet.
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
          <h3 className="m-0 flex-1 text-sm">{t('login.status')} · {displayHarness(soul)}</h3>
          <span className={`text-xs ${signIn === 'ok' ? 'text-success' : 'text-destructive'}`}>{t(SIGN_IN_TEXT[signIn])}</span>
        </div>
      )}
      {record && (
        <div className="flex items-center gap-3 p-3">
          <Github className="size-4 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <h3 className="m-0 text-sm">{t('keyd.title')}</h3>
            <p className="m-0 truncate font-mono text-[11px] text-muted-foreground">
              {record.appSlug ? t('keyd.connected', { app: record.appSlug }) : t('keyd.none')}
            </p>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * ⓘ and the Details sheet (Lovable 19.29.22): the soul's actionable rows.
 * Wake on new messages, Agent comms, execution mode, computer use, model
 * (#128), harness sign-in and the GitHub App (read-only), each once
 * agent-bot reports it.
 */
export function InfoButton({ soul }: { soul: CensusRow }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const close = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => { if (open) close.current?.focus(); }, [open]);
  const name = displayName(soul);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label={t('details.title')} title={t('details.title')} aria-haspopup="dialog"
        className="rounded p-1 text-muted-foreground hover:text-foreground">
        <Info className="size-3.5" aria-hidden />
      </button>
      {/* Portalled to the body: the companion window's transform would otherwise
          contain the fixed overlay, and a React pointerdown bubbling from the
          sheet would start a drag in the title bar that holds this button. */}
      {open && createPortal(
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
          onPointerDown={(e) => e.stopPropagation()}>
          <section role="dialog" aria-modal="true" aria-labelledby={titleId}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }}
            className="relative grid w-full max-w-md gap-3 rounded-lg border border-border bg-popover p-5 shadow-2xl">
            <button ref={close} type="button" onClick={() => setOpen(false)} aria-label={t('close')}
              className="absolute top-3 right-3 rounded p-1 text-muted-foreground hover:text-foreground">
              <X className="size-4" aria-hidden />
            </button>
            <div>
              <h2 id={titleId} className="m-0 text-base font-semibold">{t('details.title')} · {name}</h2>
              <p className="m-0 text-sm text-muted-foreground">{displayHarness(soul)}</p>
            </div>
            <div className="divide-y divide-border rounded-md border border-border empty:hidden">
              <WakeRow soul={soul} />
              <CommsRow soul={soul} />
              <ModeRow soul={soul} />
              <ComputerUseRow soul={soul} />
              <ModelRow soul={soul} />
              <SoulFactRows soul={soul} />
            </div>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}

/** The team a companion belongs to, as nested delegation (R6). */
export function DelegationTree({ forest, focus, paused, onOpen }:
  { forest: readonly SoulNode[]; focus: string; paused: boolean; onOpen: (soul: CensusRow) => void }) {
  const { t } = useI18n();
  const root = teamNodeOf(forest, focus);
  if (!root) return null;
  const node = (n: SoulNode): ReactNode => {
    const key = soulKey(n.soul);
    return (
      <li key={key}>
        <button
          type="button"
          aria-current={key === focus ? 'true' : undefined}
          onClick={() => onOpen(n.soul)}
          className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm ${key === focus
            ? 'border-primary bg-primary/10' : 'border-border bg-card hover:bg-accent'}`}
        >
          <SoulDudle soul={n.soul} size={22} paused={paused} />
          <span className="font-medium text-foreground">{displayName(n.soul)}</span>
          <span className="text-xs text-muted-foreground">{t(`presence.${n.soul.presence}`)}</span>
        </button>
        {n.children.length > 0 && (
          <ul className="mt-2 ml-5 grid list-none gap-2 border-l border-border pl-5">{n.children.map(node)}</ul>
        )}
      </li>
    );
  };
  return <ul className="m-0 grid list-none gap-3 p-6" aria-label={t('tab.tree')}>{node(root)}</ul>;
}

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Info, Radio, X } from 'lucide-react';
import { runtimeMetrics, setSoulComms, soulComms, type RuntimeMetrics, type RuntimeObservation, type SoulComms } from '../bridge';
import {
  availabilityNote,
  displayHarness,
  displayName,
  parentDisplayName,
  soulKey,
  type CensusRow,
  type SoulNode,
} from '../model/census';
import type { ChatEntry, Composer } from '../model/chat';
import { deriveDudle } from '../model/dudle';
import { teamNodeOf } from '../model/fleet';
import { useI18n, type Translate } from '../lib/i18n';
import type { LaunchApi } from '../useLaunch';
import { Conversation } from './Conversation';
import { SoulDudle } from './FleetList';
import { LaunchForm } from './LaunchForm';

/** The conversation with this soul, when chat is available (#17). */
export interface SoulChat {
  entries: readonly ChatEntry[];
  composer: Composer;
  onDraft: (draft: string) => void;
  onSend: () => void;
}

/** Launching souls (#18), with suggestions from the census. */
export interface LaunchProps {
  launcher: LaunchApi;
  accounts: readonly string[];
  harnesses: readonly string[];
  /** The viewer's default harness for new launches. */
  defaultHarness?: string | null;
}

type Tab = 'chat' | 'tree' | 'details';

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
}

/**
 * One companion's session (R6): a header, then Chat, its team's delegation
 * tree, and the read-only details with Launch. Without chat it opens on
 * the details.
 */
export function CompanionSession({ soul, forest, roster, paused = false, chat, launch, onOpen, onClose, showBack = false, metricsRefresh = 0 }: CompanionSessionProps) {
  const { t } = useI18n();
  const ids = useId();
  const back = useRef<HTMLButtonElement>(null);
  const tabs: Tab[] = chat ? ['chat', 'tree', 'details'] : ['details', 'tree'];
  const [tab, setTab] = useState<Tab>(tabs[0]);
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
          <Conversation name={name} entries={chat.entries} composer={chat.composer} onDraft={chat.onDraft} onSend={chat.onSend}
            dudle={deriveDudle(soul.agentId)} paused={paused} />
        )}
        {active === 'tree' && <DelegationTree forest={forest} focus={soulKey(soul)} paused={paused} onOpen={onOpen} />}
        {active === 'details' && <CompanionDetails soul={soul} roster={roster} launch={launch} metricsRefresh={metricsRefresh} />}
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

/** The read-only fields, with Launch… when launching is available. */
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
      {launch && launching && <LaunchForm {...launch} soul={soul} initialComms={comms?.comms} />}
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
 * ⓘ and the Details sheet (Lovable 19.29.22): the soul's actionable rows.
 * Only Agent comms is backed today; Wake (#90), harness sign-in and the
 * GitHub App via keyd join when agent-bot reports them.
 */
export function InfoButton({ soul }: { soul: CensusRow }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) close.current?.focus(); }, [open]);
  const name = displayName(soul);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label={t('details.title')} title={t('details.title')} aria-haspopup="dialog"
        className="rounded p-1 text-muted-foreground hover:text-foreground">
        <Info className="size-3.5" aria-hidden />
      </button>
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <section role="dialog" aria-modal="true" aria-label={`${t('details.title')} · ${name}`}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }}
            className="relative grid w-full max-w-md gap-3 rounded-lg border border-border bg-popover p-5 shadow-2xl">
            <button ref={close} type="button" onClick={() => setOpen(false)} aria-label={t('close')}
              className="absolute top-3 right-3 rounded p-1 text-muted-foreground hover:text-foreground">
              <X className="size-4" aria-hidden />
            </button>
            <div>
              <h2 className="m-0 text-base font-semibold">{t('details.title')} · {name}</h2>
              <p className="m-0 text-sm text-muted-foreground">{displayHarness(soul)}</p>
            </div>
            <div className="divide-y divide-border rounded-md border border-border empty:hidden">
              <CommsRow soul={soul} />
            </div>
          </section>
        </div>
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

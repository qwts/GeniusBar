import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { runtimeMetrics, type RuntimeMetrics, type RuntimeObservation } from '../bridge';
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
      <div className="flex items-center gap-2.5 border-b border-border px-3 py-2">
        {showBack && (
          <button ref={back} type="button" aria-label={t('back')} title={t('back')} onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
            <ArrowLeft className="size-4" aria-hidden />
          </button>
        )}
        <SoulDudle soul={soul} size={32} paused={paused} label={t('avatarFor', { name })} />
        <div className="min-w-0">
          <h2 className="m-0 truncate text-sm font-semibold">{name}</h2>
          <p className="m-0 truncate text-[11px] text-muted-foreground">
            {displayHarness(soul)} · {t(`presence.${soul.presence}`)}
          </p>
        </div>
      </div>
      <div role="tablist" aria-label={name} className="flex gap-1 border-b border-border px-2 pt-1"
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
            className={`-mb-px border-b-2 px-2.5 py-1.5 text-xs font-medium ${active === id
              ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
            {t(`tab.${id}`)}
          </button>
        ))}
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

  return (
    <div className="grid gap-3 p-3">
      <p className="selectable m-0 font-mono text-[11px] text-muted-foreground">{soul.agentId}</p>
      {note && <p className="muted m-0">{note}</p>}
      <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        {rows.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="m-0">{value}</dd>
          </div>
        ))}
      </dl>
      {errors.map((error, index) => (
        <p key={index} className="m-0 text-[11px] text-muted-foreground">{t('metrics.collectorError', { source: error.source, message: error.message })}</p>
      ))}
      {launch && launching && <LaunchForm {...launch} soul={soul} />}
      {launch && !launching && (
        <div className="detail-actions">
          <button type="button" onClick={() => setLaunching(true)}>{t('launch')}</button>
        </div>
      )}
    </div>
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
          className={`inline-flex items-center gap-2 rounded-md border px-2 py-1 text-sm ${key === focus
            ? 'border-primary bg-primary/10' : 'border-border bg-card hover:bg-accent'}`}
        >
          <SoulDudle soul={n.soul} size={20} paused={paused} />
          <span className="font-medium">{displayName(n.soul)}</span>
          <span className="text-xs text-muted-foreground">{t(`presence.${n.soul.presence}`)}</span>
        </button>
        {n.children.length > 0 && (
          <ul className="mt-2 ml-4 grid list-none gap-2 border-l border-border pl-4">{n.children.map(node)}</ul>
        )}
      </li>
    );
  };
  return <ul className="m-0 grid list-none gap-2 p-3" aria-label={t('tab.tree')}>{node(root)}</ul>;
}

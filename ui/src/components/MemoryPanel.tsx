// The Memory tab (#268, Lovable "Soul life" `MemoryPanel`): what agent-bot
// keeps for this soul, read-only. Continuity comes from the `soul env`
// descriptor, with the design's hint under it; memory shows where it lives
// and no entries, because the engine has no structured memory format yet
// (the Agent Space is a private directory agents write freely) and the
// app invents none; the past runs come from `soul env history`, behind the
// `env-history` capability, as facts (kind, harness, times, outcome): the
// mirror holds no message counts or titles, so none are shown. The current
// conversation stays in Chat.
import { useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash, Info } from 'lucide-react';
import { engineCan, type SoulEnvHistory } from '../bridge';
import { useI18n } from '../lib/i18n';
import { auditTime } from '../model/audit';
import type { CensusRow } from '../model/census';
import { continuityOfRead, formatDuration, historyRuns, memoryLocation, refusalOf, runOutcome, runSeconds, type Continuity, type EngineRefusal, type RunOutcome } from '../model/environment';
import { button, CONTINUITY_TEXT, EnvironmentSourceContext, useSoulEnvironment } from './EnvironmentSection';

/** The design's hint under each continuity word (its `env.<state>Hint`). */
const CONTINUITY_HINT = { ready: 'env.continuity.readyHint', 'needs-migration': 'env.continuity.needsMigrationHint', unavailable: 'env.continuity.unavailableHint', unsupported: 'env.continuity.unsupportedHint' } as const;
const ICON: Record<Continuity, typeof CheckCircle2> = { ready: CheckCircle2, 'needs-migration': Info, unavailable: AlertTriangle, unsupported: CircleSlash };
const TONE: Record<Continuity, string> = { ready: 'text-success', 'needs-migration': 'text-info', unavailable: 'text-warning', unsupported: 'text-muted-foreground' };
const KIND_TEXT = { turn: 'memory.kind.turn', wake: 'memory.kind.wake', task: 'memory.kind.task', launch: 'memory.kind.launch', session: 'memory.kind.session' } as const;
const OUTCOME_TEXT = { ok: 'memory.outcome.ok', failed: 'memory.outcome.failed', cancelled: 'memory.outcome.cancelled' } as const;
const OUTCOME_TONE: Record<RunOutcome, string> = { ok: 'text-success', failed: 'text-destructive', cancelled: 'text-warning', other: 'text-muted-foreground' };

/** The page asked of the engine: its own default. */
export const HISTORY_LIMIT = 50;

type HistoryRead = { history: SoulEnvHistory; error: null } | { history: null; error: EngineRefusal };

/**
 * Reads the soul's history once the descriptor lists `env-history`, again
 * on each refresh and on `reload`; null while a read is in flight or the
 * engine was not asked. Tickets drop a late answer for another soul.
 */
function useSoulHistory(agentId: string, enabled: boolean, refresh: number): { read: HistoryRead | null; reload: () => void } {
  const source = useContext(EnvironmentSourceContext);
  const [read, setRead] = useState<HistoryRead | null>(null);
  const [tick, setTick] = useState(0);
  const ticket = useRef(0);
  useEffect(() => {
    const mine = ++ticket.current;
    setRead(null);
    if (!enabled) return;
    source.history(agentId, HISTORY_LIMIT).then(
      (history) => { if (ticket.current === mine) setRead({ history, error: null }); },
      (failure: unknown) => { if (ticket.current === mine) setRead({ history: null, error: refusalOf(failure) }); },
    );
  }, [source, agentId, enabled, refresh, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { read, reload };
}

/** A time as the engine printed it, in the app's medium date and time; the raw value when it is not a time. */
function When({ at, lang }: { at: string; lang: string }) {
  const parsed = Date.parse(at);
  return <time dateTime={Number.isFinite(parsed) ? new Date(parsed).toISOString() : at} className="shrink-0 text-xs text-muted-foreground">{auditTime(at, lang)}</time>;
}

/**
 * The tab: the chat note, the continuity card, Memories & decisions (the
 * empty state and where memory lives), then Past conversations with the
 * engine's count line, Refresh, one row per run and the revisions folded
 * under them. It reads the descriptor as the Environment section does
 * and lists only what the engine reports.
 */
export function MemoryPanel({ soul, refresh = 0 }: { soul: CensusRow; refresh?: number }) {
  const { t, lang } = useI18n();
  const ids = useId();
  const { read, reload: reloadEnvironment } = useSoulEnvironment(soul.agentId, refresh);
  const env = read?.env ?? null;
  const continuity = read ? continuityOfRead(read) : null;
  const supported = engineCan(env, 'env-history');
  const { read: history, reload: reloadHistory } = useSoulHistory(soul.agentId, supported, refresh);
  const Icon = continuity ? ICON[continuity] : Info;
  const location = env ? memoryLocation(env) : null;
  const runs = history?.history ? historyRuns(history.history) : [];
  const page = history?.history?.turns ?? null;
  const revisions = history?.history?.revisions.records ?? [];
  const busy = read === null || (supported && history === null);
  const refreshAll = () => { reloadEnvironment(); reloadHistory(); };
  const kindOf = (kind: string) => (Object.hasOwn(KIND_TEXT, kind) ? t(KIND_TEXT[kind as keyof typeof KIND_TEXT]) : kind);

  return (
    <div className="space-y-5 p-4 md:px-8">
      <p className="m-0 text-xs text-muted-foreground">{t('memory.chatNote')}</p>

      {/* The design's continuity card: icon, word and hint, one of the four, never claiming loss. */}
      <div className="flex items-start gap-2 rounded-md border border-border p-3" role={continuity === 'unavailable' || continuity === 'unsupported' ? 'status' : undefined}>
        <Icon className={`mt-0.5 size-4 shrink-0 ${continuity ? TONE[continuity] : 'text-muted-foreground'}`} aria-hidden />
        <div className="min-w-0">
          {continuity ? (
            <>
              <p className="m-0 text-sm font-medium">{t('env.continuity')}: {t(CONTINUITY_TEXT[continuity])}</p>
              <p className="m-0 text-xs text-muted-foreground">{t(CONTINUITY_HINT[continuity])}</p>
            </>
          ) : <p className="m-0 text-sm text-muted-foreground">{t('env.checking')}</p>}
        </div>
      </div>

      <section aria-labelledby={`${ids}-mem`} className="space-y-2">
        <h2 id={`${ids}-mem`} className="m-0 text-sm font-semibold">{t('memory.memories')}</h2>
        {/* No structured memory format in the engine yet: the design's empty state, and never an invented entry. */}
        <p className="m-0 text-sm text-muted-foreground">{t('memory.empty')}{continuity ? ` ${t(CONTINUITY_HINT[continuity])}` : ''}</p>
        {location && (
          <dl className="m-0 divide-y divide-border rounded-md border border-border text-sm">
            <div className="flex gap-3 px-3 py-2">
              <dt className="w-40 shrink-0 text-muted-foreground">{t('memory.location')}</dt>
              <dd className="m-0 min-w-0 flex-1 font-mono text-xs leading-5 [overflow-wrap:anywhere]">
                {location.location ? t(location.location === 'inside' ? 'memory.inside' : 'memory.linked') : t('unknown')}
                {location.path && <span className="block text-muted-foreground">{location.path}</span>}
              </dd>
            </div>
          </dl>
        )}
      </section>

      <section aria-labelledby={`${ids}-ses`} className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id={`${ids}-ses`} className="m-0 text-sm font-semibold">{t('memory.sessions')}</h2>
          <span className="flex items-center gap-2">
            {page && <span className="text-xs text-muted-foreground">{t('memory.sessionsCount', { listed: page.listed, total: page.total })}</span>}
            <button type="button" onClick={refreshAll} disabled={busy} className={button}>{t('memory.refresh')}</button>
          </span>
        </div>
        {/* Without the capability the section says so and asks nothing; a descriptor that could not be read says what the continuity card says. */}
        {env && !supported && <p className="m-0 text-sm text-muted-foreground">{t('memory.historyUnsupported')}</p>}
        {read?.error && <p className="m-0 text-sm text-muted-foreground">{t(read.error.code === 'soul-env-unsupported' ? 'memory.historyUnsupported' : 'env.continuity.unavailableHint')}</p>}
        {supported && history === null && <p className="m-0 text-sm text-muted-foreground" role="status">{t('memory.loading')}</p>}
        {history?.error && <p className="m-0 text-sm text-destructive" role="alert">{t('memory.historyFailed', { message: history.error.message })}</p>}
        {history?.history && (
          <ul className="m-0 list-none divide-y divide-border rounded-md border border-border p-0">
            {runs.length === 0 && (
              <li className="px-3 py-2 text-sm text-muted-foreground">{t(continuity === 'unavailable' ? 'env.continuity.unavailableHint' : 'memory.noRuns')}</li>
            )}
            {runs.map((run) => {
              const seconds = runSeconds(run);
              const outcome = runOutcome(run.outcome);
              return (
                <li key={run.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 text-sm">
                  <span className="w-16 shrink-0 text-xs text-muted-foreground">{kindOf(run.kind)}</span>
                  <span className="min-w-0 flex-1 font-mono text-xs [overflow-wrap:anywhere]">{run.harness ?? '—'}</span>
                  <span className="text-xs text-muted-foreground">{seconds === null ? '—' : formatDuration(seconds)}</span>
                  <span className={`text-xs ${OUTCOME_TONE[outcome]}`}>{outcome === 'other' ? run.outcome ?? '—' : t(OUTCOME_TEXT[outcome])}</span>
                  {run.startedAt ? <When at={run.startedAt} lang={lang} /> : <span className="text-xs text-muted-foreground">—</span>}
                </li>
              );
            })}
          </ul>
        )}
        {revisions.length > 0 && (
          <details className="rounded-md border border-border p-3 text-xs">
            <summary className="cursor-pointer font-medium">{t('memory.revisions')} ({revisions.length})</summary>
            <ul className="m-0 mt-2 grid list-none gap-1 p-0 font-mono [overflow-wrap:anywhere]">
              {revisions.map((r) => (
                <li key={r.id}>{r.at ? auditTime(r.at, lang) : '—'} · {r.id} · <span className="font-sans text-muted-foreground">{r.reason ?? '—'}</span></li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </div>
  );
}

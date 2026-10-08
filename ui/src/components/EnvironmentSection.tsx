// The Environment section of a companion's Details (#268, design handoff
// "Soul environment, readiness and retained life"): what agent-bot's
// `soul env` descriptor says about the soul's root, components, harnesses,
// runtimes, sign-in, providers, secrets and retained memory, rendered as
// reported and never inferred from the filesystem. Every button is gated on
// `engine.capabilities`; the engine runs the install and the migrations
// itself and owner-gates them (Touch ID), as `soul remove` does.
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, CircleSlash, Info, WifiOff, X } from 'lucide-react';
import { installSoulRuntime, migrateSoulEnvironment, soulEnvironment, type EnvironmentMigration, type MigrationKind, type RuntimeInstall, type SoulEnvironment } from '../bridge';
import { displayName, type CensusRow } from '../model/census';
import {
  componentRows, environmentActions, environmentState, failedStep, harnessRows, historySummary, installOutcome, installProgress, installReducer, installSummary,
  memoryContinuity, nextStep, planInstall, providerRows, runtimeRows, secretRows, toolSignIns,
  type EnvironmentRead, type EnvironmentState, type InstallEvent, type InstallRun, type InstallableRow, type SignInState,
} from '../model/environment';
import { useI18n, type Translate } from '../lib/i18n';

/** Where the descriptor and the engine's operations come from: agent-bot in the app, fixtures in the preview and tests. */
export interface EnvironmentSource {
  environment: (agentId: string) => Promise<SoulEnvironment>;
  /** `soul runtimes install <soul> --runtime NAME --json`, owner-gated by the engine. */
  installRuntime: (agentId: string, runtime: string) => Promise<RuntimeInstall>;
  /** `soul env migrate <soul> --adopt-host-signin --harness NAME | --space-into-soul --json`, owner-gated by the engine. */
  migrate: (agentId: string, kind: MigrationKind, harness: string | null) => Promise<EnvironmentMigration>;
}

// A source that throws instead of rejecting still settles as a rejection.
const settled = <T,>(run: () => Promise<T>): Promise<T> => new Promise<T>((resolve) => resolve(run()));

export const EnvironmentSourceContext = createContext<EnvironmentSource>({
  environment: (agentId) => settled(() => soulEnvironment(agentId)),
  installRuntime: (agentId, runtime) => settled(() => installSoulRuntime(agentId, runtime)),
  migrate: (agentId, kind, harness) => settled(() => migrateSoulEnvironment(agentId, kind, harness)),
});

const messageOf = (failure: unknown): string => {
  const e = failure as { message?: unknown };
  return typeof e?.message === 'string' ? e.message : String(failure);
};

/** Reads the descriptor for the soul, again on each refresh and on `reload`. `read` is null while a read is in flight. */
export function useSoulEnvironment(agentId: string, refresh = 0): { read: EnvironmentRead | null; reload: () => void } {
  const source = useContext(EnvironmentSourceContext);
  const [read, setRead] = useState<EnvironmentRead | null>(null);
  const [tick, setTick] = useState(0);
  const ticket = useRef(0);
  useEffect(() => {
    const mine = ++ticket.current;
    setRead(null);
    source.environment(agentId).then(
      (env) => { if (ticket.current === mine) setRead({ env, error: null }); },
      (failure: unknown) => {
        if (ticket.current !== mine) return;
        const e = failure as { code?: unknown };
        setRead({ env: null, error: { code: typeof e?.code === 'string' ? e.code : 'soul-env-failed', message: messageOf(failure) } });
      },
    );
  }, [source, agentId, refresh, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { read, reload };
}

const SIGN_IN_TEXT = { 'signed-in': 'env.signIn.signedIn', expired: 'env.signIn.expired', 'not-signed-in': 'env.signIn.notSignedIn', unknown: 'env.signIn.unknown' } as const;
const CONTINUITY_TEXT = { ready: 'env.continuity.ready', 'needs-migration': 'env.continuity.needsMigration', unavailable: 'env.continuity.unavailable', unsupported: 'env.continuity.unsupported' } as const;
const STATUS_TEXT = { installed: 'env.status.installed', missing: 'env.status.missing', unsupported: 'env.status.unsupported' } as const;
const STEP_TEXT = { 'not-started': 'env.step.notStarted', running: 'env.step.running', completed: 'env.step.completed', failed: 'env.step.failed', unknown: 'env.step.unknown' } as const;

const severityClass = (severity: 'error' | 'warning') => (severity === 'error' ? 'border-destructive text-destructive' : 'border-border text-muted-foreground');
const button = 'inline-flex min-h-8 items-center gap-2 rounded-md border border-border px-3 text-sm font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50';
const primary = 'inline-flex min-h-8 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 disabled:opacity-50';
const heading = 'm-0 text-xs font-semibold tracking-wide text-muted-foreground uppercase';
const mono = 'font-mono text-xs [overflow-wrap:anywhere]';

/** A label-and-value cell: the label shows only when the rows stack (below 480px). */
function Cell({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <span className={`min-w-0 ${className}`}>
      <span className="text-muted-foreground min-[480px]:hidden">{label}: </span>
      {children}
    </span>
  );
}

/** Declared versus installed, as the engine lists both; stacked rows below 480px. */
function InstallableRows({ rows, selected, t }: { rows: InstallableRow[]; selected?: string | null; t: Translate }) {
  const cols = 'grid gap-x-3 gap-y-0.5 px-3 py-1.5 min-[480px]:grid-cols-[1.2fr_1fr_1fr_1fr]';
  return (
    <ul className="m-0 list-none divide-y divide-border rounded-md border border-border p-0 text-xs">
      <li className={`${cols} hidden text-muted-foreground min-[480px]:grid`} aria-hidden>
        <span>{t('env.col.name')}</span><span>{t('env.col.declared')}</span><span>{t('env.col.installed')}</span><span>{t('env.col.status')}</span>
      </li>
      {rows.map((row) => (
        <li key={row.name} className={cols}>
          <Cell label={t('env.col.name')} className={mono}>{row.name}{row.name === selected && <span className="ml-1 font-sans text-[11px] text-muted-foreground">· {t('env.selected')}</span>}</Cell>
          <Cell label={t('env.col.declared')} className={mono}>{row.declared ?? '—'}</Cell>
          <Cell label={t('env.col.installed')} className={mono}>{row.installed ?? '—'}</Cell>
          <Cell label={t('env.col.status')}>
            <span className={row.status === 'installed' ? 'text-success' : row.status === 'unsupported' ? 'text-destructive' : 'text-warning'}>{t(STATUS_TEXT[row.status])}</span>
            {row.reason && <span className="block text-[11px] text-muted-foreground">{row.reason}</span>}
          </Cell>
        </li>
      ))}
    </ul>
  );
}

const STATE_ICON: Record<EnvironmentState, typeof CheckCircle2> = {
  ready: CheckCircle2, 'migration-required': Info, 'partial-errors': AlertTriangle, offline: WifiOff, unsupported: CircleSlash,
};

/**
 * The plan dialog (the handoff's Dialog): review the steps, confirm, watch
 * the progress, then the verified result or an actionable failure. Focus
 * is trapped, Escape cancels before anything runs and closes afterwards,
 * and is ignored while a step runs (there is no engine cancel, so none is
 * offered); failure moves focus to Retry.
 */
function InstallPlanDialog({ name, run, onConfirm, onRetry, onClose }: {
  name: string; run: InstallRun; onConfirm: () => void; onRetry: () => void; onClose: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const box = useRef<HTMLElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const summary = installSummary(run);
  const running = run.phase === 'running';
  useEffect(() => { confirm.current?.focus(); }, []);
  useEffect(() => { if (summary === 'failure') retry.current?.focus(); }, [summary]);
  const trap = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (!running) onClose();
      return;
    }
    if (e.key !== 'Tab' || !box.current) return;
    const focusable = [...box.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  const progress = installProgress(run);
  const failed = failedStep(run);
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4" onPointerDown={(e) => e.stopPropagation()}>
      <section ref={box} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={trap}
        className="relative grid max-h-full w-full max-w-md gap-4 overflow-y-auto rounded-lg border border-border bg-background p-6 shadow-lg">
        {!running && (
          <button type="button" onClick={onClose} aria-label={run.phase === 'plan' ? t('cancel') : t('close')}
            className="absolute top-4 right-4 rounded-sm text-foreground opacity-70 outline-none hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring">
            <X className="size-4" aria-hidden />
          </button>
        )}
        <h2 id={titleId} className="m-0 pr-6 text-lg leading-none font-semibold tracking-tight">{t('env.planTitle', { name })}</h2>
        {run.phase === 'plan' && <p className="m-0 text-sm text-muted-foreground">{t('env.planBody')}</p>}
        <ol className="m-0 grid list-none gap-1 p-0 text-sm">
          {run.steps.map((step) => (
            <li key={step.runtime} className="flex flex-wrap items-baseline gap-x-2">
              <span className={mono}>{step.runtime}{step.version ? ` ${step.version}` : ''}</span>
              <span className={`text-xs ${step.status === 'completed' ? 'text-success' : step.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>
                {t(STEP_TEXT[step.status])}{step.message ? `: ${step.message}` : ''}
              </span>
            </li>
          ))}
        </ol>
        <p role="status" aria-live="polite" className="m-0 min-h-5 text-sm">
          {progress && t('env.progress', { n: progress.step, total: progress.total })}
          {summary === 'success' && t('env.success', { name })}
          {summary === 'done-not-ready' && t('env.doneNotReady', { name })}
          {summary === 'unknown' && t('env.unknownOutcome')}
        </p>
        {running && <p className="m-0 text-xs text-muted-foreground">{t('env.noCancel')}</p>}
        {summary === 'failure' && failed && (
          <p role="alert" className="m-0 text-sm text-destructive">{t('env.failure', { step: failed.runtime, engineMessage: failed.message ?? t('unknown') })}</p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {run.phase === 'plan' && <button type="button" onClick={onClose} className={button}>{t('cancel')}</button>}
          {run.phase === 'plan' && <button ref={confirm} type="button" onClick={onConfirm} className={primary}>{t('env.confirmInstall')}</button>}
          {summary === 'failure' && <button ref={retry} type="button" onClick={onRetry} className={primary}>{t('env.retry')}</button>}
          {run.phase !== 'plan' && <button type="button" onClick={onClose} className={button}>{t('close')}</button>}
        </div>
      </section>
    </div>,
    document.body,
  );
}

interface MigrationState { kind: MigrationKind; busy: boolean; result: EnvironmentMigration | null; error: string | null }

/**
 * The section: lives in the Details scroll pane, below the fact rows. The
 * Agent ID is shown as the census carries it and never changes here.
 */
export function EnvironmentSection({ soul, refresh = 0 }: { soul: CensusRow; refresh?: number }) {
  const { t } = useI18n();
  const ids = useId();
  const source = useContext(EnvironmentSourceContext);
  const { read, reload } = useSoulEnvironment(soul.agentId, refresh);
  const name = displayName(soul);
  const env = read?.env ?? null;
  const state = read ? environmentState(read) : null;
  const actions = env ? environmentActions(env) : null;

  // The install run lives here, not in the dialog: closing an in-progress
  // view hides it without stopping the engine, and the result still lands.
  const [run, setRun] = useState<InstallRun | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const planButton = useRef<HTMLButtonElement>(null);
  const [migration, setMigration] = useState<MigrationState | null>(null);
  const shown = useRef(soul.agentId);
  useEffect(() => { shown.current = soul.agentId; setRun(null); setPlanOpen(false); setMigration(null); }, [soul.agentId]);

  const execute = useCallback(async (start: InstallRun) => {
    const agentId = soul.agentId;
    let current = start;
    for (;;) {
      const index = nextStep(current);
      if (index === null) break;
      current = installReducer(current, { type: 'begin', index });
      if (shown.current === agentId) setRun(current);
      const runtime = current.steps[index].runtime;
      let event: InstallEvent;
      try {
        const result = await source.installRuntime(agentId, runtime);
        const { outcome, message } = installOutcome(result, runtime);
        event = { type: 'finish', index, outcome, message, ready: result.ready };
      } catch (failure) {
        event = { type: 'finish', index, outcome: 'failed', message: messageOf(failure), ready: null };
      }
      current = installReducer(current, event);
      if (shown.current === agentId) setRun(current);
      if (current.phase === 'finished') break;
    }
    if (shown.current === agentId) reload();
  }, [source, soul.agentId, reload]);

  const migrate = async (kind: MigrationKind, harness: string | null) => {
    const agentId = soul.agentId;
    setMigration({ kind, busy: true, result: null, error: null });
    try {
      const result = await source.migrate(agentId, kind, harness);
      if (shown.current === agentId) setMigration({ kind, busy: false, result, error: null });
    } catch (failure) {
      if (shown.current === agentId) setMigration({ kind, busy: false, result: null, error: messageOf(failure) });
    }
    if (shown.current === agentId) reload();
  };

  const closePlan = () => { setPlanOpen(false); if (run?.phase === 'plan') setRun(null); planButton.current?.focus(); };
  const Icon = state ? STATE_ICON[state] : Info;
  const tone = state === 'ready' && env?.readiness.ready ? 'text-success' : state === 'ready' || state === 'migration-required' ? 'text-info' : state === 'partial-errors' ? 'text-warning' : 'text-muted-foreground';
  const problems = env?.readiness.problems ?? [];
  const signIns = env ? toolSignIns(env) : [];
  const secrets = env ? secretRows(env) : [];
  const providers = env ? providerRows(env) : [];
  const history = env ? historySummary(env) : null;
  const migrationLine = (m: MigrationState) => (m.busy ? t(m.kind === 'space-into-soul' ? 'env.migrating' : 'env.adopting')
    : m.error ? t('env.migrateFailed', { message: m.error })
      : m.result ? `${t('env.migrated', { operation: m.result.operation, decision: m.result.decision ?? t('unknown') })}${m.result.steps.map((s) => (s.note ? ` — ${s.note}` : '')).join('')}` : '');

  return (
    <section aria-labelledby={`${ids}-title`} className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${ids}-title`} className="m-0 text-sm font-semibold">{t('env.title')}</h3>
        <button type="button" onClick={reload} disabled={read === null} className={button}>{t('env.recheck')}</button>
      </div>
      <p className={`m-0 ${mono} text-muted-foreground`}><span className="font-sans">{t('env.agentId')} · </span><span className="selectable text-foreground">{soul.agentId}</span></p>

      {/* The state, one of the handoff's five, never claiming loss. */}
      <div className="flex items-start gap-2 rounded-md border border-border p-3" role={state === 'offline' || state === 'unsupported' ? 'status' : undefined}>
        <Icon className={`mt-0.5 size-4 shrink-0 ${tone}`} aria-hidden />
        <div className="grid min-w-0 flex-1 gap-1 text-sm">
          {read === null && <p className="m-0 text-muted-foreground">{t('env.checking')}</p>}
          {state === 'offline' && <p className="m-0">{t('env.offline')}</p>}
          {state === 'unsupported' && <p className="m-0">{t('env.unsupported', { name })}</p>}
          {state === 'partial-errors' && env && (
            <>
              <p className="m-0">{t('env.partial')}</p>
              <ul className="m-0 list-none p-0 text-xs text-muted-foreground">
                {env.errors.map((e, i) => <li key={i}>{e.area ? `${e.area}: ` : ''}{e.message}</li>)}
              </ul>
            </>
          )}
          {state === 'migration-required' && (
            <>
              <p className="m-0 font-medium">{t('env.migrationRequired')}</p>
              <p className="m-0 text-xs text-muted-foreground">{t('env.migrationHint')}</p>
            </>
          )}
          {state === 'ready' && env?.readiness.ready && problems.length === 0 && <p className="m-0">{t('env.ready')}</p>}
          {env && (state === 'ready' ? !env.readiness.ready || problems.length > 0 : problems.length > 0) && (
            <p className="m-0 font-medium">{t('env.problems')}</p>
          )}
          {env && problems.length > 0 && (
            <ul className="m-0 grid list-none gap-1 p-0 text-xs">
              {problems.map((p, i) => (
                <li key={`${p.code}-${i}`} className="grid gap-0.5">
                  <span>
                    <span className={`mr-2 rounded border px-1 py-px text-[10px] uppercase ${severityClass(p.severity)}`}>{t(p.severity === 'error' ? 'env.blocks' : 'env.warning')}</span>
                    {p.message}
                  </span>
                  {/* The recovery command the engine lists, shown and never run by itself. */}
                  {p.action && <code className="block text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{p.action}</code>}
                </li>
              ))}
            </ul>
          )}
          {env && env.migration.steps.length > 0 && (
            <ul className="m-0 list-none p-0 text-xs text-muted-foreground">
              {env.migration.steps.map((s) => <li key={s.id} className={mono}>{s.id} — {s.status ?? t('unknown')}{s.from && s.to ? ` (${s.from} → ${s.to})` : ''}</li>)}
            </ul>
          )}
          {/* Capability-gated recovery: the engine lists the action for the problem, and can run it. */}
          {actions?.install && (
            <div className="grid gap-1 pt-1">
              {actions.install.map((m) => <p key={m.name} className="m-0 text-xs">{t('env.problemInstall', { harness: m.name })}</p>)}
              <div>
                <button ref={planButton} type="button" aria-haspopup="dialog" className={button}
                  onClick={() => { setRun((r) => (r && r.phase !== 'plan' ? r : planInstall(actions.install ?? []))); setPlanOpen(true); }}>
                  {t('env.reviewPlan')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {env && (harnessRows(env).length > 0 || runtimeRows(env).length > 0) && (
        <div className="grid gap-1.5">
          <h4 className={heading}>{t('env.harnesses')}</h4>
          {harnessRows(env).length > 0 && <InstallableRows rows={harnessRows(env)} selected={env.harnesses.selected} t={t} />}
          {runtimeRows(env).length > 0 && <InstallableRows rows={runtimeRows(env)} t={t} />}
        </div>
      )}

      {env && signIns.length > 0 && (
        <div className="grid gap-1.5">
          <h4 className={heading}>{t('env.signIn')}</h4>
          <ul className="m-0 list-none divide-y divide-border rounded-md border border-border p-0 text-xs">
            {signIns.map((s) => (
              <li key={s.harness} className="grid gap-1 px-3 py-1.5">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className={mono}>{s.harness}</span>
                  <span className={s.signIn === 'signed-in' ? 'text-success' : s.signIn === 'unknown' ? 'text-muted-foreground' : 'text-warning'}>{t('env.signInSoul', { state: t(SIGN_IN_TEXT[s.signIn as SignInState]) })}</span>
                  <span className="text-muted-foreground">{t('env.signInHost', { state: t(SIGN_IN_TEXT[s.hostSignIn]) })}</span>
                  <span className="text-muted-foreground">· {t(s.containment === 'soul' ? 'env.contained' : 'env.sharedHost')}</span>
                </span>
                {actions?.adopt === s.harness && (
                  <div>
                    <button type="button" className={button} disabled={migration?.busy} onClick={() => migrate('adopt-host-signin', s.harness)}>{t('env.adopt', { harness: s.harness })}</button>
                  </div>
                )}
                {migration?.kind === 'adopt-host-signin' && <p className="m-0 text-muted-foreground" role="status">{migrationLine(migration)}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {env && (
        <div className="grid gap-1.5">
          <h4 className={heading}>{t('env.providers')}</h4>
          {providers.length === 0 && secrets.length === 0 ? <p className="m-0 text-xs text-muted-foreground">{t('env.nothingDeclared')}</p> : (
            <ul className="m-0 list-none divide-y divide-border rounded-md border border-border p-0 text-xs">
              {providers.map((p) => (
                <li key={`${p.harness}-${p.id}`} className="flex flex-wrap items-baseline gap-x-2 px-3 py-1.5">
                  <span className={mono}>{t('env.provider', { harness: p.harness, provider: p.name ? `${p.name} (${p.id})` : p.id })}</span>
                  <span className={p.status === 'ready' ? 'text-success' : 'text-warning'}>{p.status ?? t('unknown')}</span>
                </li>
              ))}
              {/* Status only: no value, no length, ever. */}
              {secrets.map((s) => (
                <li key={s.name} className="flex flex-wrap items-baseline gap-x-2 px-3 py-1.5">
                  <span className={mono}>{s.name}</span>
                  <span className={s.status === 'set' ? 'text-success' : s.status === 'missing' ? 'text-warning' : 'text-muted-foreground'}>{t(`env.secret.${s.status}`)}</span>
                  {s.store && <span className="text-muted-foreground">· {s.store}</span>}
                  {s.usedBy.length > 0 && <span className="text-muted-foreground">· {s.usedBy.join(', ')}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {env && (
        <div className="grid gap-1.5">
          <h4 className={heading}>{t('env.memory')}</h4>
          <div className="grid gap-1 rounded-md border border-border px-3 py-2 text-xs">
            <p className="m-0 text-sm"><span className="text-muted-foreground">{t('env.continuity')}: </span>{t(CONTINUITY_TEXT[memoryContinuity(env)])}</p>
            <p className="m-0 text-muted-foreground">{t('env.transcriptCaution')}</p>
            {history && (
              <p className={`m-0 ${mono} text-muted-foreground`}>
                {history.mirrored ? t('env.history', { turns: history.turns ?? 0, revisions: history.revisions ?? 0 }) : t('env.historyNone')}
              </p>
            )}
            {actions?.migrateSpace && (
              <div>
                <button type="button" className={button} disabled={migration?.busy} onClick={() => migrate('space-into-soul', null)}>{t('env.migrate')}</button>
              </div>
            )}
            {migration?.kind === 'space-into-soul' && <p className="m-0 text-muted-foreground" role="status">{migrationLine(migration)}</p>}
          </div>
        </div>
      )}

      {env && env.components.length > 0 && (
        <div className="grid gap-1.5">
          <h4 className={heading}>{t('env.components')}</h4>
          <ul className="m-0 list-none divide-y divide-border rounded-md border border-border p-0 text-xs">
            <li className="hidden gap-x-3 px-3 py-1.5 text-muted-foreground min-[480px]:grid min-[480px]:grid-cols-[1fr_1.4fr_1fr_1fr_0.7fr]" aria-hidden>
              <span>{t('env.col.component')}</span><span>{t('env.col.path')}</span><span>{t('env.col.classification')}</span><span>{t('env.col.retention')}</span><span>{t('env.col.presence')}</span>
            </li>
            {componentRows(env).map((row) => (
              <li key={row.id} className="grid gap-x-3 gap-y-0.5 px-3 py-1.5 min-[480px]:grid-cols-[1fr_1.4fr_1fr_1fr_0.7fr]">
                <Cell label={t('env.col.component')} className={mono}>{row.id}</Cell>
                <Cell label={t('env.col.path')} className={`${mono} text-muted-foreground`}>
                  {row.path ?? '—'}
                  {row.entries !== null && <span className="block font-sans text-[11px]">{t('env.entries', { count: row.entries })}</span>}
                  {row.paths !== null && <span className="block font-sans text-[11px]">{t('env.paths', { count: row.paths })}</span>}
                </Cell>
                <Cell label={t('env.col.classification')}>{row.classification}</Cell>
                <Cell label={t('env.col.retention')}>{row.retention ?? '—'}</Cell>
                <Cell label={t('env.col.presence')}><span className={row.present ? '' : 'text-muted-foreground'}>{t(row.present ? 'env.present' : 'env.absent')}</span></Cell>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Later features, visible and gated until the engine has the capabilities. */}
      <div className="grid gap-1.5">
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled aria-describedby={`${ids}-gated`} className={button}>{t('env.export')}</button>
          <button type="button" disabled aria-describedby={`${ids}-gated`} className={button}>{t('env.import')}</button>
          <button type="button" disabled aria-describedby={`${ids}-gated`} className={button}>{t('env.cleanCache')}</button>
        </div>
        <p id={`${ids}-gated`} className="m-0 text-xs text-muted-foreground">{t('env.gated')}</p>
      </div>

      {env && (
        <details className="rounded-md border border-border p-3 text-xs">
          <summary className="cursor-pointer font-medium">{t('env.diagnostics')}</summary>
          <dl className={`m-0 mt-2 grid gap-1 ${mono}`}>
            <div><dt className="inline text-muted-foreground">{t('env.diag.soulDir')}: </dt><dd className="inline">{env.root.soulDir ?? '—'}</dd></div>
            <div><dt className="inline text-muted-foreground">{t('env.diag.soulsRoot')}: </dt><dd className="inline">{env.root.soulsRoot ?? '—'}</dd></div>
            <div><dt className="inline text-muted-foreground">{t('env.diag.marker')}: </dt><dd className="inline">{env.root.marker ?? '—'}{env.root.copies.length > 0 ? ` · ${env.root.copies.join(', ')}` : ''}</dd></div>
            <div><dt className="inline text-muted-foreground">{t('env.diag.engine')}: </dt><dd className="inline">{env.engine.version ?? '—'}{env.engine.contractVersion !== null ? ` · contract ${env.engine.contractVersion}` : ''}</dd></div>
            <div><dt className="inline text-muted-foreground">{t('env.diag.capabilities')}: </dt><dd className="inline">{env.engine.capabilities.join(', ') || '—'}</dd></div>
            <div><dt className="inline text-muted-foreground">{t('env.diag.launch')}: </dt><dd className="inline">{env.launch.lane ?? '—'}{env.launch.cwd ? ` · ${env.launch.cwd}` : ''}</dd></div>
            {env.migration.journal && <div><dt className="inline text-muted-foreground">{t('env.diag.journal')}: </dt><dd className="inline">{env.migration.journal}</dd></div>}
            {problems.filter((p) => p.action).map((p, i) => (
              <div key={`${p.code}-${i}`}><dt className="inline text-muted-foreground">{t('env.diag.command')} · {p.code}: </dt><dd className="inline">{p.action}</dd></div>
            ))}
            {env.launch.limitations.map((l, i) => <div key={i} className="font-sans text-muted-foreground">{l.harness ? `${l.harness}: ` : ''}{l.message}</div>)}
          </dl>
        </details>
      )}

      {planOpen && run && (
        <InstallPlanDialog name={name} run={run} onClose={closePlan}
          onConfirm={() => { void execute(run); }}
          onRetry={() => { const next = installReducer(run, { type: 'retry' }); setRun(next); void execute(next); }} />
      )}
    </section>
  );
}

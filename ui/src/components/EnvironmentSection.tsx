// The Environment section of a companion's Details (#268, design handoff
// "Soul environment, readiness and retained life"): what agent-bot's
// `soul env` descriptor says about the soul's root, components, harnesses,
// runtimes, sign-in, providers, secrets and retained memory, rendered as
// reported and never inferred from the filesystem. Every button is gated on
// `engine.capabilities`; the engine runs the install, the migrations, the
// clean, the life export and the import itself and owner-gates them (Touch
// ID), as `soul remove` does.
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, CircleSlash, Info, WifiOff, X } from 'lucide-react';
import {
  installSoulRuntime, migrateSoulEnvironment, soulEnvClean, soulEnvExport, soulEnvHistory, soulEnvImport, soulEnvironment,
  type EnvironmentMigration, type EnvironmentMigrationStep, type ImportIdentity, type MigrationKind, type RuntimeInstall, type SoulCleanRow, type SoulEnvHistory, type SoulEnvironment, type SoulEnvironmentClean,
  type SoulEnvironmentExport, type SoulEnvironmentImport, type SoulLifeWorkspace,
} from '../bridge';
import { displayName, type CensusRow } from '../model/census';
import {
  classificationRows, cleanGroups, componentRows, defaultExportPath, environmentActions, environmentState, exportSummary, failedStep, formatBytes, harnessRows, historySummary, importChoices,
  installOutcome, installProgress, installReducer, installSummary, linkedWorkspaces, manifestClassifications, manifestPointers,
  memoryContinuity, migrationStepStatus, nextStep, planInstall, providerRows, refusalOf, runtimeRows, secretRows, toolSignIns,
  type ClassificationRow, type EngineRun, type EnvironmentRead, type EnvironmentState, type InstallEvent, type InstallRun, type InstallableRow, type SignInState,
} from '../model/environment';
import { useI18n, type Translate } from '../lib/i18n';

/** Where the descriptor and the engine's operations come from: agent-bot in the app, fixtures in the preview and tests. */
export interface EnvironmentSource {
  environment: (agentId: string) => Promise<SoulEnvironment>;
  /** `soul runtimes install <soul> --runtime NAME --json`, owner-gated by the engine. */
  installRuntime: (agentId: string, runtime: string) => Promise<RuntimeInstall>;
  /**
   * `soul env migrate <soul> --adopt-host-signin --harness NAME | --space-into-soul | --complete [--plan] --json`,
   * owner-gated by the engine; `plan` (complete only) is the read-only list of the pending steps.
   */
  migrate: (agentId: string, kind: MigrationKind, harness: string | null, plan?: boolean) => Promise<EnvironmentMigration>;
  /** `soul env clean <soul> [--plan] [--component ID] --json`: the plan is read-only, the apply owner-gated by the engine. */
  clean: (agentId: string, options: { plan: boolean; components: string[] | null }) => Promise<SoulEnvironmentClean>;
  /** `soul env export <soul> [--to FILE] [--plan] --json`: the plan is the manifest, read-only; the write is owner-gated by the engine. */
  exportLife: (agentId: string, options: { plan: boolean; to: string | null }) => Promise<SoulEnvironmentExport>;
  /** `soul env import FILE [--replace | --fork] [--name NAME] [--plan] --json`: the plan reads the manifest only; the apply is owner-gated by the engine. */
  importLife: (archive: string, options: { plan: boolean; identity: ImportIdentity; name: string | null }) => Promise<SoulEnvironmentImport>;
  /** `soul env history <soul> [--limit N] --json` (the Memory tab, #268): the mirror's runs and revisions, read-only, behind `env-history`. */
  history: (agentId: string, limit: number | null) => Promise<SoulEnvHistory>;
}

// A source that throws instead of rejecting still settles as a rejection.
const settled = <T,>(run: () => Promise<T>): Promise<T> => new Promise<T>((resolve) => resolve(run()));

export const EnvironmentSourceContext = createContext<EnvironmentSource>({
  environment: (agentId) => settled(() => soulEnvironment(agentId)),
  installRuntime: (agentId, runtime) => settled(() => installSoulRuntime(agentId, runtime)),
  migrate: (agentId, kind, harness, plan = false) => settled(() => migrateSoulEnvironment(agentId, kind, harness, undefined, plan)),
  clean: (agentId, options) => settled(() => soulEnvClean(agentId, options)),
  exportLife: (agentId, options) => settled(() => soulEnvExport(agentId, options)),
  importLife: (archive, options) => settled(() => soulEnvImport(archive, options)),
  history: (agentId, limit) => settled(() => soulEnvHistory(agentId, limit)),
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
/** The continuity words, shared with the Memory tab, which adds the design's hint under each. */
export const CONTINUITY_TEXT = { ready: 'env.continuity.ready', 'needs-migration': 'env.continuity.needsMigration', unavailable: 'env.continuity.unavailable', unsupported: 'env.continuity.unsupported' } as const;
const STATUS_TEXT = { installed: 'env.status.installed', missing: 'env.status.missing', unsupported: 'env.status.unsupported' } as const;
const STEP_TEXT = { 'not-started': 'env.step.notStarted', running: 'env.step.running', completed: 'env.step.completed', failed: 'env.step.failed', unknown: 'env.step.unknown' } as const;
const MIGRATION_STEP_TEXT = { 'not-started': 'env.step.notStarted', completed: 'env.step.completed', failed: 'env.step.failed', skipped: 'env.step.skipped' } as const;

const severityClass = (severity: 'error' | 'warning') => (severity === 'error' ? 'border-destructive text-destructive' : 'border-border text-muted-foreground');
/** The section's secondary button (Re-check environment and the plan buttons); the Memory tab's Refresh takes it too. */
export const button = 'inline-flex min-h-8 items-center gap-2 rounded-md border border-border px-3 text-sm font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50';
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
 * The handoff's Dialog, shared by the plan dialogs: focus is trapped,
 * Escape cancels before anything runs and closes afterwards, and is
 * ignored while the engine runs (there is no engine cancel, so none is
 * offered and the corner X goes too). Each dialog places its own initial
 * focus and returns it to its trigger on close.
 */
function Modal({ title, running, cancelling, onClose, children }: { title: string; running: boolean; cancelling: boolean; onClose: () => void; children: ReactNode }) {
  const { t } = useI18n();
  const titleId = useId();
  const box = useRef<HTMLElement>(null);
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
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4" onPointerDown={(e) => e.stopPropagation()}>
      <section ref={box} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={trap}
        className="relative grid max-h-full w-full max-w-md gap-4 overflow-y-auto rounded-lg border border-border bg-background p-6 shadow-lg">
        {!running && (
          <button type="button" onClick={onClose} aria-label={cancelling ? t('cancel') : t('close')}
            className="absolute top-4 right-4 rounded-sm text-foreground opacity-70 outline-none hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring">
            <X className="size-4" aria-hidden />
          </button>
        )}
        <h2 id={titleId} className="m-0 pr-6 text-lg leading-none font-semibold tracking-tight">{title}</h2>
        {children}
      </section>
    </div>,
    document.body,
  );
}

/**
 * The install plan dialog: review the steps, confirm, watch the progress,
 * then the verified result or an actionable failure; failure moves focus
 * to Retry.
 */
function InstallPlanDialog({ name, run, onConfirm, onRetry, onClose }: {
  name: string; run: InstallRun; onConfirm: () => void; onRetry: () => void; onClose: () => void;
}) {
  const { t } = useI18n();
  const confirm = useRef<HTMLButtonElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const summary = installSummary(run);
  const running = run.phase === 'running';
  useEffect(() => { confirm.current?.focus(); }, []);
  useEffect(() => { if (summary === 'failure') retry.current?.focus(); }, [summary]);
  const progress = installProgress(run);
  const failed = failedStep(run);
  return (
    <Modal title={t('env.planTitle', { name })} running={running} cancelling={run.phase === 'plan'} onClose={onClose}>
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
    </Modal>
  );
}

/**
 * One plan-then-apply run against the engine, kept in the section rather
 * than its dialog: closing an in-progress view hides it without stopping
 * the engine, and the result still lands (and the descriptor is read
 * again). `shown` is the soul on screen; a result for another soul is
 * dropped. `A` is what the run carries to the engine (nothing for a clean;
 * the export's destination; the import's archive and identity decision):
 * the last arguments given are what Retry uses unless it is given others.
 */
function useEngineRun<T, A = void>(agentId: string, shown: RefObject<string>, read: (args: A) => Promise<T>, apply: (args: A) => Promise<T>, after: () => void) {
  const [run, setRun] = useState<EngineRun<T> | null>(null);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const latest = useRef<EngineRun<T> | null>(null);
  const given = useRef<A>(undefined as A);
  const set = useCallback((next: EngineRun<T> | null) => { latest.current = next; if (shown.current === agentId) setRun(next); }, [agentId, shown]);
  const plan = useCallback(async (args: A) => {
    given.current = args;
    set({ phase: 'planning', plan: null, result: null, error: null });
    try {
      const planned = await read(args);
      set({ phase: 'plan', plan: planned, result: null, error: null });
    } catch (failure) {
      set({ phase: 'finished', plan: null, result: null, error: refusalOf(failure) });
    }
  }, [read, set]);
  const confirm = useCallback(async (args: A = given.current) => {
    const current = latest.current;
    if (!current || current.phase === 'running') return;
    given.current = args;
    set({ ...current, phase: 'running', result: null, error: null });
    try {
      const result = await apply(args);
      set({ ...current, phase: 'finished', result, error: null });
    } catch (failure) {
      set({ ...current, phase: 'finished', result: null, error: refusalOf(failure) });
    }
    if (shown.current === agentId) after();
  }, [agentId, after, apply, set, shown]);
  // Retry re-reads a plan that could not be read, else runs the apply again (the engine plans afresh itself).
  const retry = useCallback((args: A = given.current) => { if (latest.current?.plan) void confirm(args); else void plan(args); }, [confirm, plan]);
  const start = useCallback((args: A) => { setOpen(true); if (latest.current?.phase !== 'running') void plan(args); }, [plan]);
  // Opens without planning: the import asks for the archive first.
  const show = useCallback(() => { setOpen(true); }, []);
  const close = useCallback(() => { setOpen(false); if (latest.current?.phase !== 'running') set(null); trigger.current?.focus(); }, [set]);
  const reset = useCallback(() => { latest.current = null; setRun(null); setOpen(false); }, []);
  return { run, open, trigger, start, show, plan, confirm, retry, close, reset };
}

/** An engine refusal, with the command it names shown as text the owner may run; the app never runs it. */
function Refusal({ text, action }: { text: string; action: string | null }) {
  return (
    <div role="alert" className="grid gap-1 text-sm text-destructive">
      <p className="m-0">{text}</p>
      {action && <code className="block text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{action}</code>}
    </div>
  );
}

function CleanRows({ rows, t }: { rows: SoulCleanRow[]; t: Translate }) {
  return (
    <ul className="m-0 grid list-none gap-0.5 p-0 pl-3 text-xs">
      {rows.map((row) => (
        <li key={row.relative} className="grid gap-x-2 min-[480px]:grid-cols-[1fr_auto]">
          <span className={mono}>{row.relative}</span>
          <span className="text-muted-foreground">{row.kind ?? row.classification ?? ''}{row.files !== null ? ` · ${formatBytes(row.bytes)}` : ''}</span>
          {row.reason && <span className="text-muted-foreground min-[480px]:col-span-2">{row.reason}</span>}
          {row.error && <span className="text-destructive min-[480px]:col-span-2">{t('env.clean.notRemoved', { error: row.error })}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * The clean dialog: what the engine would remove, grouped by component
 * with counts and sizes, and what it keeps with the reason; confirm; the
 * owner-gated apply; then the engine's counts, `nothing`, the paths it
 * could not remove with their errors, or its refusal (`soul-running`
 * names the command, shown and never run). Nothing is said of durable
 * data: the engine never lists it, and the dialog repeats the engine.
 */
function CleanDialog({ name, run, onConfirm, onRetry, onClose }: {
  name: string; run: EngineRun<SoulEnvironmentClean>; onConfirm: () => void; onRetry: () => void; onClose: () => void;
}) {
  const { t } = useI18n();
  const confirm = useRef<HTMLButtonElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const running = run.phase === 'running';
  const plan = run.phase === 'plan' ? run.plan : null;
  const removable = plan ? cleanGroups(plan.removable) : [];
  const result = run.phase === 'finished' ? run.result : null;
  const failed = result?.decision === 'failed' || run.error !== null;
  useEffect(() => { if (run.phase === 'plan') confirm.current?.focus(); }, [run.phase]);
  useEffect(() => { if (failed) retry.current?.focus(); }, [failed]);
  return (
    <Modal title={t('env.clean.title', { name })} running={running} cancelling={run.phase === 'plan' || run.phase === 'planning'} onClose={onClose}>
      {run.phase === 'planning' && <p role="status" className="m-0 text-sm text-muted-foreground">{t('env.clean.planning')}</p>}
      {plan && removable.length > 0 && <p className="m-0 text-sm text-muted-foreground">{t('env.clean.body')}</p>}
      {plan && (
        <div className="grid gap-2 text-sm">
          {removable.length === 0 && <p className="m-0">{t('env.clean.nothing')}</p>}
          {removable.length > 0 && (
            <div className="grid gap-1.5">
              <h3 className={heading}>{t('env.clean.wouldRemove')}</h3>
              {removable.map((group) => (
                <div key={group.component} className="grid gap-0.5">
                  <p className={`m-0 ${mono}`}>{t('env.clean.group', { component: group.component, files: group.files, bytes: formatBytes(group.bytes) })}</p>
                  <CleanRows rows={group.rows} t={t} />
                </div>
              ))}
            </div>
          )}
          {plan.kept.length > 0 && (
            <div className="grid gap-1">
              <h3 className={heading}>{t('env.clean.kept')}</h3>
              <CleanRows rows={plan.kept} t={t} />
            </div>
          )}
        </div>
      )}
      <p role="status" aria-live="polite" className="m-0 min-h-5 text-sm">
        {running && t('env.clean.running')}
        {result?.decision === 'cleaned' && t('env.clean.done', { files: result.files ?? 0, bytes: formatBytes(result.bytes ?? 0) })}
        {result?.decision === 'nothing' && t('env.clean.nothing')}
      </p>
      {running && <p className="m-0 text-xs text-muted-foreground">{t('env.noCancel')}</p>}
      {result?.decision === 'failed' && (
        <div className="grid gap-1.5">
          <Refusal text={t('env.clean.failed')} action={null} />
          <CleanRows rows={result.failed} t={t} />
          {result.removed.length > 0 && <p className="m-0 text-xs text-muted-foreground">{t('env.clean.done', { files: result.files ?? 0, bytes: formatBytes(result.bytes ?? 0) })}</p>}
        </div>
      )}
      {run.error && <Refusal text={t('env.clean.refused', { message: run.error.message })} action={run.error.action} />}
      <div className="flex flex-wrap justify-end gap-2">
        {plan && removable.length > 0 && <button type="button" onClick={onClose} className={button}>{t('cancel')}</button>}
        {plan && removable.length > 0 && <button ref={confirm} type="button" onClick={onConfirm} className={primary}>{t('env.clean.confirm')}</button>}
        {failed && <button ref={retry} type="button" onClick={onRetry} className={primary}>{t('env.retry')}</button>}
        {!(plan && removable.length > 0) && <button type="button" onClick={onClose} className={button}>{t('close')}</button>}
      </div>
    </Modal>
  );
}

function MigrationStepRows({ steps, planned, t }: { steps: EnvironmentMigrationStep[]; planned: boolean; t: Translate }) {
  return (
    <ol className="m-0 grid list-none gap-1 p-0 text-sm">
      {steps.map((step) => {
        const status = migrationStepStatus(step.status);
        const tone = status === 'completed' ? 'text-success' : status === 'failed' ? 'text-destructive' : 'text-muted-foreground';
        return (
          <li key={step.id} className="grid gap-x-2 gap-y-0.5">
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span className={mono}>{step.id}</span>
              {/* In the plan the engine's status word is the step's state (`pending`, `copying`, `failed`); after the run the handoff's four. */}
              <span className={`text-xs ${planned ? 'text-muted-foreground' : tone}`}>{planned || status === 'other' ? step.status ?? t('unknown') : t(MIGRATION_STEP_TEXT[status])}</span>
            </span>
            {step.note && <span className="text-xs text-muted-foreground">{step.note}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The migration completion dialog: the pending steps with the engine's
 * note on each, confirm, the owner-gated apply, then per-step results
 * (completed / failed / not started / skipped) and the engine's decision;
 * a failure moves focus to Retry, and the refusal while the soul runs
 * shows the command as text.
 */
function CompleteDialog({ name, run, onConfirm, onRetry, onClose }: {
  name: string; run: EngineRun<EnvironmentMigration>; onConfirm: () => void; onRetry: () => void; onClose: () => void;
}) {
  const { t } = useI18n();
  const confirm = useRef<HTMLButtonElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const running = run.phase === 'running';
  const plan = run.phase === 'plan' ? run.plan : null;
  const result = run.phase === 'finished' ? run.result : null;
  const failed = result?.decision === 'failed' || run.error !== null;
  useEffect(() => { if (run.phase === 'plan') confirm.current?.focus(); }, [run.phase]);
  useEffect(() => { if (failed) retry.current?.focus(); }, [failed]);
  const steps = result?.steps ?? run.plan?.steps ?? [];
  return (
    <Modal title={t('env.complete.title', { name })} running={running} cancelling={run.phase === 'plan' || run.phase === 'planning'} onClose={onClose}>
      {run.phase === 'planning' && <p role="status" className="m-0 text-sm text-muted-foreground">{t('env.complete.planning')}</p>}
      {plan && <p className="m-0 text-sm text-muted-foreground">{t('env.complete.body')}</p>}
      {steps.length > 0 && <MigrationStepRows steps={steps} planned={result === null} t={t} />}
      <p role="status" aria-live="polite" className="m-0 min-h-5 text-sm">
        {running && t('env.complete.running')}
        {result?.decision === 'completed' && t('env.complete.done')}
        {result?.decision === 'skipped' && t('env.complete.skipped')}
      </p>
      {running && <p className="m-0 text-xs text-muted-foreground">{t('env.noCancel')}</p>}
      {result?.decision === 'failed' && <Refusal text={t('env.complete.failed')} action={null} />}
      {run.error && <Refusal text={t('env.complete.refused', { message: run.error.message })} action={run.error.action} />}
      <div className="flex flex-wrap justify-end gap-2">
        {plan && <button type="button" onClick={onClose} className={button}>{t('cancel')}</button>}
        {plan && <button ref={confirm} type="button" onClick={onConfirm} className={primary}>{t('env.complete.confirm')}</button>}
        {failed && <button ref={retry} type="button" onClick={onRetry} className={primary}>{t('env.retry')}</button>}
        {!plan && <button type="button" onClick={onClose} className={button}>{t('close')}</button>}
      </div>
    </Modal>
  );
}

const input = 'min-h-8 w-full rounded-md border border-border bg-background px-2 text-sm font-mono [overflow-wrap:anywhere]';

function ClassificationRows({ rows, t }: { rows: ClassificationRow[]; t: Translate }) {
  return (
    <ul className="m-0 grid list-none gap-0.5 p-0 pl-3 text-xs">
      {rows.map((row) => <li key={row.classification} className={mono}>{t('env.life.row', { classification: row.classification, files: row.files, bytes: formatBytes(row.bytes) })}</li>)}
    </ul>
  );
}

/** A linked workspace as the manifest or the import lists it: the repository stays where it is; the pointer, the patch and the untracked files travel. */
function WorkspaceRows({ rows, t }: { rows: (SoulLifeWorkspace & { imported?: string | null })[]; t: Translate }) {
  return (
    <ul className="m-0 grid list-none gap-0.5 p-0 pl-3 text-xs">
      {rows.map((w) => (
        <li key={w.name} className="grid gap-y-0.5">
          <span className={mono}>{w.name} → {w.target ?? '—'}</span>
          <span className="text-muted-foreground">
            {[w.branch ? `${w.branch}${w.head ? ` ${w.head.slice(0, 12)}` : ''}` : null, w.patch ? t('env.life.patch') : null, t('env.life.untracked', { count: w.untracked ?? 0 })].filter(Boolean).join(' · ')}
          </span>
          {w.note && <span className="text-muted-foreground">{w.note}</span>}
          {w.imported && <span className="text-muted-foreground">{t('env.import.workspaceHint', { imported: w.imported })}</span>}
        </li>
      ))}
    </ul>
  );
}

function PointerRows({ rows }: { rows: { relative: string; target: string | null }[] }) {
  return (
    <ul className="m-0 grid list-none gap-0.5 p-0 pl-3 text-xs">
      {rows.map((p) => <li key={p.relative} className={mono}>{p.relative} → {p.target ?? '—'}</li>)}
    </ul>
  );
}

/** The destination can be picked again after a refusal about it (`export-target-exists`, `export-target-inside-root`). */
const TARGET_REFUSALS = new Set(['export-target-exists', 'export-target-inside-root']);

/**
 * The export dialog: the engine's manifest, read-only (what travels by
 * classification, what is left out and why, linked workspaces as pointers,
 * the memory's location, the revision journal), the destination, confirm,
 * the owner-gated write, then the file written with the engine's counts,
 * or its refusal (`soul-running` names the stop command, shown and never
 * run; a destination refusal keeps the field so another path can be tried).
 * The manifest holds paths, counts and hashes, never a file's contents, and
 * the dialog repeats the engine.
 */
function ExportDialog({ name, run, to, onTo, onConfirm, onRetry, onClose }: {
  name: string; run: EngineRun<SoulEnvironmentExport>; to: string; onTo: (to: string) => void; onConfirm: () => void; onRetry: () => void; onClose: () => void;
}) {
  const { t } = useI18n();
  const ids = useId();
  const confirm = useRef<HTMLButtonElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const running = run.phase === 'running';
  const plan = run.phase === 'plan' ? run.plan : null;
  const result = run.phase === 'finished' ? run.result : null;
  const failed = run.error !== null;
  const pickAgain = failed && run.plan !== null && TARGET_REFUSALS.has(run.error?.code ?? '');
  useEffect(() => { if (run.phase === 'plan') confirm.current?.focus(); }, [run.phase]);
  useEffect(() => { if (failed) retry.current?.focus(); }, [failed]);
  const manifest = plan?.manifest ?? null;
  const summary = manifest ? exportSummary(manifest) : null;
  const linked = manifest ? linkedWorkspaces(manifest.workspaces) : [];
  const pointers = manifest ? manifestPointers(manifest) : [];
  const field = (plan !== null || pickAgain) && !running;
  return (
    <Modal title={t('env.export.title', { name })} running={running} cancelling={run.phase === 'plan' || run.phase === 'planning'} onClose={onClose}>
      {run.phase === 'planning' && <p role="status" className="m-0 text-sm text-muted-foreground">{t('env.export.planning')}</p>}
      {plan && <p className="m-0 text-sm text-muted-foreground">{t('env.export.body', { name })}</p>}
      {manifest && summary && (
        <div className="grid gap-2 text-sm">
          <div className="grid gap-1">
            <h3 className={heading}>{t('env.export.travels')}</h3>
            <p className={`m-0 ${mono}`}>{t('env.life.totals', { files: summary.files, bytes: formatBytes(summary.bytes) })}</p>
            <ClassificationRows rows={manifestClassifications(manifest)} t={t} />
            <p className="m-0 text-xs text-muted-foreground">
              {t('env.export.memory', { location: manifest.memory.location ?? t('unknown') })}{manifest.memory.target ? ` (${manifest.memory.target})` : ''} · {t('env.export.journal', { entries: summary.journalEntries })}
            </p>
          </div>
          {manifest.excluded.length > 0 && (
            <div className="grid gap-1">
              <h3 className={heading}>{t('env.export.leftOut')}</h3>
              <ul className="m-0 grid list-none gap-0.5 p-0 pl-3 text-xs">
                {manifest.excluded.map((row) => (
                  <li key={row.relative} className="grid gap-x-2 min-[480px]:grid-cols-[1fr_auto]">
                    <span className={mono}>{row.relative}</span>
                    <span className="text-muted-foreground">{row.classification ?? ''}</span>
                    {row.reason && <span className="text-muted-foreground min-[480px]:col-span-2">{row.reason}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {linked.length > 0 && (
            <div className="grid gap-1">
              <h3 className={heading}>{t('env.export.workspaces')}</h3>
              <p className="m-0 text-xs text-muted-foreground">{t('env.export.linkedHint')}</p>
              <WorkspaceRows rows={linked} t={t} />
            </div>
          )}
          {pointers.length > 0 && (
            <div className="grid gap-1">
              <h3 className={heading}>{t('env.export.pointers')}</h3>
              <PointerRows rows={pointers} />
            </div>
          )}
        </div>
      )}
      {field && (
        <div className="grid gap-1 text-sm">
          <label htmlFor={`${ids}-to`} className="text-xs font-medium">{t('env.export.to')}</label>
          <input id={`${ids}-to`} type="text" value={to} onChange={(e) => onTo(e.target.value)} spellCheck={false} autoComplete="off" className={input} aria-describedby={`${ids}-to-hint`} />
          <p id={`${ids}-to-hint`} className="m-0 text-xs text-muted-foreground">{t('env.export.toHint')}</p>
        </div>
      )}
      <p role="status" aria-live="polite" className="m-0 min-h-5 text-sm">
        {running && t('env.export.running')}
        {result?.decision === 'exported' && t('env.export.done', { file: result.file ?? '—', files: result.manifest.totals.files ?? 0, bytes: formatBytes(result.manifest.totals.bytes ?? 0) })}
      </p>
      {result?.decision === 'exported' && (
        <p className="m-0 text-xs text-muted-foreground">
          {t('env.export.doneDetail', { excluded: result.manifest.excluded.length, linked: linkedWorkspaces(result.manifest.workspaces).length })}
        </p>
      )}
      {running && <p className="m-0 text-xs text-muted-foreground">{t('env.noCancel')}</p>}
      {run.error && <Refusal text={t('env.export.refused', { message: run.error.message })} action={run.error.action} />}
      {pickAgain && <p className="m-0 text-xs text-muted-foreground">{t('env.export.pickAnother')}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {plan && <button type="button" onClick={onClose} className={button}>{t('cancel')}</button>}
        {plan && <button ref={confirm} type="button" onClick={onConfirm} disabled={to.trim() === ''} className={primary}>{t('env.export.confirm')}</button>}
        {failed && <button ref={retry} type="button" onClick={onRetry} disabled={pickAgain && to.trim() === ''} className={primary}>{t('env.retry')}</button>}
        {!plan && <button type="button" onClick={onClose} className={button}>{t('close')}</button>}
      </div>
    </Modal>
  );
}

/** What the import dialog carries to the engine: the archive, how the exported ID is settled, a fork's display name. */
export interface ImportForm {
  archive: string;
  identity: ImportIdentity;
  name: string;
}

const JOURNAL_TEXT: Record<string, 'env.import.journal.restored' | 'env.import.journal.adopted' | 'env.import.journal.keptLocal'> = {
  restored: 'env.import.journal.restored', adopted: 'env.import.journal.adopted', 'kept-local': 'env.import.journal.keptLocal',
};

/**
 * The import dialog: the archive's path, then the engine's plan (the
 * identity decision and the destination, what would be restored by
 * classification, pointers listed and never recreated, the linked
 * workspaces to link again), the replace-or-fork choice when the ID is
 * already here (fork only when it is retired), an optional display name
 * for a fork, confirm, the owner-gated apply, then the engine's report:
 * the root restored, its Agent ID, the previous root a replace moved aside
 * (never deleted), the journal's fate and the workspaces to link again, or
 * the engine's refusal with its action as text.
 */
function ImportDialog({ run, form, onForm, onPlan, onConfirm, onRetry, onClose }: {
  run: EngineRun<SoulEnvironmentImport> | null; form: ImportForm; onForm: (form: ImportForm) => void; onPlan: (form: ImportForm) => void; onConfirm: () => void; onRetry: () => void; onClose: () => void;
}) {
  const { t } = useI18n();
  const ids = useId();
  const archiveField = useRef<HTMLInputElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const phase = run?.phase ?? 'pick';
  const running = phase === 'running';
  const plan = run?.phase === 'plan' ? run.plan : null;
  const result = run?.phase === 'finished' ? run.result : null;
  const error = run?.error ?? null;
  const choices = importChoices(plan, error);
  // An identity refusal is the engine asking which way: the choice is the answer, not a failure to retry.
  const deciding = choices.length > 0 && plan === null;
  const failed = error !== null && !deciding;
  const picking = phase === 'pick' || (failed && run?.plan === null);
  useEffect(() => { if (phase === 'pick') archiveField.current?.focus(); }, [phase]);
  useEffect(() => { if (phase === 'plan') confirm.current?.focus(); }, [phase]);
  useEffect(() => { if (failed) retry.current?.focus(); }, [failed]);
  const choose = (identity: ImportIdentity) => { const next = { ...form, identity }; onForm(next); onPlan(next); };
  const identityLine = plan ? (plan.identity.decision === 'replace' ? t('env.import.replace', { soulDir: plan.identity.existing?.soulDir ?? '—' })
    : plan.identity.decision === 'fork' ? t('env.import.fork', { agentId: plan.identity.importedFrom ?? '—' })
      : t('env.import.keep', { agentId: plan.identity.agentId ?? '—' })) : null;
  const restored = result ?? plan;
  const workspaces = restored?.workspaces ?? [];
  const pointers = restored?.pointers ?? [];
  return (
    <Modal title={t('env.import.title')} running={running} cancelling={phase === 'pick' || phase === 'plan' || phase === 'planning' || deciding} onClose={onClose}>
      {picking && (
        <div className="grid gap-1 text-sm">
          <label htmlFor={`${ids}-archive`} className="text-xs font-medium">{t('env.import.archive')}</label>
          <input ref={archiveField} id={`${ids}-archive`} type="text" value={form.archive} onChange={(e) => onForm({ ...form, archive: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter' && form.archive.trim() !== '') { e.preventDefault(); onPlan(form); } }}
            spellCheck={false} autoComplete="off" className={input} aria-describedby={`${ids}-archive-hint`} />
          <p id={`${ids}-archive-hint`} className="m-0 text-xs text-muted-foreground">{t('env.import.archiveHint')}</p>
        </div>
      )}
      {phase === 'planning' && <p role="status" className="m-0 text-sm text-muted-foreground">{t('env.import.planning')}</p>}
      {/* The engine asking which way (`import-id-active`, `import-id-retired`): its message as it came, then the choice. */}
      {deciding && error && <p className="m-0 text-sm">{error.message}</p>}
      {plan && <p className="m-0 text-sm text-muted-foreground">{t('env.import.body')}</p>}
      {plan && identityLine && <p className="m-0 text-sm">{identityLine}</p>}
      {choices.length > 0 && !running && !result && (
        <fieldset className="m-0 grid gap-1 border-0 p-0 text-sm">
          <legend className="mb-1 text-xs font-medium">{t('env.import.choice')}</legend>
          {choices.map((choice) => (
            <label key={choice} className="flex items-center gap-2">
              <input type="radio" name={`${ids}-identity`} value={choice} checked={form.identity === choice} onChange={() => choose(choice)} />
              <span>{t(choice === 'replace' ? 'env.import.choiceReplace' : 'env.import.choiceFork')}</span>
            </label>
          ))}
        </fieldset>
      )}
      {plan && form.identity === 'fork' && (
        <div className="grid gap-1 text-sm">
          <label htmlFor={`${ids}-name`} className="text-xs font-medium">{t('env.import.name')}</label>
          <input id={`${ids}-name`} type="text" value={form.name} onChange={(e) => onForm({ ...form, name: e.target.value })} maxLength={128} autoComplete="off" className={input} aria-describedby={`${ids}-name-hint`} />
          <p id={`${ids}-name-hint`} className="m-0 text-xs text-muted-foreground">{t('env.import.nameHint', { name: plan.displayName ?? plan.name ?? '—' })}</p>
        </div>
      )}
      {plan && (
        <div className="grid gap-2 text-sm">
          <p className={`m-0 ${mono}`}><span className="font-sans text-muted-foreground">{t('env.import.destination')}: </span>{plan.soulDir ?? '—'}</p>
          <div className="grid gap-1">
            <h3 className={heading}>{t('env.import.wouldRestore')}</h3>
            <p className={`m-0 ${mono}`}>{t('env.life.totals', { files: plan.restored.files ?? 0, bytes: formatBytes(plan.restored.bytes ?? 0) })}</p>
            <ClassificationRows rows={classificationRows(plan.restored.byClassification)} t={t} />
          </div>
        </div>
      )}
      {(plan || result) && pointers.length > 0 && (
        <div className="grid gap-1 text-sm">
          <h3 className={heading}>{t('env.import.pointers')}</h3>
          <PointerRows rows={pointers} />
        </div>
      )}
      {(plan || result) && workspaces.length > 0 && (
        <div className="grid gap-1 text-sm">
          <h3 className={heading}>{t('env.import.workspaces')}</h3>
          <WorkspaceRows rows={workspaces} t={t} />
        </div>
      )}
      <p role="status" aria-live="polite" className="m-0 min-h-5 text-sm">
        {running && t('env.import.running')}
        {result?.applied && t('env.import.done', { name: result.displayName ?? result.name ?? '—', soulDir: result.soulDir ?? '—', files: result.restored.files ?? 0, bytes: formatBytes(result.restored.bytes ?? 0) })}
      </p>
      {result?.applied && (
        <div className={`grid gap-0.5 text-xs text-muted-foreground ${mono}`}>
          <span>{t('env.import.agentId', { agentId: result.identity.agentId ?? '—' })}</span>
          {result.replaced && <span className="font-sans">{t('env.import.replaced', { path: result.replaced })}</span>}
          {result.journal && JOURNAL_TEXT[result.journal] && <span className="font-sans">{t(JOURNAL_TEXT[result.journal])}</span>}
        </div>
      )}
      {running && <p className="m-0 text-xs text-muted-foreground">{t('env.noCancel')}</p>}
      {failed && error && <Refusal text={t('env.import.refused', { message: error.message })} action={error.action} />}
      <div className="flex flex-wrap justify-end gap-2">
        {(picking || plan || deciding) && <button type="button" onClick={onClose} className={button}>{t('cancel')}</button>}
        {picking && !failed && <button type="button" onClick={() => onPlan(form)} disabled={form.archive.trim() === ''} className={primary}>{t('env.import.read')}</button>}
        {plan && <button ref={confirm} type="button" onClick={onConfirm} className={primary}>{t('env.import.confirm')}</button>}
        {failed && <button ref={retry} type="button" onClick={onRetry} disabled={form.archive.trim() === ''} className={primary}>{t('env.retry')}</button>}
        {!picking && !plan && !deciding && <button type="button" onClick={onClose} className={button}>{t('close')}</button>}
      </div>
    </Modal>
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
  const agentId = soul.agentId;
  const clean = useEngineRun<SoulEnvironmentClean>(agentId, shown,
    useCallback(() => source.clean(agentId, { plan: true, components: null }), [source, agentId]),
    useCallback(() => source.clean(agentId, { plan: false, components: null }), [source, agentId]),
    reload);
  const complete = useEngineRun<EnvironmentMigration>(agentId, shown,
    useCallback(() => source.migrate(agentId, 'complete', null, true), [source, agentId]),
    useCallback(() => source.migrate(agentId, 'complete', null, false), [source, agentId]),
    reload);
  // The export's destination and the import's form live here with their
  // runs: a refusal about the path keeps what was typed for another try.
  const [exportTo, setExportTo] = useState(() => defaultExportPath(soul.name, soul.agentId));
  const exportLife = useEngineRun<SoulEnvironmentExport, { to: string | null }>(agentId, shown,
    useCallback(() => source.exportLife(agentId, { plan: true, to: null }), [source, agentId]),
    useCallback(({ to }: { to: string | null }) => source.exportLife(agentId, { plan: false, to }), [source, agentId]),
    reload);
  const [importForm, setImportForm] = useState<ImportForm>({ archive: '', identity: 'keep', name: '' });
  const importLife = useEngineRun<SoulEnvironmentImport, ImportForm>(agentId, shown,
    useCallback((form: ImportForm) => source.importLife(form.archive.trim(), { plan: true, identity: form.identity, name: form.name.trim() || null }), [source]),
    useCallback((form: ImportForm) => source.importLife(form.archive.trim(), { plan: false, identity: form.identity, name: form.name.trim() || null }), [source]),
    reload);
  const resetClean = clean.reset;
  const resetComplete = complete.reset;
  const resetExport = exportLife.reset;
  const resetImport = importLife.reset;
  useEffect(() => {
    shown.current = soul.agentId; setRun(null); setPlanOpen(false); setMigration(null); resetClean(); resetComplete(); resetExport(); resetImport();
    setExportTo(defaultExportPath(soul.name, soul.agentId)); setImportForm({ archive: '', identity: 'keep', name: '' });
  }, [soul.agentId, soul.name, resetClean, resetComplete, resetExport, resetImport]);
  const gated = [!actions?.export, !actions?.import, !actions?.clean];
  const gatedNote = !actions ? 'env.gated' : gated.every(Boolean) ? 'env.gated' : gated[0] && gated[1] ? 'env.gatedExport' : gated.some(Boolean) ? 'env.gatedList' : null;
  const gatedFeatures = [gated[0] ? t('env.export') : null, gated[1] ? t('env.import') : null, gated[2] ? t('env.cleanCache') : null].filter((f): f is string => f !== null).join(', ');

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
          {/* Capability-gated: the engine finishes every pending step at once (`migrate-complete`). */}
          {actions?.complete && (
            <div>
              <button ref={complete.trigger} type="button" aria-haspopup="dialog" className={button} onClick={() => complete.start()}>{t('env.complete')}</button>
            </div>
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

      {/* Each is live once the engine lists its capability (`env-export`, `env-import`, `env-clean`); the rest stay visible, disabled, with the gated copy. */}
      <div className="grid gap-1.5">
        <div className="flex flex-wrap gap-2">
          {actions?.export
            ? <button ref={exportLife.trigger} type="button" aria-haspopup="dialog" className={button} onClick={() => exportLife.start({ to: null })}>{t('env.exportLife')}</button>
            : <button type="button" disabled aria-describedby={`${ids}-gated`} className={button}>{t('env.export')}</button>}
          {actions?.import
            ? <button ref={importLife.trigger} type="button" aria-haspopup="dialog" className={button} onClick={importLife.show}>{t('env.importLife')}</button>
            : <button type="button" disabled aria-describedby={`${ids}-gated`} className={button}>{t('env.import')}</button>}
          {actions?.clean
            ? <button ref={clean.trigger} type="button" aria-haspopup="dialog" className={button} onClick={() => clean.start()}>{t('env.cleanCache')}</button>
            : <button type="button" disabled aria-describedby={`${ids}-gated`} className={button}>{t('env.cleanCache')}</button>}
        </div>
        {gatedNote && <p id={`${ids}-gated`} className="m-0 text-xs text-muted-foreground">{t(gatedNote, { features: gatedFeatures })}</p>}
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
      {clean.open && clean.run && (
        <CleanDialog name={name} run={clean.run} onClose={clean.close} onConfirm={() => { void clean.confirm(); }} onRetry={clean.retry} />
      )}
      {complete.open && complete.run && (
        <CompleteDialog name={name} run={complete.run} onClose={complete.close} onConfirm={() => { void complete.confirm(); }} onRetry={() => complete.retry()} />
      )}
      {exportLife.open && exportLife.run && (
        <ExportDialog name={name} run={exportLife.run} to={exportTo} onTo={setExportTo} onClose={exportLife.close}
          onConfirm={() => { void exportLife.confirm({ to: exportTo.trim() }); }} onRetry={() => exportLife.retry({ to: exportTo.trim() })} />
      )}
      {importLife.open && (
        <ImportDialog run={importLife.run} form={importForm} onForm={setImportForm} onClose={importLife.close}
          onPlan={(form) => { void importLife.plan(form); }} onConfirm={() => { void importLife.confirm(importForm); }} onRetry={() => importLife.retry(importForm)} />
      )}
    </section>
  );
}

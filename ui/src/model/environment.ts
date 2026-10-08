// The Environment section of a companion's Details (#268, design handoff):
// what the engine's descriptor (`soul env`, schema 1) says, reshaped for
// rows and buttons, and the install flow's step bookkeeping. Pure: every
// row traces to a descriptor field, nothing is read from the filesystem,
// and every button is gated on `engine.capabilities`, never a version.
import { engineCan, type RuntimeInstall, type SoulCleanRow, type SoulEnvironment, type SoulEnvironmentProblem, type SoulRetention } from '../bridge';

/**
 * The five states the handoff keeps distinct. `offline`: the engine did not
 * answer (no app, a failed run). `unsupported`: it answered, but not with a
 * schema-1 descriptor. `partial-errors`: a descriptor with `errors[]`, the
 * rest complete. `migration-required`: a migration step pending or
 * interrupted. `ready`: a complete descriptor (its readiness problems are
 * shown as such, never as loss).
 */
export type EnvironmentState = 'offline' | 'unsupported' | 'partial-errors' | 'migration-required' | 'ready';

/** What a read of the descriptor settled to: the descriptor, or why not. */
export interface EnvironmentRead {
  env: SoulEnvironment | null;
  error: { code: string; message: string } | null;
}

const MIGRATION_FINAL = new Set(['done', 'skipped']);

/** True when a migration step is still to do or stopped short (`failed`, a phase such as `copying`). */
export function migrationRequired(env: SoulEnvironment): boolean {
  return env.migration.status === 'pending' || env.migration.steps.some((step) => !MIGRATION_FINAL.has(step.status ?? ''));
}

export function environmentState(read: EnvironmentRead): EnvironmentState {
  if (read.error?.code === 'soul-env-unsupported') return 'unsupported';
  if (read.error || !read.env) return 'offline';
  if (read.env.errors.length > 0) return 'partial-errors';
  if (migrationRequired(read.env)) return 'migration-required';
  return 'ready';
}

/** One component row: classification and retention are independent dimensions, both shown. */
export interface ComponentRow {
  id: string;
  path: string | null;
  classification: string;
  retention: SoulRetention | null;
  present: boolean;
  /** How many entries the engine listed (skills, workflows, workspaces, ...); null when it lists none. */
  entries: number | null;
  /** How many paths a set-of-paths component (generated output) covers. */
  paths: number | null;
}

export function componentRows(env: SoulEnvironment): ComponentRow[] {
  return env.components.map((c) => ({
    id: c.id,
    path: c.path,
    classification: c.classification,
    retention: c.retention,
    present: c.present,
    entries: Array.isArray(c.entries) ? c.entries.length : null,
    paths: Array.isArray(c.paths) ? c.paths.length : null,
  }));
}

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** A runtime the descriptor lists as declared but not installed (`runtimes.missing[]`). */
export interface MissingRuntime {
  name: string;
  version: string | null;
  reason: string | null;
}

export function missingRuntimes(env: SoulEnvironment): MissingRuntime[] {
  return env.runtimes.missing.flatMap((row) => {
    const name = str(row.name);
    return name ? [{ name, version: str(row.version), reason: str(row.reason) }] : [];
  });
}

export type InstallableStatus = 'installed' | 'missing' | 'unsupported';

/** A harness or runtime: what is declared against what is installed, as the engine reports both. */
export interface InstallableRow {
  name: string;
  declared: string | null;
  installed: string | null;
  status: InstallableStatus;
  reason: string | null;
}

/** Harnesses the soul declares or has installed; the selected one first. */
export function harnessRows(env: SoulEnvironment): InstallableRow[] {
  const rows = new Map<string, InstallableRow>();
  const row = (name: string) => {
    let entry = rows.get(name);
    if (!entry) { entry = { name, declared: null, installed: null, status: 'missing', reason: null }; rows.set(name, entry); }
    return entry;
  };
  for (const h of env.harnesses.declared) { const name = str(h.name); if (name) row(name).declared = str(h.version) ?? '—'; }
  for (const h of env.harnesses.installed) {
    const name = str(h.name);
    if (!name) continue;
    const entry = row(name);
    entry.installed = str(h.version) ?? '—';
    entry.status = 'installed';
  }
  const list = [...rows.values()];
  const selected = env.harnesses.selected;
  return list.sort((a, b) => (a.name === selected ? -1 : b.name === selected ? 1 : a.name.localeCompare(b.name)));
}

/** Runtimes: declared versions against installed, missing and unsupported, as the engine lists each. */
export function runtimeRows(env: SoulEnvironment): InstallableRow[] {
  const rows = new Map<string, InstallableRow>();
  const row = (name: string) => {
    let entry = rows.get(name);
    if (!entry) { entry = { name, declared: null, installed: null, status: 'missing', reason: null }; rows.set(name, entry); }
    return entry;
  };
  for (const [name, declaration] of Object.entries(env.runtimes.declared)) {
    const version = declaration && typeof declaration === 'object' ? str((declaration as Record<string, unknown>).version) : str(declaration);
    row(name).declared = version ?? '—';
  }
  for (const r of env.runtimes.installed) {
    const name = str(r.name);
    if (!name) continue;
    const entry = row(name);
    entry.installed = str(r.version) ?? '—';
    entry.status = 'installed';
  }
  for (const r of env.runtimes.missing) {
    const name = str(r.name);
    if (!name) continue;
    const entry = row(name);
    entry.declared ??= str(r.version);
    entry.status = 'missing';
    entry.reason = str(r.reason);
  }
  for (const r of env.runtimes.unsupported) {
    const name = str(r.name);
    if (!name) continue;
    const entry = row(name);
    entry.declared ??= str(r.version);
    entry.status = 'unsupported';
    entry.reason = str(r.reason);
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The handoff's sign-in states; the engine says `present` / `missing` / `unknown` per tool home. */
export type SignInState = 'signed-in' | 'expired' | 'not-signed-in' | 'unknown';

/** A harness's sign-in as the soul's tool home and the host store hold it (existence only, never contents). */
export interface ToolSignIn {
  harness: string;
  signIn: SignInState;
  hostSignIn: SignInState;
  /** `soul` when the next launch routes the harness into the soul, else `shared-host`. */
  containment: string | null;
  hostPath: string | null;
}

function signInState(value: unknown): SignInState {
  switch (value) {
    case 'present': case 'signed-in': return 'signed-in';
    case 'missing': case 'signed-out': return 'not-signed-in';
    case 'expired': return 'expired';
    default: return 'unknown';
  }
}

export function toolSignIns(env: SoulEnvironment): ToolSignIn[] {
  const component = env.components.find((c) => c.id === 'tool-state');
  const entries = Array.isArray(component?.entries) ? component.entries : [];
  return entries.flatMap((entry): ToolSignIn[] => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    const harness = str(row.harness);
    return harness ? [{ harness, signIn: signInState(row.signIn), hostSignIn: signInState(row.hostSignIn), containment: str(row.containment), hostPath: str(row.hostPath) }] : [];
  });
}

/** Status only: a value never reaches the model, let alone the DOM. */
export type SecretStatus = 'set' | 'missing' | 'unknown';

export interface SecretRow {
  name: string;
  store: string | null;
  status: SecretStatus;
  usedBy: string[];
}

export function secretRows(env: SoulEnvironment): SecretRow[] {
  const list = Array.isArray(env.providers.secrets) ? env.providers.secrets : [];
  return list.flatMap((entry): SecretRow[] => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    const name = str(row.name);
    if (!name) return [];
    const status: SecretStatus = row.status === 'present' ? 'set' : row.status === 'missing' ? 'missing' : 'unknown';
    const usedBy = Array.isArray(row.usedBy) ? row.usedBy.filter((h): h is string => typeof h === 'string') : [];
    return [{ name, store: str(row.store), status, usedBy }];
  });
}

export interface ProviderRow {
  harness: string;
  id: string;
  name: string | null;
  /** `ready`, `secret-missing`, `unsupported`, as the engine says. */
  status: string | null;
  credential: string | null;
}

export function providerRows(env: SoulEnvironment): ProviderRow[] {
  const list = Array.isArray(env.providers.declared) ? env.providers.declared : [];
  return list.flatMap((entry): ProviderRow[] => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    const harness = str(row.harness);
    const id = str(row.id);
    return harness && id ? [{ harness, id, name: str(row.name), status: str(row.status), credential: str(row.credential) }] : [];
  });
}

/** Whether the soul's retained life travels with its folder, from the memory component and the migration steps. */
export type Continuity = 'ready' | 'needs-migration' | 'unavailable' | 'unsupported';

export function memoryContinuity(env: SoulEnvironment): Continuity {
  if (!engineCan(env, 'memory')) return 'unsupported';
  const memory = env.components.find((c) => c.id === 'memory');
  if (!memory || env.errors.some((e) => e.area === 'memory')) return 'unavailable';
  const space = env.migration.steps.find((s) => s.id === 'space-into-soul');
  if (memory.location === 'linked' || (space && !MIGRATION_FINAL.has(space.status ?? ''))) return 'needs-migration';
  if (memory.present && memory.location === 'inside') return 'ready';
  return 'unavailable';
}

export interface HistorySummary {
  mirrored: boolean | null;
  turns: number | null;
  revisions: number | null;
  external: { what: string; present: boolean }[];
}

/** The history component's counts, behind the `history` capability; null without it. */
export function historySummary(env: SoulEnvironment): HistorySummary | null {
  if (!engineCan(env, 'history')) return null;
  const history = env.components.find((c) => c.id === 'history');
  if (!history) return null;
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const external = Array.isArray(history.external) ? history.external.flatMap((e) => {
    const row = e && typeof e === 'object' ? (e as Record<string, unknown>) : null;
    const what = row ? str(row.what) : null;
    return what ? [{ what, present: row?.present === true }] : [];
  }) : [];
  return { mirrored: typeof history.mirrored === 'boolean' ? history.mirrored : null, turns: num(history.turns), revisions: num(history.revisions), external };
}

/** Readiness codes whose listed action is the engine's `soul runtimes install` (stable, appended never renamed). */
const INSTALL_CODES = new Set(['runtime-missing', 'runtime-download-failed', 'runtime-checksum-mismatch', 'runtime-install-failed']);

/**
 * The buttons the section may offer: each needs the engine's capability
 * and a readiness problem that lists the action; the displayed command
 * stays text otherwise.
 */
export interface EnvironmentActions {
  /** The runtimes "Review install plan" would install; null when the button stays hidden. */
  install: MissingRuntime[] | null;
  /** The harness "Use existing {harness} sign-in" adopts; null when hidden. */
  adopt: string | null;
  /** Whether "Migrate" (the Agent Space into the soul) is offered. */
  migrateSpace: boolean;
  /** Whether "Clean up cache" is live (`env-clean`): the engine plans and removes, the app shows. */
  clean: boolean;
  /** Whether "Complete migration" is offered (`migrate-complete` and a step still to finish). */
  complete: boolean;
}

const listed = (problems: SoulEnvironmentProblem[], match: (p: SoulEnvironmentProblem) => boolean) => problems.some((p) => p.action !== null && match(p));

/** The migration steps the descriptor lists as neither done nor skipped: what `--complete` would finish. */
export function pendingMigrationSteps(env: SoulEnvironment): SoulEnvironment['migration']['steps'] {
  return env.migration.steps.filter((step) => !MIGRATION_FINAL.has(step.status ?? ''));
}

export function environmentActions(env: SoulEnvironment): EnvironmentActions {
  const missing = missingRuntimes(env);
  const install = engineCan(env, 'runtimes') && missing.length > 0 && listed(env.readiness.problems, (p) => INSTALL_CODES.has(p.code)) ? missing : null;
  const adopt = engineCan(env, 'tool-homes') && listed(env.readiness.problems, (p) => p.code === 'tool-signin-missing') ? env.harnesses.selected : null;
  const migrateSpace = engineCan(env, 'memory') && listed(env.readiness.problems, (p) => p.code === 'memory-not-contained');
  const clean = engineCan(env, 'env-clean');
  const complete = engineCan(env, 'migrate-complete') && pendingMigrationSteps(env).length > 0;
  return { install, adopt, migrateSpace, clean, complete };
}

/**
 * An engine refusal as the dialogs show it: the code, the message, and the
 * command the engine names (`agent-bot soul stop <id>` for `soul-running`),
 * which is shown as text and never run by the app.
 */
export interface EngineRefusal {
  code: string;
  message: string;
  action: string | null;
}

export function refusalOf(failure: unknown): EngineRefusal {
  const e = failure as { code?: unknown; message?: unknown; action?: unknown };
  return {
    code: typeof e?.code === 'string' ? e.code : 'failed',
    message: typeof e?.message === 'string' ? e.message : String(failure),
    action: typeof e?.action === 'string' && e.action.trim() !== '' ? e.action : null,
  };
}

/**
 * One plan-then-apply run against the engine (a clean, a migration
 * completion): the plan is read first and reviewed, nothing runs until
 * the owner confirms, and the result or the engine's refusal lands as it
 * came. The run outlives its dialog: closing an in-progress view hides
 * it without stopping the engine.
 */
export interface EngineRun<T> {
  phase: 'planning' | 'plan' | 'running' | 'finished';
  plan: T | null;
  result: T | null;
  error: EngineRefusal | null;
}

/** Sizes as the engine counts them (bytes), rounded for a line of text; the engine's number is the source. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** A clean's rows grouped by the component they belong to, with that group's counts summed from the rows. */
export interface CleanGroup {
  component: string;
  rows: SoulCleanRow[];
  files: number;
  bytes: number;
}

export function cleanGroups(rows: readonly SoulCleanRow[]): CleanGroup[] {
  const groups = new Map<string, CleanGroup>();
  for (const row of rows) {
    let group = groups.get(row.component);
    if (!group) { group = { component: row.component, rows: [], files: 0, bytes: 0 }; groups.set(row.component, group); }
    group.rows.push(row);
    group.files += row.files ?? 0;
    group.bytes += row.bytes ?? 0;
  }
  return [...groups.values()];
}

/** The handoff's step states for a migration step, from the engine's status word; anything else is shown as the engine said it. */
export type MigrationStepStatus = 'completed' | 'failed' | 'not-started' | 'skipped' | 'other';

export function migrationStepStatus(status: string | null): MigrationStepStatus {
  switch (status) {
    case 'done': return 'completed';
    case 'failed': return 'failed';
    case 'skipped': return 'skipped';
    case 'pending': return 'not-started';
    default: return 'other';
  }
}

/** The handoff's step states: completed / failed / not started / result unknown, plus the one running. */
export type StepStatus = 'not-started' | 'running' | 'completed' | 'failed' | 'unknown';

export interface InstallStep {
  runtime: string;
  version: string | null;
  status: StepStatus;
  /** The engine's message for a failure; null otherwise. */
  message: string | null;
}

/**
 * One install run: the plan the owner reviews, then one engine call per
 * runtime, in order. There is no engine cancel, so a run never carries a
 * cancelled step; a step that failed stops the run, the rest stay not
 * started, and nothing is rolled back or claimed to be.
 */
export interface InstallRun {
  phase: 'plan' | 'running' | 'finished';
  steps: InstallStep[];
  /** The step in flight, by index. */
  current: number | null;
  /** The engine's `ready` from its last report; null until it said. */
  ready: boolean | null;
}

export type InstallOutcome = 'completed' | 'failed' | 'unknown';

export type InstallEvent =
  | { type: 'begin'; index: number }
  | { type: 'finish'; index: number; outcome: InstallOutcome; message: string | null; ready: boolean | null }
  | { type: 'retry' };

export function planInstall(missing: readonly MissingRuntime[]): InstallRun {
  return { phase: 'plan', steps: missing.map((m) => ({ runtime: m.name, version: m.version, status: 'not-started', message: null })), current: null, ready: null };
}

/** The first step still to run, or null. */
export function nextStep(run: InstallRun): number | null {
  const index = run.steps.findIndex((s) => s.status === 'not-started');
  return index === -1 ? null : index;
}

export function installReducer(run: InstallRun, event: InstallEvent): InstallRun {
  switch (event.type) {
    case 'begin': {
      const steps = run.steps.map((s, i) => (i === event.index ? { ...s, status: 'running' as const, message: null } : s));
      return { ...run, phase: 'running', steps, current: event.index };
    }
    case 'finish': {
      const steps = run.steps.map((s, i) => (i === event.index ? { ...s, status: event.outcome, message: event.message } : s));
      const ready = event.ready ?? run.ready;
      const more = event.outcome === 'completed' && steps.some((s) => s.status === 'not-started');
      return { ...run, phase: more ? 'running' : 'finished', steps, current: null, ready };
    }
    case 'retry': {
      // Retry re-runs the step that failed (or ended unknown) and whatever never started.
      const steps = run.steps.map((s) => (s.status === 'failed' || s.status === 'unknown' ? { ...s, status: 'not-started' as const, message: null } : s));
      return { ...run, phase: 'running', steps, current: null };
    }
    default:
      return run;
  }
}

/** Steps run from 1 for the progress line. */
export function installProgress(run: InstallRun): { step: number; total: number } | null {
  return run.current === null ? null : { step: run.current + 1, total: run.steps.length };
}

export type InstallSummary = 'success' | 'done-not-ready' | 'failure' | 'unknown';

/** What a finished run amounts to; a success is claimed only when the engine reported `ready`. */
export function installSummary(run: InstallRun): InstallSummary | null {
  if (run.phase !== 'finished') return null;
  if (run.steps.some((s) => s.status === 'failed')) return 'failure';
  if (run.steps.some((s) => s.status === 'unknown' || s.status === 'not-started' || s.status === 'running')) return 'unknown';
  return run.ready === true ? 'success' : run.ready === false ? 'done-not-ready' : 'unknown';
}

/** The failed step, for the failure line. */
export function failedStep(run: InstallRun): InstallStep | null {
  return run.steps.find((s) => s.status === 'failed') ?? null;
}

/**
 * How one `soul runtimes install --runtime NAME` ended for that runtime,
 * from the engine's report alone: listed as installed or skipped (already
 * there) is completed; its row's last error is a failure; anything else
 * is unknown, never assumed.
 */
export function installOutcome(result: RuntimeInstall, runtime: string): { outcome: InstallOutcome; message: string | null } {
  if (result.installed.includes(runtime) || result.skipped.includes(runtime)) return { outcome: 'completed', message: null };
  const row = [...result.runtimes, ...result.harnesses].find((r) => r.name === runtime);
  if (row?.status === 'installed') return { outcome: 'completed', message: null };
  if (row?.lastError) return { outcome: 'failed', message: row.lastError.message };
  return { outcome: 'unknown', message: null };
}

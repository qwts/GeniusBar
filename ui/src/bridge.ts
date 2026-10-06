// The web view's only path to agent-comms: the shell relays each call to
// the Node bridge (#7), which holds the principal credential.
import { invoke } from '@tauri-apps/api/core';
import { normalizeAudit, type AuditRecord } from './model/audit';
import { normalizeApproval, normalizeApprovals, normalizeAsides, type ApprovalRecord, type AsideRecord } from './model/chat';

export type BridgeMethod = 'census' | 'send' | 'inbox' | 'ack' | 'launch' | 'launchStatus';

/** An error from the bridge, the shell, or agent-comms, with its stable code. */
export class BridgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

/** True inside the Tauri app; false in a plain browser or a test. */
export const inApp = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface RuntimeObservation {
  metric: string;
  value: string | number;
  unit: string | null;
  scope: string;
  source: string;
  kind: 'reported' | 'configured';
  method?: string;
  observedAt: string;
}

export type RuntimeMetrics = { unavailable: true } | {
  collectedAt: string | null;
  souls: Record<string, { lastCallAt: string | null; observations: RuntimeObservation[] }>;
  errors: { agentId: string; source: string; code: string; message: string }[];
  missing: { agentId: string; source: string }[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isObservation = (value: unknown): value is RuntimeObservation => isRecord(value)
  && typeof value.metric === 'string' && (typeof value.value === 'string' || typeof value.value === 'number')
  && typeof value.source === 'string' && typeof value.observedAt === 'string';

/** Keeps only well-formed entries, so a malformed collector line can't break the view. */
export function normalizeRuntimeMetrics(raw: unknown): RuntimeMetrics {
  if (!isRecord(raw) || !isRecord(raw.souls) || !Array.isArray(raw.errors) || !Array.isArray(raw.missing)) {
    return { unavailable: true };
  }
  const souls: Record<string, { lastCallAt: string | null; observations: RuntimeObservation[] }> = {};
  for (const [agentId, soul] of Object.entries(raw.souls)) {
    if (!isRecord(soul) || !Array.isArray(soul.observations)) continue;
    souls[agentId] = {
      lastCallAt: typeof soul.lastCallAt === 'string' ? soul.lastCallAt : null,
      observations: soul.observations.filter(isObservation),
    };
  }
  const named = (value: unknown): value is Record<string, unknown> & { agentId: string; source: string } =>
    isRecord(value) && typeof value.agentId === 'string' && typeof value.source === 'string';
  return {
    collectedAt: typeof raw.collectedAt === 'string' ? raw.collectedAt : null,
    souls,
    errors: raw.errors.filter(named).map((error) => ({
      agentId: error.agentId, source: error.source,
      code: typeof error.code === 'string' ? error.code : 'unknown',
      message: typeof error.message === 'string' ? error.message : '',
    })),
    missing: raw.missing.filter(named).map(({ agentId, source }) => ({ agentId, source })),
  };
}

export async function runtimeMetrics(): Promise<RuntimeMetrics> {
  if (!inApp()) return { unavailable: true };
  try {
    return normalizeRuntimeMetrics(await invoke<unknown>('runtime_metrics'));
  } catch {
    return { unavailable: true };
  }
}

/**
 * A soul's managed and agent-comms state (#71), as agent-bot reports it.
 * `running` souls keep their setting until stopped; agent-bot enforces that.
 */
export interface SoulComms {
  agentId: string;
  managed: boolean;
  comms: boolean;
  running: boolean;
}

export function normalizeSoulComms(raw: unknown): SoulComms | null {
  if (!isRecord(raw) || typeof raw.agentId !== 'string' || typeof raw.comms !== 'boolean'
    || typeof raw.managed !== 'boolean' || typeof raw.running !== 'boolean') return null;
  return { agentId: raw.agentId, managed: raw.managed, comms: raw.comms, running: raw.running };
}

/** The soul's state, or null when agent-bot cannot say (an older bundle, another host's soul). */
export async function soulComms(agentId: string, invokeImpl: typeof invoke = invoke): Promise<SoulComms | null> {
  if (!inApp() && invokeImpl === invoke) return null;
  try {
    return normalizeSoulComms(await invokeImpl<unknown>('soul_comms', { action: 'show', soul: agentId }));
  } catch {
    return null;
  }
}

/** Turns agent comms on or off; agent-bot asks the owner and refuses while the soul runs. */
export async function setSoulComms(agentId: string, comms: boolean, invokeImpl: typeof invoke = invoke): Promise<SoulComms> {
  let raw: unknown;
  try {
    raw = await invokeImpl<unknown>('soul_comms', { action: comms ? 'on' : 'off', soul: agentId });
  } catch (error) {
    const e = error as { code?: unknown; message?: unknown };
    throw new BridgeError(typeof e?.code === 'string' ? e.code : 'soul-comms-failed',
      typeof e?.message === 'string' ? e.message : String(error));
  }
  const state = normalizeSoulComms(raw);
  if (!state) throw new BridgeError('soul-comms-failed', 'agent-bot gave no comms state');
  return state;
}

/**
 * A soul's cold-wake setting (#122, "Wake on new messages"), from
 * `soul cold-wake <agentId> show --json`. `on` is any wake lane (an ACP
 * turn, a resumed session, a webhook); `lane` names it, null when off.
 */
export interface SoulColdWake {
  on: boolean;
  lane: string | null;
}

export function normalizeSoulColdWake(raw: unknown): SoulColdWake | null {
  if (!isRecord(raw)) return null;
  const lane = typeof raw.lane === 'string' && raw.lane !== '' ? raw.lane : null;
  const { setting } = raw;
  // agent-bot 0.10.14 says 'on' | 'off' | 'resume' | 'webhook'; the stored
  // shape (true, false or a lane object) is accepted too.
  if (typeof setting === 'string') return { on: lane !== null || setting !== 'off', lane };
  if (typeof setting === 'boolean') return { on: setting || lane !== null, lane: lane ?? (setting ? 'acp' : null) };
  if (isRecord(setting)) return { on: true, lane: lane ?? (typeof setting.lane === 'string' ? setting.lane : null) };
  if (setting === null || setting === undefined) return lane === null ? null : { on: true, lane };
  return null;
}

/** The soul's wake setting, or null when agent-bot cannot say (outside the app, an older bundle, a refusal). */
export async function soulColdWake(agentId: string, invokeImpl: typeof invoke = invoke): Promise<SoulColdWake | null> {
  if (!inApp() && invokeImpl === invoke) return null;
  try {
    return normalizeSoulColdWake(await invokeImpl<unknown>('soul_cold_wake', { agent: agentId, action: 'show' }));
  } catch {
    return null;
  }
}

/**
 * Turns waking on new messages on or off. agent-bot asks the owner (its
 * consent dialog, Touch ID); a refusal rejects with its reason, and the
 * setting stays as it was.
 */
export async function setSoulColdWake(agentId: string, on: boolean, invokeImpl: typeof invoke = invoke): Promise<SoulColdWake> {
  let raw: unknown;
  try {
    raw = await invokeImpl<unknown>('soul_cold_wake', { agent: agentId, action: on ? 'on' : 'off' });
  } catch (error) {
    const e = error as { code?: unknown; message?: unknown };
    throw new BridgeError(typeof e?.code === 'string' ? e.code : 'cold-wake-failed',
      typeof e?.message === 'string' ? e.message : String(error));
  }
  const state = normalizeSoulColdWake(raw);
  if (!state) throw new BridgeError('cold-wake-failed', 'agent-bot gave no wake setting');
  return state;
}

/**
 * A soul's execution mode (#122, Lovable "Execution mode"), from `soul mode
 * <agentId> show --json`. In Safe Mode risky and external tool calls wait
 * for the owner's approval; in Auto-Pilot every call runs without asking.
 */
export type SoulMode = 'safe' | 'autopilot';

export function normalizeSoulMode(raw: unknown): SoulMode | null {
  if (!isRecord(raw)) return null;
  return raw.mode === 'safe' || raw.mode === 'autopilot' ? raw.mode : null;
}

/** The soul's execution mode, or null when agent-bot cannot say (outside the app, an older bundle, a refusal). */
export async function soulMode(agentId: string, invokeImpl: typeof invoke = invoke): Promise<SoulMode | null> {
  if (!inApp() && invokeImpl === invoke) return null;
  try {
    return normalizeSoulMode(await invokeImpl<unknown>('soul_mode', { agent: agentId, action: 'show' }));
  } catch {
    return null;
  }
}

/**
 * Switches the soul to Safe Mode or Auto-Pilot. agent-bot asks the owner
 * (its consent dialog, Touch ID) and applies the mode on the soul's next
 * permission request; a refusal rejects with its reason, and the mode
 * stays as it was.
 */
export async function setSoulMode(agentId: string, mode: SoulMode, invokeImpl: typeof invoke = invoke): Promise<SoulMode> {
  let raw: unknown;
  try {
    raw = await invokeImpl<unknown>('soul_mode', { agent: agentId, action: mode });
  } catch (error) {
    const e = error as { code?: unknown; message?: unknown };
    throw new BridgeError(typeof e?.code === 'string' ? e.code : 'soul-mode-failed',
      typeof e?.message === 'string' ? e.message : String(error));
  }
  const state = normalizeSoulMode(raw);
  if (!state) throw new BridgeError('soul-mode-failed', 'agent-bot gave no execution mode');
  return state;
}

/** One entry of the harness's own model list, as agent-bot cached it. */
export interface ModelChoice {
  modelId: string;
  name: string;
  description: string | null;
}

/**
 * A soul's model (#128), from `soul model <agentId> show --json`. `model` is
 * the owner's choice, null for the harness default; `available` is the
 * harness's own list, null until the soul's first turn lists it.
 */
export interface SoulModel {
  model: string | null;
  available: ModelChoice[] | null;
  listedAt: string | null;
}

export function normalizeSoulModel(raw: unknown): SoulModel | null {
  if (!isRecord(raw) || !('model' in raw)) return null;
  if (raw.model !== null && (typeof raw.model !== 'string' || raw.model === '')) return null;
  const available = Array.isArray(raw.available)
    ? raw.available.filter((m): m is Record<string, unknown> & { modelId: string } =>
      isRecord(m) && typeof m.modelId === 'string' && m.modelId !== '').map((m) => ({
      modelId: m.modelId,
      name: typeof m.name === 'string' && m.name.trim() !== '' ? m.name : m.modelId,
      description: typeof m.description === 'string' && m.description !== '' ? m.description : null,
    }))
    : null;
  return { model: raw.model, available, listedAt: typeof raw.listedAt === 'string' ? raw.listedAt : null };
}

/** The soul's model, or null when agent-bot cannot say (outside the app, an older bundle, a refusal). */
export async function soulModel(agentId: string, invokeImpl: typeof invoke = invoke): Promise<SoulModel | null> {
  if (!inApp() && invokeImpl === invoke) return null;
  try {
    return normalizeSoulModel(await invokeImpl<unknown>('soul_model', { agent: agentId, action: 'show' }));
  } catch {
    return null;
  }
}

/**
 * Sets the soul's model, or (null) returns it to the harness default.
 * agent-bot asks the owner (its consent dialog, Touch ID) and the daemon
 * applies it on the soul's next turn; a refusal rejects with its reason.
 */
export async function setSoulModel(agentId: string, model: string | null, invokeImpl: typeof invoke = invoke): Promise<SoulModel> {
  let raw: unknown;
  try {
    raw = await invokeImpl<unknown>('soul_model', model === null
      ? { agent: agentId, action: 'clear' }
      : { agent: agentId, action: 'set', model });
  } catch (error) {
    const e = error as { code?: unknown; message?: unknown };
    throw new BridgeError(typeof e?.code === 'string' ? e.code : 'soul-model-failed',
      typeof e?.message === 'string' ? e.message : String(error));
  }
  const state = normalizeSoulModel(raw);
  if (!state) throw new BridgeError('soul-model-failed', 'agent-bot gave no model setting');
  return state;
}

/** A harness sign-in a daemon turn found missing or expired (#84). */
export interface HarnessAuthFailure {
  status: 'signed-out' | 'expired';
  harness: string;
  since: string | null;
}

/**
 * What agent-bot's population census keeps about a soul that the broker's
 * census does not (#122): its GitHub App slug (null when it joined without
 * one) and a failed harness sign-in (null when none is recorded).
 */
export interface SoulPopulation {
  agentId: string;
  appSlug: string | null;
  harnessAuth: HarnessAuthFailure | null;
}

export function normalizeSoulPopulation(raw: unknown): SoulPopulation | null {
  if (!isRecord(raw) || typeof raw.agentId !== 'string') return null;
  const auth = raw.harnessAuth;
  const harnessAuth: HarnessAuthFailure | null = isRecord(auth) && (auth.status === 'signed-out' || auth.status === 'expired')
    && typeof auth.harness === 'string' && auth.harness !== ''
    ? { status: auth.status as HarnessAuthFailure['status'], harness: auth.harness, since: typeof auth.since === 'string' ? auth.since : null }
    : null;
  return {
    agentId: raw.agentId,
    appSlug: typeof raw.appSlug === 'string' && raw.appSlug !== '' ? raw.appSlug : null,
    harnessAuth,
  };
}

/** The soul's census record, or null when agent-bot cannot say. */
export async function soulPopulation(agentId: string, invokeImpl: typeof invoke = invoke): Promise<SoulPopulation | null> {
  if (!inApp() && invokeImpl === invoke) return null;
  try {
    return normalizeSoulPopulation(await invokeImpl<unknown>('soul_population', { agent: agentId }));
  } catch {
    return null;
  }
}

/**
 * Whether the soul's harness is signed in (`harness auth status H --soul ID`,
 * ADR-0276); null when agent-bot cannot say.
 */
export async function harnessSignedIn(harness: string, agentId: string, invokeImpl: typeof invoke = invoke): Promise<boolean | null> {
  if (!inApp() && invokeImpl === invoke) return null;
  try {
    const raw = await invokeImpl<unknown>('harness_auth', { action: 'status', harness, soul: agentId });
    return isRecord(raw) && typeof raw.loggedIn === 'boolean' ? raw.loggedIn : null;
  } catch {
    return null;
  }
}

/**
 * Runs the harness's own sign-in for the soul (`harness auth login H --soul
 * ID`; it may open a browser). A signed-in harness clears the recorded
 * failure in agent-bot. Rejects with agent-bot's reason.
 */
export async function harnessSignIn(harness: string, agentId: string, invokeImpl: typeof invoke = invoke): Promise<boolean> {
  let raw: unknown;
  try {
    raw = await invokeImpl<unknown>('harness_auth', { action: 'login', harness, soul: agentId });
  } catch (error) {
    const e = error as { code?: unknown; message?: unknown };
    throw new BridgeError(typeof e?.code === 'string' ? e.code : 'harness-auth-failed',
      typeof e?.message === 'string' ? e.message : String(error));
  }
  if (!isRecord(raw) || typeof raw.loggedIn !== 'boolean') throw new BridgeError('harness-auth-failed', 'agent-bot gave no sign-in state');
  return raw.loggedIn;
}

/**
 * A page of a soul's asides from agent-bot (`soul asides --json`, #122),
 * oldest first after `after`; null when agent-bot cannot say (outside the
 * app, an older bundle, a refusal).
 */
export async function soulAsides(agentId: string, after: string | null, invokeImpl: typeof invoke = invoke):
  Promise<{ asides: AsideRecord[]; next: string | null } | null> {
  if (!inApp() && invokeImpl === invoke) return null;
  try {
    return normalizeAsides(await invokeImpl<unknown>('soul_asides', { soul: agentId, after }));
  } catch {
    return null;
  }
}

/** Tool calls waiting on the owner (`approvals list --json`, #85); null when agent-bot cannot say. */
export async function listApprovals(invokeImpl: typeof invoke = invoke): Promise<ApprovalRecord[] | null> {
  if (!inApp() && invokeImpl === invoke) return null;
  try {
    return normalizeApprovals(await invokeImpl<unknown>('approvals', { action: 'list' }));
  } catch {
    return null;
  }
}

/**
 * The audit log (`audit list --json`, #122), newest last, for one soul or
 * (null) the whole fleet; null when agent-bot cannot say (outside the app,
 * an older bundle without the command, a refusal).
 */
export async function listAudit(agentId: string | null, invokeImpl: typeof invoke = invoke): Promise<AuditRecord[] | null> {
  if (!inApp() && invokeImpl === invoke) return null;
  try {
    return normalizeAudit(await invokeImpl<unknown>('audit_list', { agent: agentId }));
  } catch {
    return null;
  }
}

/**
 * Approves or denies one proposal (#86). The daemon asks the owner to
 * confirm (Touch ID) before the decision lands; GeniusBar never asks itself.
 */
export async function decideApproval(proposalId: string, decision: 'approve' | 'deny',
  invokeImpl: typeof invoke = invoke): Promise<ApprovalRecord> {
  let raw: unknown;
  try {
    raw = await invokeImpl<unknown>('approvals', { action: decision, proposal: proposalId });
  } catch (error) {
    const e = error as { code?: unknown; message?: unknown };
    throw new BridgeError(typeof e?.code === 'string' ? e.code : 'approvals-failed',
      typeof e?.message === 'string' ? e.message : String(error));
  }
  const decided = normalizeApproval(raw);
  if (!decided) throw new BridgeError('approvals-failed', 'agent-bot gave no decision');
  return decided;
}

/**
 * What `agent-bot soul remove <agentId> --json` reports (GeniusBar #94):
 * the soul stopped waking, left agent-comms (or says why not), is retired,
 * and its folders moved to the souls folder's `.archive`. Nothing is deleted.
 */
export interface RemovedSoul {
  agentId: string;
  name: string | null;
  /** 'left', or 'not left: <reason>' when the hub could not be told yet. */
  comms: string;
  archived: { from: string; to: string }[];
}

export function normalizeRemovedSoul(raw: unknown): RemovedSoul | null {
  if (!isRecord(raw) || typeof raw.agentId !== 'string' || raw.retired !== true) return null;
  return {
    agentId: raw.agentId,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : null,
    comms: typeof raw.comms === 'string' ? raw.comms : 'left',
    archived: Array.isArray(raw.archived)
      ? raw.archived.filter((a): a is { from: string; to: string } => isRecord(a) && typeof a.from === 'string' && typeof a.to === 'string')
        .map(({ from, to }) => ({ from, to }))
      : [],
  };
}

/**
 * Archives a soul. agent-bot refuses while it runs (`soul-running`) and asks
 * the owner (its consent dialog, Touch ID); a refusal rejects with its
 * reason, and the soul stays.
 */
export async function removeSoul(agentId: string, invokeImpl: typeof invoke = invoke): Promise<RemovedSoul> {
  let raw: unknown;
  try {
    raw = await invokeImpl<unknown>('soul_remove', { agent: agentId });
  } catch (error) {
    const e = error as { code?: unknown; message?: unknown };
    throw new BridgeError(typeof e?.code === 'string' ? e.code : 'soul-remove-failed',
      typeof e?.message === 'string' ? e.message : String(error));
  }
  const removed = normalizeRemovedSoul(raw);
  if (!removed) throw new BridgeError('soul-remove-failed', 'agent-bot did not archive the companion');
  return removed;
}

/** The daemon as `agent-bot daemon status --json` reports it, for the desktop's badges (#122). */
export interface DaemonStatus {
  running: boolean;
  /** Souls driving the screen right now. */
  computerUse: { agentId: string; since: string | null }[];
}

export function normalizeDaemonStatus(raw: unknown): DaemonStatus | null {
  if (!isRecord(raw) || typeof raw.running !== 'boolean') return null;
  return {
    running: raw.running,
    computerUse: Array.isArray(raw.computerUse)
      ? raw.computerUse.filter((c): c is Record<string, unknown> & { agentId: string } => isRecord(c) && typeof c.agentId === 'string' && c.agentId !== '')
        .map((c) => ({ agentId: c.agentId, since: typeof c.since === 'string' ? c.since : null }))
      : [],
  };
}

/** The daemon's status, or null when agent-bot cannot say (outside the app, an older bundle). */
export async function daemonStatus(invokeImpl: typeof invoke = invoke): Promise<DaemonStatus | null> {
  if (!inApp() && invokeImpl === invoke) return null;
  try {
    return normalizeDaemonStatus(await invokeImpl<unknown>('daemon_status'));
  } catch {
    return null;
  }
}

/** Which of GeniusBar's login services are registered (#118), from `services_installed`. */
export interface ServicesInstalled {
  broker: boolean;
  daemon: boolean;
}

/**
 * Whether GeniusBar's services are installed, so a silent broker after
 * login reads as "starting" rather than "needs setup" (#118). Null when
 * the shell cannot say (outside the app, a failed call).
 */
export async function servicesInstalled(invokeImpl: typeof invoke = invoke): Promise<ServicesInstalled | null> {
  if (!inApp() && invokeImpl === invoke) return null;
  try {
    const raw = await invokeImpl<unknown>('services_installed');
    if (!isRecord(raw)) return null;
    return { broker: raw.broker === true, daemon: raw.daemon === true };
  } catch {
    return null;
  }
}

export async function call<T>(method: BridgeMethod, params: Record<string, unknown> = {},
  invokeImpl: typeof invoke = invoke): Promise<T> {
  try {
    return await invokeImpl<T>('bridge', { method, params });
  } catch (error) {
    const e = error as { code?: unknown; message?: unknown };
    throw new BridgeError(typeof e?.code === 'string' ? e.code : 'bridge-error',
      typeof e?.message === 'string' ? e.message : String(error));
  }
}

/** One soul's row of `population_list` (#137): its agent-comms and managed state. */
export interface PopulationEntry {
  agentId: string;
  comms: boolean;
  managed: boolean;
}

/**
 * Normalizes `population_list`. Records without an agent id are dropped; a
 * record without a boolean `comms` (an agent-bot from before the field) is
 * dropped too, so it shows no badge, and `managed` defaults to false as
 * agent-bot reads such rows. Null when the reply is not a list.
 */
export function normalizePopulationList(raw: unknown): PopulationEntry[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.flatMap((r): PopulationEntry[] => (isRecord(r) && typeof r.agentId === 'string' && r.agentId !== ''
    && typeof r.comms === 'boolean'
    ? [{ agentId: r.agentId, comms: r.comms, managed: r.managed === true }]
    : []));
}

/**
 * Every soul's comms and managed state in one agent-bot run (#137). Null
 * outside the app, with an older bundle that has no `population_list`, or
 * when agent-bot cannot say, so callers can fall back to `soulComms`.
 */
export async function populationList(invokeImpl: typeof invoke = invoke): Promise<PopulationEntry[] | null> {
  if (!inApp() && invokeImpl === invoke) return null;
  try {
    return normalizePopulationList(await invokeImpl<unknown>('population_list'));
  } catch {
    return null;
  }
}

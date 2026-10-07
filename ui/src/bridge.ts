// The web view's only path to agent-comms: the shell relays each call to
// the Node bridge (#7), which holds the principal credential.
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow, LogicalSize, Window } from '@tauri-apps/api/window';
import { normalizeAudit, type AuditRecord } from './model/audit';
import type { QueryTab, WindowSurface } from './model/surface';
import { normalizeApproval, normalizeApprovals, normalizeAsides, type ApprovalRecord, type AsideRecord } from './model/chat';

export type BridgeMethod = 'census' | 'send' | 'inbox' | 'ack' | 'launch' | 'launchStatus' | 'auditExport';

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

/** A soul's declared look (soul.json `appearance`): its Dudle's hue in degrees, an integer 0..359. */
export interface SoulAppearance {
  hue: number;
}

/**
 * The declared appearance, or undefined when there is none or it is not a
 * whole hue in 0..359 (an older bundle sends none; the Dudle then derives
 * its hue from the agent ID).
 */
export function normalizeAppearance(raw: unknown): SoulAppearance | undefined {
  if (!isRecord(raw)) return undefined;
  const hue = raw.hue;
  return typeof hue === 'number' && Number.isInteger(hue) && hue >= 0 && hue <= 359 ? { hue } : undefined;
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
  /**
   * The owner's computer-use switch (agent-bot-identity #482); absent from a
   * bundle without the field. Optional so older fixtures still type.
   */
  computerUse?: boolean;
  /**
   * The brief the soul's last launch saved (#120, agent-bot-identity #502);
   * absent when it has none or the bundle predates it.
   */
  brief?: string;
  /** The soul's declared look; absent when it declares none or the bundle predates it. */
  appearance?: SoulAppearance;
  /**
   * The soul's declared role (soul.json `role`, agent-bot-identity #535);
   * absent when it declares none or the bundle predates it.
   */
  role?: string | null;
  /** agent-bot's role line (the role, else "Lead" and the subagent count); absent from older bundles. */
  roleLine?: string | null;
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
    ...(typeof raw.computerUse === 'boolean' ? { computerUse: raw.computerUse } : {}),
    ...(typeof raw.brief === 'string' && raw.brief.trim() !== '' ? { brief: raw.brief } : {}),
    ...withAppearance(raw.appearance),
    ...withRole(raw),
  };
}

/**
 * The declared role and agent-bot's role line (agent-bot-identity #535),
 * each only when it is nonempty text, so rows from older bundles keep
 * their shape.
 */
function withRole(raw: Record<string, unknown>): { role?: string; roleLine?: string } {
  const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
  const role = text(raw.role);
  const roleLine = text(raw.roleLine);
  return { ...(role ? { role } : {}), ...(roleLine ? { roleLine } : {}) };
}

function withAppearance(raw: unknown): { appearance?: SoulAppearance } {
  const appearance = normalizeAppearance(raw);
  return appearance ? { appearance } : {};
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
 * The brief a soul's last launch saved (#120), for the launch dialog to
 * prefill on relaunch; null when it has none. Rejects when agent-bot cannot
 * say, so the dialog can tell "none" from "unknown".
 */
export async function savedBrief(agentId: string, invokeImpl: typeof invoke = invoke): Promise<string | null> {
  if (!inApp() && invokeImpl === invoke) return null;
  return normalizeSoulPopulation(await invokeImpl<unknown>('soul_population', { agent: agentId }))?.brief ?? null;
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
 * Saves the audit log as a file (Lovable `AuditLog` Export JSON). In the app
 * the bridge writes ~/Downloads/geniusbar-audit-<time>.json and says where;
 * in a plain browser (the preview) it downloads through a Blob link, as the
 * design does. Throws a BridgeError when the save fails.
 */
export async function exportAudit(contents: string, invokeImpl: typeof invoke = invoke): Promise<{ path: string | null }> {
  if (!inApp() && invokeImpl === invoke) {
    const blob = new Blob([contents], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `geniusbar-audit-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    return { path: null };
  }
  const result = await call<{ path?: unknown }>('auditExport', { contents }, invokeImpl);
  return { path: typeof result?.path === 'string' ? result.path : null };
}

/** How far an approval reaches: this call only, or the soul's current harness session. */
export type ApprovalScope = 'once' | 'session';

/**
 * Approves or denies one proposal (#86). The daemon asks the owner to
 * confirm (Touch ID) before the decision lands; GeniusBar never asks itself.
 * `scope: 'session'` (approve only, agent-bot-identity #486) also lets the
 * soul use that tool for the rest of its harness session; an older bundle
 * refuses it with `approval-scope-unsupported` and decides nothing.
 */
export async function decideApproval(proposalId: string, decision: 'approve' | 'deny',
  { scope }: { scope?: ApprovalScope } = {}, invokeImpl: typeof invoke = invoke): Promise<ApprovalRecord> {
  let raw: unknown;
  try {
    raw = await invokeImpl<unknown>('approvals',
      { action: decision, proposal: proposalId, ...(scope === 'session' ? { scope } : {}) });
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
  /** Souls with a turn in flight; absent from an older bundle. */
  busy?: string[];
}

export function normalizeDaemonStatus(raw: unknown): DaemonStatus | null {
  if (!isRecord(raw) || typeof raw.running !== 'boolean') return null;
  return {
    running: raw.running,
    computerUse: Array.isArray(raw.computerUse)
      ? raw.computerUse.filter((c): c is Record<string, unknown> & { agentId: string } => isRecord(c) && typeof c.agentId === 'string' && c.agentId !== '')
        .map((c) => ({ agentId: c.agentId, since: typeof c.since === 'string' ? c.since : null }))
      : [],
    ...(Array.isArray(raw.busy) ? { busy: raw.busy.filter((id): id is string => typeof id === 'string' && id !== '') } : {}),
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

/** Opens the companion desktop window beside the tray popup, or focuses it (#69). */
export async function openDesktop(invokeImpl: typeof invoke = invoke): Promise<void> {
  await invokeImpl('open_desktop');
}

/** A native window to open or focus (#223): a session, the audit log, Customize, or Launch. */
export interface SurfaceRequest {
  surface: WindowSurface;
  /** The roster key (account/agentId); optional for audit (all activity). */
  soul?: string;
  tab?: QueryTab;
  action?: 'archive';
}

/**
 * Opens that surface's window, or focuses the one already open (#223).
 * Rejects outside the app, under a snapshot, and with a shell that has no
 * such command, so the caller keeps the in-popup view as its fallback.
 */
export async function openSurface({ surface, soul, tab, action }: SurfaceRequest, invokeImpl: typeof invoke = invoke): Promise<void> {
  if (!inApp() && invokeImpl === invoke) throw new BridgeError('not-in-app', 'Native windows need the app.');
  await invokeImpl('open_surface', { surface, soul, tab, action });
}

/** One team card's native window (#223), in logical screen points. */
export interface TeamWindowSpec {
  /** The lead's roster key. */
  key: string;
  x?: number;
  y?: number;
  width: number;
  height: number;
}

/**
 * The popup's coordinator call (#223): one window per team in the list,
 * the rest closed. True when native team windows are in use; false in
 * `--window` mode, on other platforms, under a snapshot, outside the app,
 * or with a shell that cannot (an error is the same answer).
 */
export async function syncTeamWindows(teams: readonly TeamWindowSpec[], invokeImpl: typeof invoke = invoke): Promise<boolean> {
  if (!inApp() && invokeImpl === invoke) return false;
  try {
    return (await invokeImpl<unknown>('sync_team_windows', { teams })) === true;
  } catch {
    return false;
  }
}

/**
 * What a native surface does with its own window (#223), in logical points.
 * The pages take it as a prop, so tests and the preview pass a fake.
 */
export interface SurfaceWindow {
  close(): Promise<void>;
  hide(): Promise<void>;
  setSize(width: number, height: number): Promise<void>;
  /** The window's top-left on screen (its outer position). */
  position(): Promise<{ x: number; y: number }>;
  /** Calls `handler` after each move (`tauri://move`); resolves with the unlisten. */
  onMoved(handler: () => void): Promise<() => void>;
  setTitle(title: string): Promise<void>;
}

/** The part of Tauri's window the surfaces use. */
export type TauriWindowLike = Pick<Window, 'close' | 'hide' | 'setSize' | 'outerPosition' | 'onMoved' | 'setTitle'>;

/**
 * This web view's window, or null outside the app. Physical positions turn
 * logical with the page's devicePixelRatio, the scale of the screen the
 * window is on, so no scale-factor permission is needed.
 */
export function currentWindow(get: () => TauriWindowLike = getCurrentWindow): SurfaceWindow | null {
  if (!inApp() && get === getCurrentWindow) return null;
  const w = get();
  const scale = () => (typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1);
  return {
    close: () => w.close(),
    hide: () => w.hide(),
    setSize: (width, height) => w.setSize(new LogicalSize(width, height)),
    position: async () => {
      const at = (await w.outerPosition()).toLogical(scale());
      return { x: at.x, y: at.y };
    },
    onMoved: (handler) => w.onMoved(() => handler()),
    setTitle: (title) => w.setTitle(title),
  };
}

/** A window the popup check needs: only whether it is showing. */
export interface VisibleWindow { isVisible(): Promise<boolean> }

/**
 * True while the tray popup (window `main`) is showing. The desktop window
 * (#69) yields its chimes to it (#122): the popup hides on blur, so when
 * both show, the popup is the one in front. False outside the app, when the
 * popup is hidden, or when the shell cannot say.
 */
export async function popupVisible(getWindow?: (label: string) => Promise<VisibleWindow | null>): Promise<boolean> {
  const get = getWindow ?? (inApp() ? (label: string) => Window.getByLabel(label) : null);
  if (!get) return false;
  try {
    const popup = await get('main');
    return popup ? await popup.isVisible() : false;
  } catch {
    return false;
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
  /**
   * Held by `soul pause` (agent-bot-identity #478); false from a bundle
   * without the field. Optional so older fixtures still type.
   */
  paused?: boolean;
  /**
   * The owner's computer-use switch (agent-bot-identity #482); absent from a
   * bundle without the field.
   */
  computerUse?: boolean;
  /** The census status (`retired` once archived); null when not reported. */
  status?: string | null;
  /** The soul's declared look; absent when it declares none or the bundle predates it. */
  appearance?: SoulAppearance;
  /** The soul's declared role (agent-bot-identity #535); absent when none or the bundle predates it. */
  role?: string | null;
  /** agent-bot's role line (the role, else "Lead" and the subagent count); absent from older bundles. */
  roleLine?: string | null;
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
    ? [{ agentId: r.agentId, comms: r.comms, managed: r.managed === true, paused: r.paused === true,
      ...(typeof r.computerUse === 'boolean' ? { computerUse: r.computerUse } : {}),
      status: typeof r.status === 'string' ? r.status : null, ...withAppearance(r.appearance), ...withRole(r) }]
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

/**
 * agent-bot's answer to `soul stop <agentId> --json` (#122, agent-bot-identity
 * #474): `stopped` when a running turn was cancelled; otherwise `reason`
 * (`idle`: no turn was running).
 */
export interface SoulStopResult {
  agentId: string;
  stopped: boolean;
  reason?: string;
}

export function normalizeSoulStop(raw: unknown): SoulStopResult | null {
  if (!isRecord(raw) || typeof raw.agentId !== 'string' || typeof raw.stopped !== 'boolean') return null;
  return typeof raw.reason === 'string'
    ? { agentId: raw.agentId, stopped: raw.stopped, reason: raw.reason }
    : { agentId: raw.agentId, stopped: raw.stopped };
}

/**
 * Cancels the soul's running turn (the computer-use Stop). The daemon drops
 * it from `busy` / `computerUse` once the turn settles. Rejects with a
 * BridgeError; `soul-stop-unsupported` means the bundled agent-bot has no
 * `soul stop`.
 */
export async function stopSoul(agentId: string, invokeImpl: typeof invoke = invoke): Promise<SoulStopResult> {
  let raw: unknown;
  try {
    raw = await invokeImpl<unknown>('soul_stop', { agent: agentId });
  } catch (error) {
    const e = error as { code?: unknown; message?: unknown };
    throw new BridgeError(typeof e?.code === 'string' ? e.code : 'soul-stop-failed',
      typeof e?.message === 'string' ? e.message : String(error));
  }
  const result = normalizeSoulStop(raw);
  if (!result) throw new BridgeError('soul-stop-failed', 'agent-bot gave no stop result');
  return result;
}

/**
 * Whether the bundled agent-bot has `soul stop`; false outside the app, on
 * an older bundle, or when agent-bot cannot say. Stops nothing.
 */
export async function soulStopSupported(invokeImpl: typeof invoke = invoke): Promise<boolean> {
  if (!inApp() && invokeImpl === invoke) return false;
  try {
    const raw = await invokeImpl<unknown>('soul_stop_probe');
    return isRecord(raw) && raw.supported === true;
  } catch {
    return false;
  }
}

/**
 * agent-bot's answer to `soul pause|resume <agentId> --json` (#122,
 * agent-bot-identity #478): `paused` as the soul now is; pause also says
 * whether a running turn was cancelled (`stopped`).
 */
export interface SoulPauseResult {
  agentId: string;
  paused: boolean;
  stopped?: boolean;
}

export function normalizeSoulPause(raw: unknown): SoulPauseResult | null {
  if (!isRecord(raw) || typeof raw.agentId !== 'string' || typeof raw.paused !== 'boolean') return null;
  return typeof raw.stopped === 'boolean'
    ? { agentId: raw.agentId, paused: raw.paused, stopped: raw.stopped }
    : { agentId: raw.agentId, paused: raw.paused };
}

async function soulPauseCall(command: 'soul_pause' | 'soul_resume', agentId: string,
  invokeImpl: typeof invoke): Promise<SoulPauseResult> {
  const failed = command === 'soul_pause' ? 'soul-pause-failed' : 'soul-resume-failed';
  let raw: unknown;
  try {
    raw = await invokeImpl<unknown>(command, { agent: agentId });
  } catch (error) {
    const e = error as { code?: unknown; message?: unknown };
    throw new BridgeError(typeof e?.code === 'string' ? e.code : failed,
      typeof e?.message === 'string' ? e.message : String(error));
  }
  const result = normalizeSoulPause(raw);
  if (!result) throw new BridgeError(failed, 'agent-bot gave no pause result');
  return result;
}

/**
 * Pauses a soul: cancels its running turn and holds its wakes, launches
 * and chat until `resumeSoul`. Rejects with a BridgeError;
 * `soul-pause-unsupported` means the bundled agent-bot has no `soul pause`.
 */
export function pauseSoul(agentId: string, invokeImpl: typeof invoke = invoke): Promise<SoulPauseResult> {
  return soulPauseCall('soul_pause', agentId, invokeImpl);
}

/** Lifts `pauseSoul`; rejects as it does. */
export function resumeSoul(agentId: string, invokeImpl: typeof invoke = invoke): Promise<SoulPauseResult> {
  return soulPauseCall('soul_resume', agentId, invokeImpl);
}

/**
 * Whether the bundled agent-bot has `soul pause`; false outside the app, on
 * an older bundle, or when agent-bot cannot say. Pauses nothing.
 */
export async function soulPauseSupported(invokeImpl: typeof invoke = invoke): Promise<boolean> {
  if (!inApp() && invokeImpl === invoke) return false;
  try {
    const raw = await invokeImpl<unknown>('soul_pause_probe');
    return isRecord(raw) && raw.supported === true;
  } catch {
    return false;
  }
}

/**
 * agent-bot's answer to `soul computer-use <agentId> [show|on|off] --json`
 * (#122, agent-bot-identity #482): the owner's switch as it now is. Off,
 * agent-bot denies the soul's computer-use proposals; switching off while
 * it drives the screen also stops that session (`stopped`).
 */
export interface SoulComputerUse {
  agentId: string;
  computerUse: boolean;
  stopped?: boolean;
}

export function normalizeSoulComputerUse(raw: unknown): SoulComputerUse | null {
  if (!isRecord(raw) || typeof raw.agentId !== 'string' || typeof raw.computerUse !== 'boolean') return null;
  return raw.stopped === true
    ? { agentId: raw.agentId, computerUse: raw.computerUse, stopped: true }
    : { agentId: raw.agentId, computerUse: raw.computerUse };
}

/**
 * Reads (`show`) or switches (`on` / `off`) the soul's computer use. A
 * switch is owner-gated by agent-bot (its consent dialog, Touch ID), as
 * `soul mode` is; a refusal rejects with its reason and the switch stays.
 * Rejects with a BridgeError; `soul-computer-use-unsupported` means the
 * bundled agent-bot has no `soul computer-use`.
 */
export async function soulComputerUse(agentId: string, action: 'show' | 'on' | 'off',
  invokeImpl: typeof invoke = invoke): Promise<SoulComputerUse> {
  let raw: unknown;
  try {
    raw = await invokeImpl<unknown>('soul_computer_use', { agent: agentId, action });
  } catch (error) {
    const e = error as { code?: unknown; message?: unknown };
    throw new BridgeError(typeof e?.code === 'string' ? e.code : 'soul-computer-use-failed',
      typeof e?.message === 'string' ? e.message : String(error));
  }
  const result = normalizeSoulComputerUse(raw);
  if (!result) throw new BridgeError('soul-computer-use-failed', 'agent-bot gave no computer-use setting');
  return result;
}

/**
 * Whether the bundled agent-bot has `soul computer-use`; false outside the
 * app, on an older bundle, or when agent-bot cannot say. Changes nothing.
 */
export async function soulComputerUseSupported(invokeImpl: typeof invoke = invoke): Promise<boolean> {
  if (!inApp() && invokeImpl === invoke) return false;
  try {
    const raw = await invokeImpl<unknown>('soul_computer_use_probe');
    return isRecord(raw) && raw.supported === true;
  } catch {
    return false;
  }
}

/**
 * The owner's per-soul computer-use switch, for the Details row and the
 * floating Dudle's "Toggle computer use": `supported` is asked once per
 * switch; `read` is null when agent-bot cannot say.
 */
export interface ComputerUseSwitch {
  supported: () => Promise<boolean>;
  read: (agentId: string) => Promise<boolean | null>;
  set: (agentId: string, on: boolean) => Promise<SoulComputerUse>;
}

export const liveComputerUse: ComputerUseSwitch = {
  supported: () => soulComputerUseSupported(),
  read: (agentId) => (inApp() ? soulComputerUse(agentId, 'show').then((r) => r.computerUse, () => null) : Promise.resolve(null)),
  set: (agentId, on) => soulComputerUse(agentId, on ? 'on' : 'off'),
};

const computerUseProbes = new WeakMap<ComputerUseSwitch, Promise<boolean>>();

/**
 * `supported()` asked once per switch while it answers true; a false or a
 * failure is asked again next time, so a transient failure hides nothing
 * for good.
 */
export function computerUseSupported(sw: ComputerUseSwitch): Promise<boolean> {
  let probe = computerUseProbes.get(sw);
  if (!probe) {
    probe = sw.supported().catch(() => false);
    computerUseProbes.set(sw, probe);
    void probe.then((ok) => { if (!ok) computerUseProbes.delete(sw); });
  }
  return probe;
}

/**
 * One soul template from agent-bot's `soul templates --json` (#65,
 * agent-bot-identity #374): a local package the launch form offers as a
 * preset. Launching it is launching `package`, as a typed path would.
 */
export interface SoulTemplate {
  name: string;
  description: string;
  preferredHarnesses: string[];
  /** The first preferred harness, or null. */
  defaultHarness: string | null;
  /** Absolute package path. */
  package: string;
  revision: string | null;
  source: 'souls-root' | 'config' | 'bundled';
}

export interface SoulTemplateList {
  templates: SoulTemplate[];
  soulsRoot: string | null;
  /** Packages agent-bot could not read; the listing still answers. */
  errors: { package: string | null; message: string }[];
}

const TEMPLATE_SOURCES: readonly SoulTemplate['source'][] = ['souls-root', 'config', 'bundled'];

/**
 * Keeps only well-formed templates (a name and an absolute package, once
 * each), in agent-bot's order; null when the answer is not a listing.
 */
export function normalizeSoulTemplates(raw: unknown): SoulTemplateList | null {
  if (!isRecord(raw) || !Array.isArray(raw.templates)) return null;
  const templates: SoulTemplate[] = [];
  for (const row of raw.templates) {
    if (!isRecord(row) || typeof row.name !== 'string' || row.name.trim() === '' || typeof row.package !== 'string'
      || !row.package.startsWith('/') || templates.some((t) => t.package === row.package)) continue;
    const preferred = Array.isArray(row.preferredHarnesses)
      ? row.preferredHarnesses.filter((h): h is string => typeof h === 'string' && h.trim() !== '') : [];
    const harness = typeof row.defaultHarness === 'string' && row.defaultHarness.trim() !== '' ? row.defaultHarness : null;
    templates.push({
      name: row.name,
      description: typeof row.description === 'string' ? row.description : '',
      preferredHarnesses: preferred,
      defaultHarness: harness,
      package: row.package,
      revision: typeof row.revision === 'string' ? row.revision : null,
      source: TEMPLATE_SOURCES.includes(row.source as SoulTemplate['source']) ? row.source as SoulTemplate['source'] : 'souls-root',
    });
  }
  const errors = Array.isArray(raw.errors) ? raw.errors.flatMap((e) => (isRecord(e) && typeof e.message === 'string'
    ? [{ package: typeof e.package === 'string' ? e.package : null, message: e.message }] : [])) : [];
  return { templates, soulsRoot: typeof raw.soulsRoot === 'string' ? raw.soulsRoot : null, errors };
}

/**
 * The soul templates agent-bot lists. Rejects with a BridgeError;
 * `soul-templates-unsupported` means the bundled agent-bot has no
 * `soul templates` (and is what a plain browser or a test gets).
 */
export async function listSoulTemplates(invokeImpl: typeof invoke = invoke): Promise<SoulTemplateList> {
  if (!inApp() && invokeImpl === invoke) throw new BridgeError('soul-templates-unsupported', 'not in the app');
  let raw: unknown;
  try {
    raw = await invokeImpl<unknown>('list_soul_templates');
  } catch (error) {
    const e = error as { code?: unknown; message?: unknown };
    throw new BridgeError(typeof e?.code === 'string' ? e.code : 'soul-templates-failed',
      typeof e?.message === 'string' ? e.message : String(error));
  }
  const result = normalizeSoulTemplates(raw);
  if (!result) throw new BridgeError('soul-templates-failed', 'agent-bot gave no soul templates');
  return result;
}

/** A file the soul's harness loads (#64), from agent-bot `soul profile`. */
export interface SoulProfileFileEntry {
  /** Relative to the soul directory. */
  path: string;
  kind: 'soul' | 'generated' | 'harness-settings' | 'context' | 'skill';
  size: number | null;
  modifiedAt: string | null;
  /** Only text files can be viewed. */
  text: boolean;
}

export interface SoulProfileSkill {
  name: string;
  /** `soul` for the package's own skills, `sop` for the SOP's. */
  source: 'soul' | 'sop';
  path: string | null;
  commit: string | null;
}

/** A declared credential: its name and status, never a value. */
export interface SoulProfileCredential {
  name: string;
  provider: string | null;
  status: string | null;
}

/**
 * A soul's read-only profile (#64, agent-bot-identity #375): what the
 * Customize dialog shows. Unknown scalars are null, collections empty.
 */
export interface SoulProfile {
  agentId: string;
  profile: {
    /** The census handle. */
    name: string | null;
    displayName: string | null;
    description: string | null;
    harness: string | null;
    package: string | null;
    revision: string | null;
    template: boolean | null;
    parentId: string | null;
    status: string | null;
    /** The declared look; null when the soul declares none or the bundle predates it. */
    appearance: SoulAppearance | null;
  };
  files: SoulProfileFileEntry[];
  skills: SoulProfileSkill[];
  credentials: SoulProfileCredential[];
  sop: {
    resolved: { source: string; commit: string | null } | null;
    override: { path: string; workflows: string[] } | null;
  };
  /** Partial, unavailable or unsafe data agent-bot left out. */
  errors: { area: string | null; message: string }[];
}

/** One file's contents, from `soul profile --file`. */
export interface SoulProfileFile {
  agentId: string;
  path: string;
  size: number | null;
  contents: string;
}

const FILE_KINDS: readonly SoulProfileFileEntry['kind'][] = ['soul', 'generated', 'harness-settings', 'context', 'skill'];
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

/**
 * Keeps the fields the dialog shows; null when the answer is not a profile.
 * Credentials keep only name, provider and status, whatever else arrives.
 */
export function normalizeSoulProfile(raw: unknown): SoulProfile | null {
  if (!isRecord(raw) || typeof raw.agentId !== 'string' || !isRecord(raw.profile)) return null;
  const p = raw.profile;
  const rows = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);
  const files = rows(raw.files).flatMap((f): SoulProfileFileEntry[] => {
    const path = text(f.path);
    if (!path) return [];
    return [{
      path,
      kind: FILE_KINDS.includes(f.kind as SoulProfileFileEntry['kind']) ? f.kind as SoulProfileFileEntry['kind'] : 'context',
      size: count(f.size),
      modifiedAt: text(f.modifiedAt),
      text: f.text === true,
    }];
  });
  const skills = rows(raw.skills).flatMap((s): SoulProfileSkill[] => {
    const name = text(s.name);
    return name ? [{ name, source: s.source === 'sop' ? 'sop' : 'soul', path: text(s.path), commit: text(s.commit) }] : [];
  });
  const credentials = rows(raw.credentials).flatMap((c): SoulProfileCredential[] => {
    const name = text(c.name);
    return name ? [{ name, provider: text(c.provider), status: text(c.status) }] : [];
  });
  const sop = isRecord(raw.sop) ? raw.sop : {};
  const resolved = isRecord(sop.resolved) && text(sop.resolved.source)
    ? { source: sop.resolved.source as string, commit: text(sop.resolved.commit) } : null;
  const override = isRecord(sop.override) && text(sop.override.path)
    ? { path: sop.override.path as string, workflows: Array.isArray(sop.override.workflows) ? sop.override.workflows.filter((w): w is string => typeof w === 'string' && w !== '') : [] }
    : null;
  const errors = rows(raw.errors).flatMap((e) => (typeof e.message === 'string' && e.message !== ''
    ? [{ area: text(e.area), message: e.message }] : []));
  return {
    agentId: raw.agentId,
    profile: {
      name: text(p.name),
      displayName: text(p.displayName),
      description: text(p.description),
      harness: text(p.harness),
      package: text(p.package),
      revision: text(p.revision),
      template: typeof p.template === 'boolean' ? p.template : null,
      parentId: text(p.parentId),
      status: text(p.status),
      appearance: normalizeAppearance(p.appearance) ?? null,
    },
    files,
    skills,
    credentials,
    sop: { resolved, override },
    errors,
  };
}

function profileFailure(error: unknown): BridgeError {
  const e = error as { code?: unknown; message?: unknown };
  return new BridgeError(typeof e?.code === 'string' ? e.code : 'soul-profile-failed',
    typeof e?.message === 'string' ? e.message : String(error));
}

/**
 * A soul's profile from agent-bot. Rejects with a BridgeError;
 * `soul-profile-unsupported` means the bundled agent-bot has no `soul
 * profile` (and is what a plain browser or a test gets).
 */
export async function soulProfile(agentId: string, invokeImpl: typeof invoke = invoke): Promise<SoulProfile> {
  if (!inApp() && invokeImpl === invoke) throw new BridgeError('soul-profile-unsupported', 'not in the app');
  let raw: unknown;
  try {
    raw = await invokeImpl<unknown>('soul_profile', { agent: agentId });
  } catch (error) {
    throw profileFailure(error);
  }
  const result = normalizeSoulProfile(raw);
  if (!result) throw new BridgeError('soul-profile-failed', 'agent-bot gave no soul profile');
  return result;
}

/** One profile file's text, read-only. Rejects with a BridgeError as soulProfile does. */
export async function soulProfileFile(agentId: string, path: string, invokeImpl: typeof invoke = invoke): Promise<SoulProfileFile> {
  if (!inApp() && invokeImpl === invoke) throw new BridgeError('soul-profile-unsupported', 'not in the app');
  let raw: unknown;
  try {
    raw = await invokeImpl<unknown>('soul_profile_file', { agent: agentId, path });
  } catch (error) {
    throw profileFailure(error);
  }
  if (!isRecord(raw) || typeof raw.path !== 'string' || typeof raw.contents !== 'string') {
    throw new BridgeError('soul-profile-failed', 'agent-bot gave no file contents');
  }
  return { agentId: typeof raw.agentId === 'string' ? raw.agentId : agentId, path: raw.path, size: count(raw.size), contents: raw.contents };
}

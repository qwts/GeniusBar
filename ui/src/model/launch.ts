// Launching souls (#18): pure request validation, launch lifecycle and
// error text. The broker forwards a launch to the account's agent-bot
// daemon exactly once; nothing here retries a launch.
//
// Contract, from agent-comms docs/principal-client.md (Request a daemon
// launch): launch({ account, soul | package, harness, name?, comms?, model?, brief?, role?, parent? }) returns
// { requestId, status: 'pending' }; launchStatus(requestId) returns the same
// shape until status is 'launched' or 'failed'.

import { displayHarness, type CensusRow } from './census';

/** What to launch: an existing soul, or a soul package path in the account. */
export type LaunchTarget = { soul: string } | { package: string };

export interface LaunchRequest {
  account: string;
  target: LaunchTarget;
  harness: string;
  /**
   * Optional display name for a package launch; blank means none. A launch
   * of an existing soul never renames it (#79), so the name is not sent.
   */
  name: string;
  /**
   * Agent comms for the launched soul (#71); agent-bot writes it to the
   * soul's soul.json before starting it. Omitted leaves the soul's setting.
   */
  comms?: boolean;
  /**
   * The model for the launched soul (#128); agent-bot saves it before the
   * soul's first turn. Omitted (or blank) is the harness default and sends
   * no `model` at all, which older agent-comms and agent-bot expect.
   */
  model?: string;
  /**
   * What this companion is here to do (#120): agent-bot shows it on the
   * soul's first turn after its identity, keeps it, and carries it forward
   * on relaunch. Blank sends no `brief`, which leaves a saved one as it is.
   */
  brief?: string;
  /**
   * A short role for a new soul (agent-bot-identity #535): agent-bot writes
   * it into the spawned soul's manifest, and the fleet shows it instead of
   * the harness. Only a package launch sends it; an existing soul keeps the
   * role in its soul.json. Blank sends nothing.
   */
  role?: string;
  /**
   * The soul's parent (#261): null is independent, a root soul that starts
   * its own team; an agent id names the companion it joins under. Omitted
   * says nothing, which older callers do. Never the soul itself.
   */
  parent?: string | null;
}

/** agent-comms' bound on a launch role, in characters after trimming. */
export const MAX_ROLE = 60;

/**
 * Harnesses agent-bot's daemon can drive today (its ACP registry's enabled
 * rows). GeniusBar never runs a model itself; the harness does.
 */
export const KNOWN_HARNESSES: readonly { id: string; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'opencode', label: 'opencode' },
  { id: 'muse', label: 'Muse' },
];

/** A harness's name as people know it ("claude" → "Claude Code"); an unknown one keeps its ID. */
export function harnessLabel(id: string): string {
  return KNOWN_HARNESSES.find((h) => h.id === id)?.label ?? id;
}

/** A soul's harness by its label, as the design shows it outside the window title and session subtitle. */
export function soulHarnessLabel(soul: Pick<CensusRow, 'harness'>): string {
  return soul.harness ? harnessLabel(soul.harness) : displayHarness(soul);
}

/** The known harnesses, then any others seen in the census or chosen, each once. */
export function harnessOptions(seen: readonly string[], ...extra: (string | null | undefined)[]): { id: string; label: string }[] {
  const out = [...KNOWN_HARNESSES];
  for (const id of [...seen, ...extra]) {
    const harness = id?.trim();
    if (harness && !out.some((h) => h.id === harness)) out.push({ id: harness, label: harness });
  }
  return out;
}

/**
 * The name to prefill for a package opened from Finder (#120): the first
 * segment of its soul.json name, since launches name the new soul
 * "<name> - <package>" and "VMTwo - Starter - VMTwo - Starter" is nobody's
 * wish. Blank when the package says nothing.
 */
export function suggestedName(packageName: string | null | undefined): string {
  const first = (packageName ?? '').split(' - ')[0].trim();
  return first.slice(0, MAX_NAME);
}

/**
 * A package path without its trailing slashes (#116): Finder hands an
 * opened `.soul` bundle over as a folder ("…/VMShare.soul/"), and a pasted
 * path may end in one too. The root stays "/".
 */
export function normalPackagePath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' && path.startsWith('/') ? '/' : trimmed;
}

/** The first harness a package prefers that this app can offer, if any. */
export function preferredHarness(preferred: readonly string[] | null | undefined, seen: readonly string[]): string | null {
  const offered = harnessOptions(seen).map((h) => h.id);
  return preferred?.find((id) => offered.includes(id.trim())) ?? null;
}

// Limits from the wire contract; the broker enforces them too.
export const MAX_PACKAGE = 4096;
export const MAX_HARNESS = 64;
export const MAX_NAME = 128;
export const MAX_MODEL = 120;
export const MAX_BRIEF = 4000;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// A brief may span lines and hold tabs; agent-bot refuses any other control.
// eslint-disable-next-line no-control-regex
const BRIEF_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

/** Why the request cannot be sent, or null when it is well-formed. */
export function launchProblem(request: LaunchRequest): string | null {
  if (request.account.trim() === '') return 'Choose an account.';
  if ('package' in request.target) {
    const path = normalPackagePath(request.target.package);
    if (path.trim() === '') return 'Enter the companion package path.';
    if (path.length > MAX_PACKAGE) return `The package path is longer than ${MAX_PACKAGE} characters.`;
  }
  if (request.harness.trim() === '') return 'Enter a harness.';
  if (request.harness.length > MAX_HARNESS) return `The harness name is longer than ${MAX_HARNESS} characters.`;
  if (request.name.length > MAX_NAME) return `The name is longer than ${MAX_NAME} characters.`;
  if ((request.model ?? '').trim().length > MAX_MODEL) return `The model is longer than ${MAX_MODEL} characters.`;
  if (typeof request.parent === 'string') {
    if (request.parent.trim() === '' || request.parent.length > MAX_NAME || CONTROL.test(request.parent)) return 'Choose a parent companion, or Independent.';
    if ('soul' in request.target && request.target.soul === request.parent) return 'A companion cannot be its own parent. Choose another, or Independent.';
  }
  if (briefText(request.brief).length > MAX_BRIEF) return `The brief is longer than ${MAX_BRIEF} characters.`;
  if (BRIEF_CONTROL.test(briefText(request.brief))) return 'Remove control characters from the brief (lines and tabs are fine).';
  const fields = [request.account, request.harness, request.name, request.model ?? '',
    'package' in request.target ? request.target.package : request.target.soul];
  if (fields.some((f) => CONTROL.test(f))) return 'Remove control characters (such as newlines or tabs).';
  return null;
}

/**
 * The harness a launch form starts with (#120): an existing soul's own,
 * else the first the package prefers that the app can offer, else the
 * viewer's default. Blank when none is known.
 */
export function prefillHarness(soulHarness: string | null | undefined, packageHarness: string | null | undefined, defaultHarness: string | null | undefined): string {
  return soulHarness || packageHarness || defaultHarness || '';
}

/** The brief as sent: trimmed, with Windows line ends made plain. */
function briefText(brief: string | undefined): string {
  return (brief ?? '').replace(/\r\n?/g, '\n').trim();
}

/**
 * Bridge params for `launch`, with the name, the model and the brief omitted when blank.
 * A `{soul}` launch never carries a name: relaunching a companion must not
 * rename it (#79), so the form's name is dropped there as a second guard.
 */
export function launchParams(request: LaunchRequest): Record<string, string | boolean | null> {
  const params: Record<string, string | boolean | null> = { account: request.account, harness: request.harness.trim() };
  if ('package' in request.target) params.package = normalPackagePath(request.target.package);
  else params.soul = request.target.soul;
  if ('package' in request.target && request.name.trim() !== '') params.name = request.name.trim();
  if (typeof request.comms === 'boolean') params.comms = request.comms;
  const model = request.model?.trim();
  if (model) params.model = model;
  const brief = briefText(request.brief);
  if (brief) params.brief = brief;
  const role = request.role?.trim();
  if ('package' in request.target && role) params.role = role;
  if (request.parent !== undefined) params.parent = request.parent === null ? null : request.parent.trim();
  return params;
}

/**
 * The companions a launch may name as its parent (#261): the roster
 * (which `withoutArchived` has already cleared of archived souls; `archived`
 * drops any more), minus the launched soul itself and its descendants, so no
 * cycle can be asked for. Roots and children alike qualify; the engine is
 * the authority and refuses what it cannot do.
 */
export function parentChoices(roster: readonly CensusRow[], self: Pick<CensusRow, 'agentId'> | null | undefined,
  archived: ReadonlySet<string> = new Set()): CensusRow[] {
  const excluded = new Set<string>(archived);
  if (self) {
    excluded.add(self.agentId);
    // Descendants, by walking the roster's parent claims; a cycle ends when nothing new is found.
    let grew = true;
    while (grew) {
      grew = false;
      for (const soul of roster) {
        if (soul.parent !== null && excluded.has(soul.parent) && !excluded.has(soul.agentId)) {
          excluded.add(soul.agentId);
          grew = true;
        }
      }
    }
  }
  const seen = new Set<string>();
  return roster.filter((soul) => {
    if (excluded.has(soul.agentId) || seen.has(soul.agentId)) return false;
    seen.add(soul.agentId);
    return true;
  });
}

/** What the launch form checks before it sends (#261), one line per problem. */
export interface LaunchDraft {
  /** The soul being relaunched, when any. */
  soul: CensusRow | null;
  /** True when the package is a copy of a companion, which must be named (#110). */
  copy: boolean;
  /** True when the form launches a custom package path rather than a template or a soul. */
  customPackage: boolean;
  packagePath: string;
  name: string;
  account: string;
  harness: string;
  model: string | null;
  brief: string;
  parent: string | null;
  /** The parents the form offers; a chosen one outside it is refused. */
  parents: readonly Pick<CensusRow, 'agentId'>[];
  /**
   * Whether the launch path carries a parent to the daemon: the engine's
   * `launch-parent` capability, read by the form. Without it a companion
   * parent is refused here rather than dropped on the way and the soul
   * started independent in silence.
   */
  parentCarried: boolean;
}

/** One line of the list, as a locale key and its variables; the form words it. */
export interface LaunchDraftError {
  code: 'name' | 'nameLong' | 'package' | 'packageLong' | 'account' | 'harness' | 'harnessLong' | 'modelLong' | 'modelControl' | 'brief' | 'parent' | 'parentSelf' | 'parentUncarried';
  vars?: Record<string, string | number>;
}

/**
 * The design's "Fix these before launching:" list, checked entirely before
 * creation; the engine checks again and its refusal is shown as it is.
 * Custom harness and model ids pass: the harness, not this app, knows what
 * it runs.
 */
export function launchDraftErrors(draft: LaunchDraft): LaunchDraftError[] {
  const errors: LaunchDraftError[] = [];
  const name = draft.name.trim();
  if (!draft.soul && draft.copy && name === '') errors.push({ code: 'name' });
  if (name.length > MAX_NAME) errors.push({ code: 'nameLong', vars: { max: MAX_NAME } });
  if (!draft.soul && draft.customPackage) {
    const path = normalPackagePath(draft.packagePath);
    if (path.trim() === '') errors.push({ code: 'package' });
    else if (path.length > MAX_PACKAGE) errors.push({ code: 'packageLong', vars: { max: MAX_PACKAGE } });
  }
  if (draft.account.trim() === '') errors.push({ code: 'account' });
  if (draft.harness.trim() === '') errors.push({ code: 'harness' });
  else if (draft.harness.length > MAX_HARNESS) errors.push({ code: 'harnessLong', vars: { max: MAX_HARNESS } });
  const model = draft.model?.trim() ?? '';
  if (model.length > MAX_MODEL) errors.push({ code: 'modelLong', vars: { max: MAX_MODEL } });
  else if (CONTROL.test(model)) errors.push({ code: 'modelControl' });
  if (briefText(draft.brief).length > MAX_BRIEF) errors.push({ code: 'brief', vars: { max: MAX_BRIEF } });
  if (draft.parent !== null) {
    if (draft.soul && draft.parent === draft.soul.agentId) errors.push({ code: 'parentSelf' });
    else if (!draft.parents.some((p) => p.agentId === draft.parent)) errors.push({ code: 'parent' });
    // Keeping a relaunched child's own parent asks the daemon for nothing new.
    else if (!draft.parentCarried && draft.parent !== draft.soul?.parent) errors.push({ code: 'parentUncarried' });
  }
  return errors;
}

/**
 * The stages a daemon reports while a launch is pending (agent-comms
 * `launch-progress`, agent-bot-identity #536), in order. An older daemon
 * reports none.
 */
export const LAUNCH_STAGES = ['checking', 'account', 'joining', 'harness', 'session'] as const;
export type LaunchStage = (typeof LAUNCH_STAGES)[number];

/**
 * Who the launched companion runs as (agent-comms 0.3.14 `launch-status`,
 * GeniusBar #66): agent-bot's sandbox account, or the owner's own when it
 * runs unrestricted. Older daemons say nothing.
 */
export interface LaunchSandbox {
  resolution: 'sandboxed' | 'unrestricted';
  account: string;
}

export type LaunchState =
  | { phase: 'idle' }
  | { phase: 'requesting' }
  /**
   * Accepted; `note` explains a status check that could not complete and
   * `stage` is the daemon's latest report, null until it says.
   */
  | { phase: 'pending'; requestId: string; note: string | null; stage: LaunchStage | null; sandbox?: LaunchSandbox }
  | { phase: 'launched'; requestId: string; agentId: string | null; sandbox?: LaunchSandbox }
  /** `stage` says where the daemon stopped, when it reported stages. */
  | { phase: 'failed'; requestId: string; agentId: string | null; detail: string | null; code?: string; stage?: LaunchStage | null; sandbox?: LaunchSandbox }
  /** The launch was refused, or its status can no longer be read. */
  | { phase: 'error'; requestId: string | null; text: string };

export const idleLaunch: LaunchState = { phase: 'idle' };

/** Whether a new launch may start: never while one is unresolved. */
export function canLaunch(state: LaunchState): boolean {
  return state.phase !== 'requesting' && state.phase !== 'pending';
}

/** The state after one `launchStatus` result; unknown statuses stay pending. */
export function applyStatus(state: LaunchState, result: unknown): LaunchState {
  if (state.phase !== 'pending') return state;
  const r = (result ?? {}) as { status?: unknown; agentId?: unknown; detail?: unknown; code?: unknown; stage?: unknown; sandbox?: unknown };
  const agentId = typeof r.agentId === 'string' ? r.agentId : null;
  const stage = laterStage(state.stage, r.stage);
  // A result without one keeps what an earlier one said.
  const sandbox = launchSandbox(r.sandbox) ?? state.sandbox;
  const runsAs = sandbox ? { sandbox } : {};
  if (r.status === 'launched') return { phase: 'launched', requestId: state.requestId, agentId, ...runsAs };
  if (r.status === 'failed') {
    const detail = typeof r.detail === 'string' && r.detail.trim() !== '' ? r.detail : null;
    const code = typeof r.code === 'string' && r.code.trim() !== '' ? r.code : undefined;
    return { phase: 'failed', requestId: state.requestId, agentId, detail, ...(code ? { code } : {}), ...(stage ? { stage } : {}), ...runsAs };
  }
  return { ...state, note: null, stage, ...runsAs };
}

/** Only the engine's explicit sign-out refusal warrants launch sign-in recovery. */
export function launchNeedsHarnessSignIn(state: LaunchState): boolean {
  if (state.phase !== 'failed') return false;
  if (state.code !== undefined) return state.code === 'harness-signed-out';
  return state.detail?.startsWith('harness-signed-out: ') ?? false;
}

/** The longest sandbox account name shown; a longer one is taken as malformed. */
const MAX_ACCOUNT = 256;

/**
 * A `launch-status` result's `sandbox`, or null when absent or malformed:
 * a known resolution and a non-blank account without control characters.
 */
export function launchSandbox(raw: unknown): LaunchSandbox | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { resolution, account } = raw as { resolution?: unknown; account?: unknown };
  if (resolution !== 'sandboxed' && resolution !== 'unrestricted') return null;
  if (typeof account !== 'string') return null;
  const name = account.trim();
  if (name === '' || name.length > MAX_ACCOUNT || CONTROL.test(name)) return null;
  return { resolution, account: name };
}

/** The reported stage when it is a known one past the current; stages never go back. */
function laterStage(current: LaunchStage | null, reported: unknown): LaunchStage | null {
  if (!LAUNCH_STAGES.includes(reported as LaunchStage)) return current;
  const next = reported as LaunchStage;
  return current === null || LAUNCH_STAGES.indexOf(next) > LAUNCH_STAGES.indexOf(current) ? next : current;
}

/** Status-read errors that end polling; anything else is retried. */
const FINAL_STATUS_ERRORS = new Set(['unknown-launch', 'forbidden', 'not-approved', 'credential-invalid', 'unauthenticated']);

/** The state after a `launchStatus` call failed. */
export function applyStatusError(state: LaunchState, code: string, _message: string): LaunchState {
  if (state.phase !== 'pending') return state;
  if (FINAL_STATUS_ERRORS.has(code)) {
    return { phase: 'error', requestId: state.requestId, text: launchErrorText(code, _message) };
  }
  return { ...state, note: 'Still waiting for the launch to finish. GeniusBar will keep checking.' };
}

export function launchErrorText(code: string, _message: string, account?: string): string {
  switch (code) {
    case 'daemon-unavailable':
      return `GeniusBar can’t reach the agents on ${account ? `account ${account}` : 'this account'}. Make sure setup has finished, then try again.`;
    case 'unknown-launch':
      return 'The broker no longer knows this launch, or you can no longer see it.';
    case 'rate-limited':
      return 'Too many requests in the last minute. Wait a moment, then launch again.';
    case 'unknown-recipient':
      return 'You cannot launch this soul: it is not in an account you may reach.';
    case 'broker-unreachable':
    case 'broker-timeout':
      return 'GeniusBar can’t reach its background service. Check the roster before trying again.';
    default:
      return 'GeniusBar couldn’t start this companion. Try again, and ask for help if the problem continues.';
  }
}

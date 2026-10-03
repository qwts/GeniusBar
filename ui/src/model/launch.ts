// Launching souls (#18): pure request validation, launch lifecycle and
// error text. The broker forwards a launch to the account's agent-bot
// daemon exactly once; nothing here retries a launch.
//
// Contract, from agent-comms docs/principal-client.md (Request a daemon
// launch): launch({ account, soul | package, harness, name? }) returns
// { requestId, status: 'pending' }; launchStatus(requestId) returns the same
// shape until status is 'launched' or 'failed'.

/** What to launch: an existing soul, or a soul package path in the account. */
export type LaunchTarget = { soul: string } | { package: string };

export interface LaunchRequest {
  account: string;
  target: LaunchTarget;
  harness: string;
  /** Optional display name; blank means none. */
  name: string;
}

/**
 * Harnesses agent-bot's daemon can drive today (its ACP registry's enabled
 * rows). GeniusBar never runs a model itself; the harness does.
 */
export const KNOWN_HARNESSES: readonly { id: string; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'opencode', label: 'opencode' },
  { id: 'muse', label: 'Muse' },
];

/** The known harnesses, then any others seen in the census or chosen, each once. */
export function harnessOptions(seen: readonly string[], ...extra: (string | null | undefined)[]): { id: string; label: string }[] {
  const out = [...KNOWN_HARNESSES];
  for (const id of [...seen, ...extra]) {
    const harness = id?.trim();
    if (harness && !out.some((h) => h.id === harness)) out.push({ id: harness, label: harness });
  }
  return out;
}

// Limits from the wire contract; the broker enforces them too.
export const MAX_PACKAGE = 4096;
export const MAX_HARNESS = 64;
export const MAX_NAME = 128;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Why the request cannot be sent, or null when it is well-formed. */
export function launchProblem(request: LaunchRequest): string | null {
  if (request.account.trim() === '') return 'Choose an account.';
  if ('package' in request.target) {
    const path = request.target.package;
    if (path.trim() === '') return 'Enter the companion package path.';
    if (path.length > MAX_PACKAGE) return `The package path is longer than ${MAX_PACKAGE} characters.`;
  }
  if (request.harness.trim() === '') return 'Enter a harness.';
  if (request.harness.length > MAX_HARNESS) return `The harness name is longer than ${MAX_HARNESS} characters.`;
  if (request.name.length > MAX_NAME) return `The name is longer than ${MAX_NAME} characters.`;
  const fields = [request.account, request.harness, request.name,
    'package' in request.target ? request.target.package : request.target.soul];
  if (fields.some((f) => CONTROL.test(f))) return 'Remove control characters (such as newlines or tabs).';
  return null;
}

/** Bridge params for `launch`, with the name omitted when blank. */
export function launchParams(request: LaunchRequest): Record<string, string> {
  const params: Record<string, string> = { account: request.account, harness: request.harness.trim() };
  if ('package' in request.target) params.package = request.target.package;
  else params.soul = request.target.soul;
  if (request.name.trim() !== '') params.name = request.name.trim();
  return params;
}

export type LaunchState =
  | { phase: 'idle' }
  | { phase: 'requesting' }
  /** Accepted; `note` explains a status check that could not complete. */
  | { phase: 'pending'; requestId: string; note: string | null }
  | { phase: 'launched'; requestId: string; agentId: string | null }
  | { phase: 'failed'; requestId: string; agentId: string | null; detail: string | null }
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
  const r = (result ?? {}) as { status?: unknown; agentId?: unknown; detail?: unknown };
  const agentId = typeof r.agentId === 'string' ? r.agentId : null;
  if (r.status === 'launched') return { phase: 'launched', requestId: state.requestId, agentId };
  if (r.status === 'failed') {
    const detail = typeof r.detail === 'string' && r.detail.trim() !== '' ? r.detail : null;
    return { phase: 'failed', requestId: state.requestId, agentId, detail };
  }
  return { ...state, note: null };
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

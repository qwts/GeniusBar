// Host capabilities (#46): what the shell established about this computer
// before the first launch, by probing the tools the bundle ships where the
// bundle keeps them (`host_capabilities`). The first launch picks its copy
// from `platform` here, never from the user agent, and never probes PATH.

/** The platform as the shell names it; `unknown` when the shell could not say. */
export type HostPlatform = 'macos' | 'windows' | 'linux' | 'unknown';

/** The tools a first launch needs, in the order the design lists them. */
export type HostToolId = 'git' | 'node' | 'cli';
export const HOST_TOOLS: readonly HostToolId[] = ['git', 'node', 'cli'];

/** `checking` is the view's own state while an answer is on its way; the shell reports the other three. */
export type HostToolState = 'checking' | 'ready' | 'missing' | 'failed';

export interface HostTool {
  id: HostToolId;
  /** Whether the copy probed is the bundle's own. */
  bundled: boolean;
  state: HostToolState;
  /** Why it failed, as the host said; null otherwise. */
  message: string | null;
}

export interface HostBuild {
  /** Whether the build was signed; null where the build does not record it. */
  signed: boolean | null;
  /** Whether this build can check for and install updates; null when unknown. */
  updater: boolean | null;
}

export interface HostCapabilities {
  platform: HostPlatform;
  tools: HostTool[];
  build: HostBuild;
}

/** What stands in when the shell could not answer: nothing is claimed, and the view behaves as it did before #46. */
export const unknownHost: HostCapabilities = { platform: 'unknown', tools: [], build: { signed: null, updater: null } };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isToolId = (value: unknown): value is HostToolId => typeof value === 'string' && (HOST_TOOLS as readonly string[]).includes(value);
const isReportedState = (value: unknown): value is Exclude<HostToolState, 'checking'> =>
  value === 'ready' || value === 'missing' || value === 'failed';
const boolOrNull = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

/**
 * The shell's answer with its shape checked: a tool with an unknown id or
 * state is dropped rather than guessed at, a platform the view does not
 * know is `unknown`, and a build fact that is not a boolean is null.
 */
export function normalizeHostCapabilities(raw: unknown): HostCapabilities | null {
  if (!isRecord(raw) || typeof raw.platform !== 'string') return null;
  const platform: HostPlatform = raw.platform === 'macos' || raw.platform === 'windows' || raw.platform === 'linux' ? raw.platform : 'unknown';
  const tools: HostTool[] = [];
  if (Array.isArray(raw.tools)) {
    for (const tool of raw.tools) {
      if (!isRecord(tool) || !isToolId(tool.id) || !isReportedState(tool.state)) continue;
      if (tools.some((t) => t.id === tool.id)) continue;
      tools.push({
        id: tool.id,
        bundled: tool.bundled === true,
        state: tool.state,
        message: typeof tool.message === 'string' && tool.message !== '' ? tool.message : null,
      });
    }
  }
  const build = isRecord(raw.build) ? raw.build : {};
  return { platform, tools, build: { signed: boolOrNull(build.signed), updater: boolOrNull(build.updater) } };
}

/** The same host with every tool back to `checking`, while a re-probe runs. */
export function checkingHost(host: HostCapabilities): HostCapabilities {
  return { ...host, tools: host.tools.map((tool) => ({ ...tool, state: 'checking', message: null })) };
}

/** True once every tool the first launch needs is reported ready. */
export function hostReady(host: HostCapabilities): boolean {
  return HOST_TOOLS.every((id) => host.tools.find((tool) => tool.id === id)?.state === 'ready');
}

/** The first tool that is not ready, in the design's order; null when all are. */
export function firstNotReady(host: HostCapabilities): HostTool | null {
  for (const id of HOST_TOOLS) {
    const tool = host.tools.find((t) => t.id === id);
    if (tool && tool.state !== 'ready') return tool;
  }
  return null;
}

/** True while a probe is still on its way. */
export function hostChecking(host: HostCapabilities): boolean {
  return host.tools.some((tool) => tool.state === 'checking');
}

/**
 * A development build, as the host says it: unsigned, or without the
 * updater. Nothing is claimed when the host does not say (null).
 */
export function devBuild(host: HostCapabilities): boolean {
  return host.build.signed === false || host.build.updater === false;
}

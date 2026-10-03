// The web view's only path to agent-comms: the shell relays each call to
// the Node bridge (#7), which holds the principal credential.
import { invoke } from '@tauri-apps/api/core';

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

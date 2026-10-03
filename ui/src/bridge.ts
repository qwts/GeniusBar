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
  unit: string;
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

export async function runtimeMetrics(): Promise<RuntimeMetrics> {
  if (!inApp()) return { unavailable: true };
  try {
    return await invoke<RuntimeMetrics>('runtime_metrics');
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

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { BridgeError, inApp } from '../bridge';

// GeniusBar's Sandboxing (#66), backed by agent-bot `sandbox`
// (agent-bot-identity #376): a global switch that runs souls in a separate
// standard macOS account, the owner's steps to create and onboard that
// account (agent-bot never creates it), and each soul's override. Nothing
// here is simulated: every state comes from agent-bot.

export type SandboxOverride = 'inherit' | 'sandboxed' | 'unrestricted';
export type SandboxAccountStatus = 'unsupported' | 'missing' | 'creating' | 'ready';

/** One of the owner's steps, from agent-bot's plan; `done` is null when agent-bot cannot tell. */
export interface SandboxStep {
  id: string;
  title: string;
  /** Who runs it: `owner-admin` (sudo), `owner`, or `account` (logged in as the sandbox account). */
  run: string;
  commands: string[];
  done: boolean | null;
  note?: string;
}

/**
 * What one soul gets: its override, whether it is sandboxed and the account
 * it runs as. `source` says who decided: the SOP pack's persona mapping
 * (`sop`, agent-bot 0.10.45, #66), the soul's override, or the switch. A
 * pack-decided soul takes no override but `inherit`; agent-bot refuses the
 * others, so the chip offers only that one. `reason` is agent-bot's note
 * when the pack wants a sandbox the switch has off.
 */
export interface SandboxSoul {
  agentId: string;
  name: string;
  override: SandboxOverride;
  sandboxed: boolean;
  runsAs: string;
  source: 'global' | 'override' | 'sop';
  rule: string | null;
  reason: string | null;
}

/** The SOP pack's persona mapping as `sandbox status` reports it (absent on an older agent-bot). */
export interface SandboxSop {
  state: string;
  decides: boolean;
  repository: string | null;
  commit: string | null;
  rules: number;
  message: string | null;
}

/**
 * A pairing the broker knows (`agent-comms broker pairings`, #66): an
 * account's, or its agent-bot daemon's; a pending one carries the code the
 * account printed, which the owner approves from the Sandboxing card.
 */
export interface SandboxPairing {
  account: string;
  kind: 'account' | 'daemon';
  state: string;
  code: string | null;
  at: string | null;
}

/** `agent-bot sandbox status --json`. */
export interface SandboxStatus {
  enabled: boolean;
  provider: string;
  account: string;
  status: SandboxAccountStatus;
  steps: SandboxStep[];
  souls: SandboxSoul[];
  sop: SandboxSop | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const OVERRIDES: readonly string[] = ['inherit', 'sandboxed', 'unrestricted'];
const STATUSES: readonly string[] = ['unsupported', 'missing', 'creating', 'ready'];

export function normalizeSandboxSoul(raw: unknown): SandboxSoul | null {
  if (!isRecord(raw) || typeof raw.agentId !== 'string' || typeof raw.runsAs !== 'string'
    || typeof raw.sandboxed !== 'boolean' || typeof raw.override !== 'string' || !OVERRIDES.includes(raw.override)) return null;
  return {
    agentId: raw.agentId,
    name: typeof raw.name === 'string' ? raw.name : raw.agentId,
    override: raw.override as SandboxOverride,
    sandboxed: raw.sandboxed,
    runsAs: raw.runsAs,
    source: raw.source === 'override' ? 'override' : raw.source === 'sop' ? 'sop' : 'global',
    rule: isRecord(raw.sop) && typeof raw.sop.rule === 'string' ? raw.sop.rule : null,
    reason: typeof raw.reason === 'string' && raw.reason !== '' ? raw.reason : null,
  };
}

function normalizeSop(raw: unknown): SandboxSop | null {
  if (!isRecord(raw) || typeof raw.state !== 'string') return null;
  return {
    state: raw.state,
    decides: raw.decides === true,
    repository: typeof raw.repository === 'string' ? raw.repository : null,
    commit: typeof raw.commit === 'string' ? raw.commit : null,
    rules: Array.isArray(raw.rules) ? raw.rules.length : 0,
    message: typeof raw.message === 'string' && raw.message !== '' ? raw.message : null,
  };
}

function normalizeStep(raw: unknown): SandboxStep | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.title !== 'string') return null;
  return {
    id: raw.id,
    title: raw.title,
    run: typeof raw.run === 'string' ? raw.run : 'owner',
    commands: Array.isArray(raw.commands) ? raw.commands.filter((c): c is string => typeof c === 'string') : [],
    done: typeof raw.done === 'boolean' ? raw.done : null,
    ...(typeof raw.note === 'string' && raw.note ? { note: raw.note } : {}),
  };
}

export function normalizeSandboxPairings(raw: unknown): SandboxPairing[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.pairings)) return null;
  return raw.pairings.flatMap((row): SandboxPairing[] => {
    if (!isRecord(row) || typeof row.account !== 'string' || row.account === '' || typeof row.state !== 'string') return [];
    return [{
      account: row.account,
      kind: row.kind === 'daemon' ? 'daemon' : 'account',
      state: row.state,
      code: typeof row.code === 'string' && row.code !== '' ? row.code : null,
      at: typeof row.at === 'string' ? row.at : null,
    }];
  });
}

export function normalizeSandboxStatus(raw: unknown): SandboxStatus | null {
  if (!isRecord(raw) || typeof raw.enabled !== 'boolean' || typeof raw.account !== 'string'
    || typeof raw.status !== 'string' || !STATUSES.includes(raw.status)) return null;
  return {
    enabled: raw.enabled,
    provider: typeof raw.provider === 'string' ? raw.provider : 'standard_macos_account',
    account: raw.account,
    status: raw.status as SandboxAccountStatus,
    steps: Array.isArray(raw.steps) ? raw.steps.map(normalizeStep).filter((s): s is SandboxStep => s !== null) : [],
    souls: Array.isArray(raw.souls) ? raw.souls.map(normalizeSandboxSoul).filter((s): s is SandboxSoul => s !== null) : [],
    sop: normalizeSop(raw.sop),
  };
}

/** Where sandboxing comes from: agent-bot in the app; tests and the preview pass their own. */
export interface SandboxSource {
  /** Rejects with code `sandbox-unsupported` when the bundled agent-bot has no `sandbox`. */
  status: () => Promise<SandboxStatus>;
  /** Owner-gated by agent-bot (consent dialog, Touch ID); a refusal rejects with its reason. */
  set: (on: boolean) => Promise<unknown>;
  /** Owner-gated as `set` is. */
  override: (agentId: string, override: SandboxOverride) => Promise<SandboxSoul>;
  /** The broker's pairings (`agent-comms broker pairings`); rejects when the broker cannot be asked. */
  pairings: () => Promise<SandboxPairing[]>;
  /** Approves a pending pairing by its code (`agent-comms broker approve CODE`), as the owner. */
  approve: (code: string) => Promise<unknown>;
}

async function call<T>(command: string, args: Record<string, unknown>, normalize: (raw: unknown) => T | null, fallback: string): Promise<T> {
  let raw: unknown;
  try {
    raw = await invoke<unknown>(command, args);
  } catch (error) {
    const e = error as { code?: unknown; message?: unknown };
    throw new BridgeError(typeof e?.code === 'string' ? e.code : 'sandbox-failed',
      typeof e?.message === 'string' ? e.message : String(error));
  }
  const result = normalize(raw);
  if (result === null) throw new BridgeError('sandbox-failed', fallback);
  return result;
}

export const liveSandbox: SandboxSource = {
  status: () => call('sandbox_status', {}, normalizeSandboxStatus, 'agent-bot gave no sandbox status'),
  set: (on) => call('sandbox_set', { action: on ? 'on' : 'off' }, (raw) => (isRecord(raw) ? raw : null), 'agent-bot gave no sandbox setting'),
  override: (agentId, override) => call('sandbox_override', { agent: agentId, action: override }, normalizeSandboxSoul, 'agent-bot gave no sandbox override'),
  pairings: () => call('sandbox_pairings', {}, normalizeSandboxPairings, 'agent-comms gave no pairings'),
  approve: (code) => call('sandbox_approve', { code }, (raw) => (isRecord(raw) ? raw : null), 'agent-comms did not approve the pairing'),
};

/** The live source inside the app (not in static renders); null elsewhere, which hides sandboxing. */
export function defaultSandboxSource(isStatic?: boolean): SandboxSource | null {
  return inApp() && !isStatic ? liveSandbox : null;
}

export interface SandboxApi {
  /** Nothing to show: no source, or the bundled agent-bot has no `sandbox`. */
  hidden: boolean;
  status: SandboxStatus | null;
  /**
   * The pairings waiting on the owner (state `pending`), read with the
   * status while the sandbox is on and its account not ready; null when the
   * broker could not be asked (the card then shows only the step).
   */
  pending: SandboxPairing[] | null;
  /** What is waiting on agent-bot: `switch`, a soul's agent ID, or `pairing:CODE`. */
  saving: string | null;
  /** The last failure and what it was for: `read`, `switch`, a soul's agent ID, or `pairing:CODE`. */
  failure: { scope: string; message: string } | null;
  reload: () => void;
  setEnabled: (on: boolean) => void;
  setOverride: (agentId: string, override: SandboxOverride) => void;
  approve: (code: string) => void;
  soul: (agentId: string) => SandboxSoul | null;
}

const HIDDEN: SandboxApi = {
  hidden: true, status: null, pending: null, saving: null, failure: null,
  reload: () => {}, setEnabled: () => {}, setOverride: () => {}, approve: () => {}, soul: () => null,
};

const SandboxContext = createContext<SandboxApi>(HIDDEN);

/** Sandboxing for the menu card, the companion chip and the Details row; hidden without a provider. */
export function useSandbox(): SandboxApi {
  return useContext(SandboxContext);
}

/**
 * Holds agent-bot's sandbox status for the whole app, so the menu card and
 * every companion chip agree. Each change goes to agent-bot, which asks the
 * owner, and is followed by a fresh read; only the latest read settles.
 */
export function SandboxProvider({ source, children }: { source: SandboxSource | null; children: ReactNode }) {
  const [status, setStatus] = useState<SandboxStatus | null>(null);
  const [pending, setPending] = useState<SandboxPairing[] | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ scope: string; message: string } | null>(null);
  const ticket = useRef(0);
  const reload = useCallback(() => {
    if (!source) return;
    const mine = ++ticket.current;
    source.status().then(
      (next) => {
        if (ticket.current !== mine) return;
        setStatus(next);
        setUnsupported(false);
        setFailure((f) => (f?.scope === 'read' ? null : f));
        // The owner's approval is a step only while the account is being set up.
        if (!next.enabled || next.status === 'ready' || next.status === 'unsupported') { setPending(null); return; }
        source.pairings().then(
          (rows) => { if (ticket.current === mine) setPending(rows.filter((row) => row.state === 'pending' && row.code !== null)); },
          () => { if (ticket.current === mine) setPending(null); },
        );
      },
      (error: unknown) => {
        if (ticket.current !== mine) return;
        const e = error as { code?: unknown; message?: unknown };
        if (e?.code === 'sandbox-unsupported') { setUnsupported(true); setStatus(null); return; }
        setFailure({ scope: 'read', message: typeof e?.message === 'string' ? e.message : String(error) });
      },
    );
  }, [source]);
  const change = useCallback((scope: string, run: () => Promise<unknown>) => {
    setSaving(scope);
    setFailure(null);
    run()
      .catch((error: unknown) => {
        const e = error as { code?: unknown; message?: unknown };
        if (e?.code === 'sandbox-unsupported') { setUnsupported(true); return; }
        setFailure({ scope, message: typeof e?.message === 'string' ? e.message : String(error) });
      })
      .finally(() => { setSaving(null); reload(); });
  }, [reload]);
  const api = useMemo<SandboxApi>(() => source ? {
    hidden: unsupported,
    status: unsupported ? null : status,
    pending: unsupported ? null : pending,
    saving,
    failure,
    reload,
    setEnabled: (on) => change('switch', () => source.set(on)),
    setOverride: (agentId, override) => change(agentId, () => source.override(agentId, override)),
    approve: (code) => change(`pairing:${code}`, () => source.approve(code)),
    soul: (agentId) => (unsupported ? null : status?.souls.find((s) => s.agentId === agentId) ?? null),
  } : HIDDEN, [source, unsupported, status, pending, saving, failure, reload, change]);
  return <SandboxContext.Provider value={api}>{children}</SandboxContext.Provider>;
}

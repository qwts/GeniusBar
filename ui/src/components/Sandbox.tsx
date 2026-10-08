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

/** `agent-bot sandbox on|off|account --json`: the settings as agent-bot keeps them. */
export interface SandboxSettings {
  enabled: boolean;
  provider: string;
  account: string;
}

/**
 * What came of `sandbox account NAME` (#66): agent-bot confirmed the name
 * (`set`), refused it with its own reason (`refused`: a bad name, the owner
 * declining, …), or gave no clear answer (`unknown`: nothing parseable, the
 * engine unreachable, or a setting naming another account). After
 * `unknown` the status is read again before anything is claimed.
 */
export type SandboxAccountOutcome =
  | { kind: 'set'; account: string }
  | { kind: 'refused'; code: string; message: string }
  | { kind: 'unknown'; message: string | null };

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

export function normalizeSandboxSettings(raw: unknown): SandboxSettings | null {
  if (!isRecord(raw) || typeof raw.enabled !== 'boolean' || typeof raw.account !== 'string') return null;
  return {
    enabled: raw.enabled,
    provider: typeof raw.provider === 'string' ? raw.provider : 'standard_macos_account',
    account: raw.account,
  };
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
  /**
   * Names the sandbox account (`agent-bot sandbox account NAME`, #66): picks
   * an existing standard account, creating, renaming or moving nothing.
   * agent-bot validates the name and asks the owner; a refusal rejects with
   * its code and reason as they are, and `sandbox-account-unsupported` says
   * the bundled agent-bot has no such command.
   */
  account: (name: string) => Promise<SandboxSettings>;
  /** Whether the bundled agent-bot has `sandbox account`; rejects when it cannot be asked. */
  accountSupported: () => Promise<boolean>;
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
  account: (name) => call('sandbox_account', { account: name }, normalizeSandboxSettings, 'agent-bot gave no sandbox setting'),
  accountSupported: () => call('sandbox_account_probe', {}, (raw) => (isRecord(raw) && typeof raw.supported === 'boolean' ? raw.supported : null), 'agent-bot gave no answer about sandbox account'),
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
  /** Reads the status again; settles once the read lands (never rejects). */
  reload: () => Promise<void>;
  setEnabled: (on: boolean) => void;
  setOverride: (agentId: string, override: SandboxOverride) => void;
  approve: (code: string) => void;
  /**
   * Names the sandbox account (#66) and reports what agent-bot said, without
   * reading again: the account dialog does that itself, so it can say it is
   * re-reading after an unclear answer before it shows anything else.
   * `saving` is `account` meanwhile.
   */
  setAccount: (name: string) => Promise<SandboxAccountOutcome>;
  /** Whether the bundled agent-bot has `sandbox account`, asked once and remembered; false gates the dialog. */
  accountSupported: () => Promise<boolean>;
  soul: (agentId: string) => SandboxSoul | null;
}

const HIDDEN: SandboxApi = {
  hidden: true, status: null, pending: null, saving: null, failure: null,
  reload: async () => {}, setEnabled: () => {}, setOverride: () => {}, approve: () => {},
  setAccount: async () => ({ kind: 'unknown', message: null }), accountSupported: async () => false, soul: () => null,
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
  const supported = useRef<Promise<boolean> | null>(null);
  const reload = useCallback(() => {
    if (!source) return Promise.resolve();
    const mine = ++ticket.current;
    return source.status().then(
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
  const setAccount = useCallback(async (name: string): Promise<SandboxAccountOutcome> => {
    if (!source) return { kind: 'unknown', message: null };
    setSaving('account');
    setFailure(null);
    try {
      const settings = await source.account(name);
      // A setting naming another account is no confirmation: read again before saying anything.
      return settings.account === name ? { kind: 'set', account: name } : { kind: 'unknown', message: null };
    } catch (error) {
      const e = error as { code?: unknown; message?: unknown };
      const code = typeof e?.code === 'string' ? e.code : 'sandbox-failed';
      const message = typeof e?.message === 'string' ? e.message : String(error);
      if (code === 'sandbox-unsupported') setUnsupported(true);
      // agent-bot's own codes (invalid-account, owner-approval-denied, …) are
      // refusals; the bridge's own say nothing parseable came back.
      return code === 'sandbox-failed' || code === 'sandbox-unavailable' ? { kind: 'unknown', message } : { kind: 'refused', code, message };
    } finally {
      setSaving(null);
    }
  }, [source]);
  const accountSupported = useCallback(() => {
    if (!source) return Promise.resolve(false);
    // Asked once per provider; an answer that cannot be had counts as supported, and a save then says what is wrong.
    supported.current ??= source.accountSupported().catch(() => true);
    return supported.current;
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
    setAccount,
    accountSupported,
    soul: (agentId) => (unsupported ? null : status?.souls.find((s) => s.agentId === agentId) ?? null),
  } : HIDDEN, [source, unsupported, status, pending, saving, failure, reload, change, setAccount, accountSupported]);
  return <SandboxContext.Provider value={api}>{children}</SandboxContext.Provider>;
}

// First-run setup state (#9): which steps are done, and whether the
// connection calls for setup at all.
import type { ConnectionSnapshot } from './status';

export type SetupStep = 'broker' | 'account' | 'principal' | 'daemon';
export type StepState = 'pending' | 'running' | 'done';

export interface SetupState {
  running: boolean;
  steps: Record<SetupStep, StepState>;
  error: string | null;
}

export const SETUP_STEPS: readonly { step: SetupStep; label: string }[] = [
  { step: 'broker', label: 'Start GeniusBar’s background service' },
  { step: 'account', label: 'Connect this account' },
  { step: 'principal', label: 'Connect GeniusBar' },
  { step: 'daemon', label: 'Start your agents' },
];

/** One service from another install, as `inspect_services` reports it. */
export interface ExistingService {
  label: string;
  program: string[];
  version: string | null;
  homebrew: boolean;
}
export interface ExistingServices {
  broker: ExistingService | null;
  daemon: ExistingService | null;
}

/** A short description of another install's services, or null when there are none. */
export function describeExisting(existing: ExistingServices | null | undefined): string | null {
  if (!existing || (!existing.broker && !existing.daemon)) return null;
  const from = existing.broker?.homebrew || existing.daemon?.homebrew ? ' from Homebrew' : '';
  const parts = [
    existing.broker && `agent-comms${existing.broker.version ? ` ${existing.broker.version}` : ''}`,
    existing.daemon && `agent-bot${existing.daemon.version ? ` ${existing.daemon.version}` : ''}`,
  ].filter(Boolean);
  return `${parts.join(' and ')}${from}`;
}

export const idleSetup: SetupState = {
  running: false,
  steps: { broker: 'pending', account: 'pending', principal: 'pending', daemon: 'pending' },
  error: null,
};

/** Setup is offered when GeniusBar is unpaired, or no broker has answered yet. */
export function needsSetup(c: ConnectionSnapshot): boolean {
  return c.bridgeConnected && (c.unpaired || (c.brokerUnreachable && c.lastRefresh === null));
}

export function applyProgress(s: SetupState, progress: { step?: unknown; state?: unknown }): SetupState {
  const step = progress.step as SetupStep;
  if (!(step in s.steps) || (progress.state !== 'running' && progress.state !== 'done')) return s;
  return { ...s, steps: { ...s.steps, [step]: progress.state } };
}

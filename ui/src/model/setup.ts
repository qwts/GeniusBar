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
  { step: 'broker', label: 'Start the agent-comms broker' },
  { step: 'account', label: 'Pair this account' },
  { step: 'principal', label: 'Pair GeniusBar as your principal' },
  { step: 'daemon', label: 'Start the agent-bot daemon' },
];

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

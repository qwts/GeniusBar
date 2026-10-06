// First-run setup state (#9): which steps are done, and whether the
// connection calls for setup at all.
import { translate, type Translate } from '../lib/i18n';
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
  state: 'running' | 'stopped';
}
export interface ExistingServices {
  broker: ExistingService | null;
  daemon: ExistingService | null;
}

/** A short description of another install's services, or null when there are none. */
export function describeExisting(existing: ExistingServices | null | undefined, t: Translate = (key, vars) => translate('en', key, vars)): string | null {
  if (!existing || (!existing.broker && !existing.daemon)) return null;
  const parts = [
    existing.broker && `agent-comms${existing.broker.version ? ` ${existing.broker.version}` : ''} (${t(`setup.${existing.broker.state}`)})`,
    existing.daemon && `agent-bot${existing.daemon.version ? ` ${existing.daemon.version}` : ''} (${t(`setup.${existing.daemon.state}`)})`,
  ].filter(Boolean);
  const services = parts.join(t('list.and'));
  return existing.broker?.homebrew || existing.daemon?.homebrew ? t('setup.homebrew', { services }) : services;
}

export const idleSetup: SetupState = {
  running: false,
  steps: { broker: 'pending', account: 'pending', principal: 'pending', daemon: 'pending' },
  error: null,
};

/**
 * Setup is offered when GeniusBar is unpaired, or no broker has answered
 * yet, unless its installed services are still starting (#118).
 */
export function needsSetup(c: ConnectionSnapshot): boolean {
  return c.bridgeConnected && (c.unpaired || (c.brokerUnreachable && c.lastRefresh === null && !c.starting));
}

export function applyProgress(s: SetupState, progress: { step?: unknown; state?: unknown }): SetupState {
  const step = progress.step as SetupStep;
  if (!(step in s.steps) || (progress.state !== 'running' && progress.state !== 'done')) return s;
  return { ...s, steps: { ...s.steps, [step]: progress.state } };
}

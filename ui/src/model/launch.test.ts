import { describe, expect, it } from 'vitest';
import {
  harnessOptions,
  preferredHarness,
  suggestedName,
  applyStatus,
  applyStatusError,
  canLaunch,
  launchErrorText,
  launchParams,
  launchProblem,
  MAX_HARNESS,
  MAX_NAME,
  MAX_PACKAGE,
  type LaunchRequest,
  type LaunchState,
} from './launch';

const soul: LaunchRequest = { account: 'user', target: { soul: 'agent_1' }, harness: 'codex', name: '' };
const pkg: LaunchRequest = { account: 'user', target: { package: '/souls/p' }, harness: 'codex', name: ' Helper ' };
const pending: LaunchState = { phase: 'pending', requestId: 'launch_1', note: null };

describe('launch requests', () => {
  it('builds params with exactly one target and no blank name', () => {
    expect(launchParams(soul)).toEqual({ account: 'user', soul: 'agent_1', harness: 'codex' });
    expect(launchParams(pkg)).toEqual({ account: 'user', package: '/souls/p', harness: 'codex', name: 'Helper' });
    expect(launchParams({ ...pkg, comms: false })).toMatchObject({ comms: false });
    expect(launchParams({ ...soul, comms: true })).toMatchObject({ comms: true });
  });

  it('enforces the wire contract limits', () => {
    expect(launchProblem(soul)).toBeNull();
    expect(launchProblem({ ...soul, account: ' ' })).toMatch(/account/);
    expect(launchProblem({ ...pkg, target: { package: '' } })).toMatch(/package path/);
    expect(launchProblem({ ...pkg, target: { package: 'p'.repeat(MAX_PACKAGE + 1) } })).toMatch(/longer/);
    expect(launchProblem({ ...soul, harness: '' })).toMatch(/harness/);
    expect(launchProblem({ ...soul, harness: 'h'.repeat(MAX_HARNESS + 1) })).toMatch(/longer/);
    expect(launchProblem({ ...soul, name: 'n'.repeat(MAX_NAME) })).toBeNull();
    expect(launchProblem({ ...soul, name: 'n'.repeat(MAX_NAME + 1) })).toMatch(/longer/);
    expect(launchProblem({ ...soul, name: 'a\nb' })).toMatch(/control/);
  });
});

describe('harness options', () => {
  it('lists the known harnesses first, then census and chosen ones once each', () => {
    expect(harnessOptions([], null).map((h) => h.id)).toEqual(['claude', 'opencode', 'muse']);
    expect(harnessOptions(['grokbot', 'claude', ' '], 'codex', 'grokbot').map((h) => h.id))
      .toEqual(['claude', 'opencode', 'muse', 'grokbot', 'codex']);
    expect(harnessOptions([])[0]).toEqual({ id: 'claude', label: 'Claude Code' });
  });
});

describe('launch lifecycle', () => {
  it('allows one unresolved launch at a time', () => {
    expect(canLaunch({ phase: 'idle' })).toBe(true);
    expect(canLaunch({ phase: 'requesting' })).toBe(false);
    expect(canLaunch(pending)).toBe(false);
    expect(canLaunch({ phase: 'failed', requestId: 'launch_1', agentId: null, detail: null })).toBe(true);
  });

  it('ends on launched or failed, keeping the daemon detail', () => {
    expect(applyStatus(pending, { status: 'pending', agentId: null })).toEqual(pending);
    expect(applyStatus(pending, { status: 'launched', agentId: 'agent_9' }))
      .toEqual({ phase: 'launched', requestId: 'launch_1', agentId: 'agent_9' });
    expect(applyStatus(pending, { status: 'failed', agentId: null, detail: 'no GitHub identity' }))
      .toEqual({ phase: 'failed', requestId: 'launch_1', agentId: null, detail: 'no GitHub identity' });
    expect(applyStatus(pending, { status: 'failed' })).toMatchObject({ phase: 'failed', detail: null });
  });

  it('keeps polling through transient status errors and stops on final ones', () => {
    expect(applyStatusError(pending, 'broker-unreachable', 'down')).toMatchObject({ phase: 'pending', note: 'Still waiting for the launch to finish. GeniusBar will keep checking.' });
    expect(applyStatusError(pending, 'unknown-launch', '')).toMatchObject({ phase: 'error', requestId: 'launch_1' });
  });

  it('explains a missing daemon for the account', () => {
    expect(launchErrorText('daemon-unavailable', '', 'persona')).toMatch(/can’t reach the agents on account persona/);
    expect(launchErrorText('weird', 'x')).toBe('GeniusBar couldn’t start this companion. Try again, and ask for help if the problem continues.');
  });
});

describe('opened package prefill (#120)', () => {
  it('suggests the first segment of the package name', () => {
    expect(suggestedName('VMTwo - Starter')).toBe('VMTwo');
    expect(suggestedName('  Luna ')).toBe('Luna');
    expect(suggestedName(undefined)).toBe('');
    expect(suggestedName('x'.repeat(200))).toHaveLength(128);
  });
  it('prefers the first harness the app can offer', () => {
    expect(preferredHarness(['codex', 'opencode'], [])).toBe('opencode');
    expect(preferredHarness(['codex'], ['codex'])).toBe('codex');
    expect(preferredHarness(['codex'], [])).toBeNull();
    expect(preferredHarness(undefined, ['claude'])).toBeNull();
  });
});

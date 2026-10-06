import { describe, expect, it } from 'vitest';
import {
  harnessOptions,
  preferredHarness,
  prefillHarness,
  suggestedName,
  applyStatus,
  applyStatusError,
  canLaunch,
  launchErrorText,
  launchParams,
  launchProblem,
  normalPackagePath,
  MAX_BRIEF,
  MAX_HARNESS,
  MAX_MODEL,
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

  it('never sends a name for an existing soul, so a relaunch cannot rename it (#79)', () => {
    expect(launchParams({ ...soul, name: 'Scott' })).toEqual({ account: 'user', soul: 'agent_1', harness: 'codex' });
    expect(launchParams({ ...pkg, name: 'Scott' }).name).toBe('Scott');
  });

  it('sends a chosen model trimmed, and no model key for the harness default (#128)', () => {
    expect(launchParams({ ...soul, model: ' claude-opus-4-1 ' })).toEqual({ account: 'user', soul: 'agent_1', harness: 'codex', model: 'claude-opus-4-1' });
    expect('model' in launchParams({ ...soul, model: '  ' })).toBe(false);
    expect('model' in launchParams({ ...soul, model: undefined })).toBe(false);
    expect(launchProblem({ ...soul, model: 'm'.repeat(MAX_MODEL) })).toBeNull();
    expect(launchProblem({ ...soul, model: 'm'.repeat(MAX_MODEL + 1) })).toMatch(/model is longer/);
    expect(launchProblem({ ...soul, model: 'a\tb' })).toMatch(/control/);
  });

  it('sends a brief trimmed, keeps its lines, and no brief key when blank (#120)', () => {
    const base: LaunchRequest = { account: 'u', target: { package: '/p.soul' }, harness: 'claude', name: '' };
    expect(launchParams({ ...base, brief: '  Keep notes.\r\nFlag gaps.  ' }).brief).toBe('Keep notes.\nFlag gaps.');
    expect('brief' in launchParams({ ...base, brief: ' \n ' })).toBe(false);
    expect('brief' in launchParams(base)).toBe(false);
    expect(launchParams({ ...base, target: { soul: 'agent_1' }, brief: 'Relaunch brief' }).brief).toBe('Relaunch brief');
  });

  it('refuses a brief over MAX_BRIEF or with control characters other than lines and tabs (#120)', () => {
    const base: LaunchRequest = { account: 'u', target: { package: '/p.soul' }, harness: 'claude', name: '' };
    expect(launchProblem({ ...base, brief: 'x'.repeat(MAX_BRIEF) })).toBeNull();
    expect(launchProblem({ ...base, brief: `  ${'x'.repeat(MAX_BRIEF)}  ` })).toBeNull();
    expect(launchProblem({ ...base, brief: 'x'.repeat(MAX_BRIEF + 1) })).toBe(`The brief is longer than ${MAX_BRIEF} characters.`);
    expect(launchProblem({ ...base, brief: 'one\n\ttwo' })).toBeNull();
    expect(launchProblem({ ...base, brief: 'bell\u0007' })).toMatch(/control characters from the brief/);
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
  it('prefills the soul\'s harness, then the package\'s, then the default (#120)', () => {
    expect(prefillHarness('codex', 'opencode', 'claude')).toBe('codex');
    expect(prefillHarness(null, 'opencode', 'claude')).toBe('opencode');
    expect(prefillHarness(undefined, null, 'claude')).toBe('claude');
    expect(prefillHarness(null, null, null)).toBe('');
  });
  it('prefers the first harness the app can offer', () => {
    expect(preferredHarness(['codex', 'opencode'], [])).toBe('opencode');
    expect(preferredHarness(['codex'], ['codex'])).toBe('codex');
    expect(preferredHarness(['codex'], [])).toBeNull();
    expect(preferredHarness(undefined, ['claude'])).toBeNull();
  });
});

describe('normalPackagePath (#116)', () => {
  it('drops trailing slashes but keeps the root', () => {
    expect(normalPackagePath('/Users/admin/Desktop/VMShare.soul/')).toBe('/Users/admin/Desktop/VMShare.soul');
    expect(normalPackagePath('/souls/a.soul///')).toBe('/souls/a.soul');
    expect(normalPackagePath('/souls/a.soul')).toBe('/souls/a.soul');
    expect(normalPackagePath('/')).toBe('/');
    expect(normalPackagePath('')).toBe('');
  });

  it('validates and sends the path without its trailing slash', () => {
    const request: LaunchRequest = { account: 'user', target: { package: '/souls/a.soul/' }, harness: 'claude', name: '' };
    expect(launchProblem(request)).toBeNull();
    expect(launchParams(request).package).toBe('/souls/a.soul');
  });
});

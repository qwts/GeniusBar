import { describe, expect, it } from 'vitest';
import {
  harnessOptions,
  launchNeedsHarnessSignIn,
  preferredHarness,
  prefillHarness,
  suggestedName,
  applyStatus,
  applyStatusError,
  canLaunch,
  launchErrorText,
  launchSandbox,
  launchParams,
  launchProblem,
  launchDraftErrors,
  normalPackagePath,
  parentChoices,
  MAX_BRIEF,
  MAX_HARNESS,
  MAX_MODEL,
  MAX_NAME,
  MAX_PACKAGE,
  type LaunchRequest,
  type LaunchState,
} from './launch';
import type { CensusRow } from './census';

const soul: LaunchRequest = { account: 'user', target: { soul: 'agent_1' }, harness: 'codex', name: '' };
const pkg: LaunchRequest = { account: 'user', target: { package: '/souls/p' }, harness: 'codex', name: ' Helper ' };
const pending: LaunchState = { phase: 'pending', requestId: 'launch_1', note: null, stage: null };

describe('launch requests', () => {
  it('builds params with exactly one target and no blank name', () => {
    expect(launchParams(soul)).toEqual({ account: 'user', soul: 'agent_1', harness: 'codex' });
    expect(launchParams(pkg)).toEqual({ account: 'user', package: '/souls/p', harness: 'codex', name: 'Helper' });
    expect(launchParams({ ...pkg, comms: false })).toMatchObject({ comms: false });
    expect(launchParams({ ...soul, comms: true })).toMatchObject({ comms: true });
  });

  it('sends a trimmed role only for a package launch (agent-bot-identity#535)', () => {
    expect(launchParams({ ...pkg, role: '  Researcher ' })).toMatchObject({ role: 'Researcher' });
    expect(Object.hasOwn(launchParams({ ...pkg, role: '   ' }), 'role')).toBe(false);
    expect(Object.hasOwn(launchParams(pkg), 'role')).toBe(false);
    expect(Object.hasOwn(launchParams({ ...soul, role: 'Researcher' }), 'role')).toBe(false);
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

  it('retains structured launch failure codes and recognizes only an explicit harness sign-out', () => {
    const refused = applyStatus(pending, {
      status: 'failed',
      code: 'harness-signed-out',
      detail: 'harness-signed-out: codex is signed out; launch again',
    });
    expect(refused).toMatchObject({ phase: 'failed', code: 'harness-signed-out', detail: 'harness-signed-out: codex is signed out; launch again' });
    expect(launchNeedsHarnessSignIn(refused)).toBe(true);
    expect(launchNeedsHarnessSignIn({
      phase: 'failed', requestId: 'launch_1', agentId: null,
      detail: 'harness-signed-out: codex is signed out; launch again',
    })).toBe(true);

    for (const state of [
      { phase: 'failed', requestId: 'launch_1', agentId: null, code: 'harness-unknown', detail: 'harness-unknown: status unavailable' },
      { phase: 'failed', requestId: 'launch_1', agentId: null, code: 'other-code', detail: 'harness-signed-out: stale or conflicting detail' },
      { phase: 'failed', requestId: 'launch_1', agentId: null, detail: 'probe says harness-signed-out: prefix is not anchored' },
      { phase: 'failed', requestId: 'launch_1', agentId: null, detail: 'could not join the soul' },
      pending,
    ] as LaunchState[]) expect(launchNeedsHarnessSignIn(state)).toBe(false);
  });

  it('keeps the daemon\'s latest stage, never going back, and names it on a failure', () => {
    const account = applyStatus(pending, { status: 'pending', stage: 'account' });
    expect(account).toEqual({ ...pending, stage: 'account' });
    expect(applyStatus(account, { status: 'pending', stage: 'checking' })).toEqual(account);
    expect(applyStatus(account, { status: 'pending', stage: 'teleport' })).toEqual(account);
    expect(applyStatus(account, { status: 'pending' })).toEqual(account);
    const harness = applyStatus(account, { status: 'pending', stage: 'harness' });
    expect(harness).toEqual({ ...pending, stage: 'harness' });
    expect(applyStatus(harness, { status: 'failed', detail: 'codex is not on PATH', stage: 'harness' }))
      .toEqual({ phase: 'failed', requestId: 'launch_1', agentId: null, detail: 'codex is not on PATH', stage: 'harness' });
    expect(applyStatus(harness, { status: 'launched', agentId: 'agent_9' }))
      .toEqual({ phase: 'launched', requestId: 'launch_1', agentId: 'agent_9' });
    expect(applyStatusError(harness, 'broker-unreachable', 'down')).toMatchObject({ phase: 'pending', stage: 'harness' });
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

describe('launch sandbox: who the companion runs as (#66)', () => {
  const sandboxed = { resolution: 'sandboxed', account: 'gb-luna' } as const;

  it('reads it on a launched or refused result, and keeps it from a pending one', () => {
    expect(applyStatus(pending, { status: 'launched', agentId: 'agent_9', sandbox: sandboxed }))
      .toEqual({ phase: 'launched', requestId: 'launch_1', agentId: 'agent_9', sandbox: sandboxed });
    expect(applyStatus(pending, { status: 'failed', detail: 'refused: child cap', sandbox: { resolution: 'unrestricted', account: 'owner' } }))
      .toEqual({ phase: 'failed', requestId: 'launch_1', agentId: null, detail: 'refused: child cap', sandbox: { resolution: 'unrestricted', account: 'owner' } });
    const told = applyStatus(pending, { status: 'pending', sandbox: sandboxed });
    expect(told).toEqual({ ...pending, sandbox: sandboxed });
    expect(applyStatus(told, { status: 'pending' })).toEqual(told);
    expect(applyStatus(told, { status: 'launched', agentId: 'agent_9' })).toMatchObject({ phase: 'launched', sandbox: sandboxed });
  });

  it('leaves the state as before without one, or with a malformed one', () => {
    for (const sandbox of [undefined, null, 'sandboxed', [], {}, { resolution: 'jailed', account: 'x' }, { resolution: 'sandboxed' },
      { resolution: 'sandboxed', account: '  ' }, { resolution: 'sandboxed', account: 7 }, { resolution: 'sandboxed', account: 'a\nb' },
      { resolution: 'sandboxed', account: 'x'.repeat(257) }]) {
      expect(launchSandbox(sandbox)).toBeNull();
      expect(applyStatus(pending, { status: 'launched', agentId: 'agent_9', sandbox }))
        .toEqual({ phase: 'launched', requestId: 'launch_1', agentId: 'agent_9' });
    }
    expect(launchSandbox({ resolution: 'unrestricted', account: ' owner ', extra: true })).toEqual({ resolution: 'unrestricted', account: 'owner' });
  });
});

describe('launch parent (#261)', () => {
  const root: CensusRow = { account: 'user', agentId: 'agent_root', name: 'Root', harness: 'claude', parent: null, presence: 'joined', unacked: 0, lastWake: null };
  const kid: CensusRow = { ...root, agentId: 'agent_kid', name: 'Kid', parent: 'agent_root' };
  const grandkid: CensusRow = { ...root, agentId: 'agent_grandkid', name: 'Grandkid', parent: 'agent_kid' };
  const other: CensusRow = { ...root, agentId: 'agent_other', name: 'Other', parent: null };
  const gone: CensusRow = { ...root, agentId: 'agent_gone', name: 'Gone', parent: null };
  const roster = [root, kid, grandkid, other, gone];

  it('sends parent null for Independent, the trimmed id for a companion, and nothing when unstated', () => {
    expect(launchParams({ ...pkg, parent: null }).parent).toBeNull();
    expect(launchParams({ ...pkg, parent: ' agent_root ' }).parent).toBe('agent_root');
    expect('parent' in launchParams(pkg)).toBe(false);
  });

  it('refuses a blank or self parent before sending', () => {
    expect(launchProblem({ ...pkg, parent: null })).toBeNull();
    expect(launchProblem({ ...pkg, parent: ' ' })).toBe('Choose a parent companion, or Independent.');
    expect(launchProblem({ ...soul, parent: 'agent_1' })).toBe('A companion cannot be its own parent. Choose another, or Independent.');
    expect(launchProblem({ ...soul, parent: 'agent_2' })).toBeNull();
  });

  it('offers every companion but the archived, the soul itself and its descendants', () => {
    expect(parentChoices(roster, null).map((s) => s.agentId)).toEqual(['agent_root', 'agent_kid', 'agent_grandkid', 'agent_other', 'agent_gone']);
    expect(parentChoices(roster, null, new Set(['agent_gone'])).map((s) => s.agentId)).toEqual(['agent_root', 'agent_kid', 'agent_grandkid', 'agent_other']);
    expect(parentChoices(roster, root, new Set(['agent_gone'])).map((s) => s.agentId)).toEqual(['agent_other']);
    expect(parentChoices(roster, kid).map((s) => s.agentId)).toEqual(['agent_root', 'agent_other', 'agent_gone']);
    // A parent cycle in the census ends the walk rather than looping.
    const loopA: CensusRow = { ...root, agentId: 'a', parent: 'b' };
    const loopB: CensusRow = { ...root, agentId: 'b', parent: 'a' };
    expect(parentChoices([loopA, loopB, other], loopA).map((s) => s.agentId)).toEqual(['agent_other']);
  });

  it('lists every problem before launching, and refuses a companion parent the launch path cannot carry', () => {
    const draft = {
      soul: null, copy: false, customPackage: true, packagePath: '/souls/p.soul', name: 'Helper', account: 'user', harness: 'claude',
      model: null, brief: '', parent: null, parents: [root, other], parentCarried: false,
    };
    expect(launchDraftErrors(draft)).toEqual([]);
    expect(launchDraftErrors({ ...draft, copy: true, name: '', packagePath: '', account: '', harness: '', model: 'x'.repeat(121), brief: 'y'.repeat(4001) }).map((e) => e.code))
      .toEqual(['name', 'package', 'account', 'harness', 'modelLong', 'brief']);
    expect(launchDraftErrors({ ...draft, parent: 'agent_root' }).map((e) => e.code)).toEqual(['parentUncarried']);
    expect(launchDraftErrors({ ...draft, parent: 'agent_root', parentCarried: true })).toEqual([]);
    expect(launchDraftErrors({ ...draft, parent: 'agent_gone', parentCarried: true }).map((e) => e.code)).toEqual(['parent']);
    expect(launchDraftErrors({ ...draft, soul: kid, parent: 'agent_kid', parentCarried: true }).map((e) => e.code)).toEqual(['parentSelf']);
    // A relaunched child keeping its own parent asks for nothing new.
    expect(launchDraftErrors({ ...draft, soul: kid, parent: 'agent_root' })).toEqual([]);
    // Custom model ids pass: the harness knows what it runs.
    expect(launchDraftErrors({ ...draft, model: 'my-org/custom' })).toEqual([]);
  });
});

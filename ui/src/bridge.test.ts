import { describe, expect, it, vi } from 'vitest';
import { BridgeError, call, openDesktop, daemonStatus, decideApproval, harnessSignedIn, harnessSignIn, inApp, listApprovals, listAudit, exportAudit, normalizeDaemonStatus, normalizePopulationList, populationList, normalizeRemovedSoul, normalizeRemovalPlan, normalizeRemovalEffects, removalPlan, normalizeRuntimeMetrics, normalizeSoulColdWake, normalizeSoulComms, normalizeSoulMode, normalizeSoulModel, normalizeSoulPopulation, normalizeAppearance, savedBrief, setSoulColdWake, setSoulComms, setSoulMode, setSoulModel, servicesInstalled, soulAsides, soulColdWake, soulComms, soulMode, soulModel, soulPopulation, removeSoul, normalizeSoulStop, soulStopSupported, stopSoul, normalizeSoulPause, pauseSoul, resumeSoul, soulPauseSupported, normalizeSoulComputerUse, soulComputerUse, soulComputerUseSupported, liveComputerUse, listSoulTemplates, normalizeSoulTemplates, normalizeSoulProfile, soulProfile, soulProfileFile, popupVisible, normalizeSoulEnvironment, soulEnvironment, engineCan, normalizePreparedRevision, prepareRevision, discardRevision, editableInStaging } from './bridge';

describe('bridge', () => {
  it('invokes the shell command with the method and params', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => { calls.push([cmd, args]); return { souls: [] }; }) as never;
    await expect(call('census', {}, fake)).resolves.toEqual({ souls: [] });
    expect(calls).toEqual([['bridge', { method: 'census', params: {} }]]);
  });

  it('turns shell errors into BridgeError with their code', async () => {
    const fake = (async () => { throw { code: 'broker-unreachable', message: 'down' }; }) as never;
    const error = await call('census', {}, fake).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({ code: 'broker-unreachable', message: 'down' });
  });

  it('exports the audit log through the bridge and returns where it went', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => { calls.push([cmd, args]); return { path: '/Users/me/Downloads/geniusbar-audit-x.json' }; }) as never;
    await expect(exportAudit('[]', fake)).resolves.toEqual({ path: '/Users/me/Downloads/geniusbar-audit-x.json' });
    expect(calls).toEqual([['bridge', { method: 'auditExport', params: { contents: '[]' } }]]);
    const failing = (async () => { throw { code: 'export-failed', message: 'disk full' }; }) as never;
    await expect(exportAudit('[]', failing)).rejects.toMatchObject({ code: 'export-failed' });
  });

  it('outside the app, exports the audit log as the design does: a Blob download', async () => {
    const createObjectURL = vi.fn(() => 'blob:audit');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toMatch(/^geniusbar-audit-\d+\.json$/);
      expect(this.href).toBe('blob:audit');
    });
    await expect(exportAudit('[{"a":1}]')).resolves.toEqual({ path: null });
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:audit');
    click.mockRestore();
  });

  it('is not in the app under test', () => {
    expect(inApp()).toBe(false);
  });

  it('asks the shell to open the desktop window (#69)', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => { calls.push([cmd, args]); }) as never;
    await expect(openDesktop(fake)).resolves.toBeUndefined();
    expect(calls).toEqual([['open_desktop', undefined]]);
    const failing = (async () => { throw 'no window'; }) as never;
    await expect(openDesktop(failing)).rejects.toBe('no window');
  });
});

describe('soul comms (#71)', () => {
  const state = { agentId: 'agent_1', name: 'bill', managed: true, comms: false, running: false };

  it('reads agent-bot soul comms show, and is null when it cannot say', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => { calls.push([cmd, args]); return state; }) as never;
    await expect(soulComms('agent_1', fake)).resolves.toEqual({ agentId: 'agent_1', managed: true, comms: false, running: false });
    expect(calls).toEqual([['soul_comms', { action: 'show', soul: 'agent_1' }]]);
    const failing = (async () => { throw { code: 'soul-comms-failed', message: 'no record' }; }) as never;
    await expect(soulComms('agent_1', failing)).resolves.toBeNull();
    await expect(soulComms('agent_1')).resolves.toBeNull();
  });

  it('sets on or off and surfaces agent-bot refusals', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => { calls.push([cmd, args]); return { ...state, comms: true }; }) as never;
    await expect(setSoulComms('agent_1', true, fake)).resolves.toMatchObject({ comms: true });
    expect(calls).toEqual([['soul_comms', { action: 'on', soul: 'agent_1' }]]);
    const refused = (async () => { throw { code: 'soul-comms-failed', message: 'agent_1 is running' }; }) as never;
    await expect(setSoulComms('agent_1', false, refused)).rejects.toMatchObject({ code: 'soul-comms-failed', message: 'agent_1 is running' });
  });

  it('drops malformed states', () => {
    expect(normalizeSoulComms({ agentId: 'a' })).toBeNull();
    expect(normalizeSoulComms(null)).toBeNull();
    expect(normalizeSoulComms({ agentId: 'a', comms: true })).toBeNull();
    expect(normalizeSoulComms({ agentId: 'a', comms: true, managed: false })).toBeNull();
    expect(normalizeSoulComms({ agentId: 'a', comms: true, managed: false, running: false })).toEqual({ agentId: 'a', managed: false, comms: true, running: false });
  });
});

describe('normalizeRuntimeMetrics', () => {
  it('drops malformed entries and keeps well-formed ones', () => {
    const observedAt = '2026-10-03T12:00:00Z';
    const good = { metric: 'model_reported', value: 'claude-opus', unit: null, scope: 'call', source: 'claude-session-log', kind: 'reported', observedAt };
    const result = normalizeRuntimeMetrics({
      collectedAt: observedAt,
      souls: { agent_a: { lastCallAt: observedAt, observations: [good, null, { metric: 1 }] }, agent_b: null },
      errors: [null, { agentId: 'agent_a', source: 'claude-session-log', code: 'read-failed', message: 'failed' }],
      missing: [7, { agentId: 'agent_c', source: 'claude-session-log' }],
    });
    expect(result).toEqual({
      collectedAt: observedAt,
      souls: { agent_a: { lastCallAt: observedAt, observations: [good] } },
      errors: [{ agentId: 'agent_a', source: 'claude-session-log', code: 'read-failed', message: 'failed' }],
      missing: [{ agentId: 'agent_c', source: 'claude-session-log' }],
    });
  });

  it('reports unavailable for a payload without the snapshot shape', () => {
    for (const raw of [null, { unavailable: true }, { souls: [], errors: [], missing: [] }]) {
      expect(normalizeRuntimeMetrics(raw)).toEqual({ unavailable: true });
    }
  });
});

describe('agent-bot asides and approvals', () => {
  it('reads asides and approvals through the shell, null when it cannot', async () => {
    const calls: unknown[] = [];
    const fake = (async (command: string, args: unknown) => {
      calls.push([command, args]);
      return command === 'soul_asides' ? { agentId: 'agent_1', asides: [], next: null } : { approvals: [] };
    }) as never;
    await expect(soulAsides('agent_1', 'aside_9', fake)).resolves.toEqual({ asides: [], next: null });
    await expect(listApprovals(fake)).resolves.toEqual([]);
    expect(calls).toEqual([['soul_asides', { soul: 'agent_1', after: 'aside_9' }], ['approvals', { action: 'list' }]]);
    const failing = (async () => { throw { code: 'soul-asides-failed', message: 'x' }; }) as never;
    await expect(soulAsides('agent_1', null, failing)).resolves.toBeNull();
    await expect(listApprovals(failing)).resolves.toBeNull();
    await expect(soulAsides('agent_1', null)).resolves.toBeNull();
  });

  it('decides a proposal and keeps the shell’s error code', async () => {
    const ok = (async (_c: string, args: { action: string; proposal: string }) =>
      ({ proposalId: args.proposal, agentId: 'agent_1', status: args.action === 'deny' ? 'denied' : 'approved', summary: 's' })) as never;
    await expect(decideApproval('p1', 'deny', {}, ok)).resolves.toMatchObject({ proposalId: 'p1', status: 'denied' });
    const refused = (async () => { throw { code: 'not-open', message: 'p1 is not waiting on a decision' }; }) as never;
    await expect(decideApproval('p1', 'approve', {}, refused)).rejects.toMatchObject({ code: 'not-open' });
    await expect(decideApproval('p1', 'approve', {}, (async () => ({})) as never)).rejects.toMatchObject({ code: 'approvals-failed' });
  });

  it('asks for a session grant only when told to, and reads the scope and decision back', async () => {
    const calls: unknown[] = [];
    const granted = (async (_c: string, args: { proposal: string; scope?: string }) => {
      calls.push(args);
      return { proposalId: args.proposal, agentId: 'agent_1', status: 'approved', summary: 's',
        scope: args.scope ?? 'once', decision: args.scope === 'session' ? 'approved_session' : 'approved' };
    }) as never;
    await expect(decideApproval('p1', 'approve', { scope: 'session' }, granted))
      .resolves.toMatchObject({ proposalId: 'p1', status: 'approved', scope: 'session', decision: 'approved_session' });
    await expect(decideApproval('p1', 'approve', { scope: 'once' }, granted))
      .resolves.toMatchObject({ scope: 'once', decision: 'approved' });
    await expect(decideApproval('p1', 'deny', {}, granted)).resolves.toMatchObject({ scope: 'once' });
    expect(calls).toEqual([
      { action: 'approve', proposal: 'p1', scope: 'session' },
      { action: 'approve', proposal: 'p1' },
      { action: 'deny', proposal: 'p1' },
    ]);
    // An older bundle has neither field.
    const old = (async () => ({ proposalId: 'p1', agentId: 'agent_1', status: 'approved', summary: 's' })) as never;
    const record = await decideApproval('p1', 'approve', {}, old);
    expect(record).not.toHaveProperty('scope');
    expect(record).not.toHaveProperty('decision');
    const refused = (async () => { throw { code: 'approval-scope-unsupported', message: 'update agent-bot' }; }) as never;
    await expect(decideApproval('p1', 'approve', { scope: 'session' }, refused))
      .rejects.toMatchObject({ code: 'approval-scope-unsupported', message: 'update agent-bot' });
  });
});

describe('audit log (#122)', () => {
  it('reads agent-bot audit list for a soul or the fleet, dropping malformed records', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => {
      calls.push([cmd, args]);
      return { records: [{ at: '2026-10-05T10:00:00Z', event: 'permission', decision: 'allow' }, { at: 'x' }] };
    }) as never;
    await expect(listAudit('agent_1', fake)).resolves.toEqual([{ at: '2026-10-05T10:00:00Z', event: 'permission', decision: 'allow' }]);
    await expect(listAudit(null, fake)).resolves.toHaveLength(1);
    expect(calls).toEqual([['audit_list', { agent: 'agent_1' }], ['audit_list', { agent: null }]]);
  });

  it('is null when agent-bot cannot say', async () => {
    // An older bundle: the shell turns its usage line into an error.
    const older = (async () => { throw { code: 'audit-failed', message: 'agent-bot: usage: agent-bot soul' }; }) as never;
    await expect(listAudit('agent_1', older)).resolves.toBeNull();
    await expect(listAudit('agent_1', (async () => ({ error: {} })) as never)).resolves.toBeNull();
    await expect(listAudit(null)).resolves.toBeNull();
  });
});

describe('soul cold wake (#122)', () => {
  it('reads soul cold-wake show, normalized, and is null when it cannot say', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => {
      calls.push([cmd, args]);
      return { agentId: 'agent_1', setting: 'on', policy: null, lane: 'acp' };
    }) as never;
    await expect(soulColdWake('agent_1', fake)).resolves.toEqual({ on: true, lane: 'acp' });
    expect(calls).toEqual([['soul_cold_wake', { agent: 'agent_1', action: 'show' }]]);
    const failing = (async () => { throw { code: 'cold-wake-failed', message: 'owner only' }; }) as never;
    await expect(soulColdWake('agent_1', failing)).resolves.toBeNull();
    await expect(soulColdWake('agent_1')).resolves.toBeNull();
  });

  it('normalizes every setting shape agent-bot may give', () => {
    expect(normalizeSoulColdWake({ setting: 'off', lane: null })).toEqual({ on: false, lane: null });
    expect(normalizeSoulColdWake({ setting: 'resume', policy: 'read-only', lane: 'resume' })).toEqual({ on: true, lane: 'resume' });
    expect(normalizeSoulColdWake({ setting: true })).toEqual({ on: true, lane: 'acp' });
    expect(normalizeSoulColdWake({ setting: false })).toEqual({ on: false, lane: null });
    expect(normalizeSoulColdWake({ setting: { lane: 'webhook' } })).toEqual({ on: true, lane: 'webhook' });
    expect(normalizeSoulColdWake({})).toBeNull();
    expect(normalizeSoulColdWake({ setting: 3 })).toBeNull();
    expect(normalizeSoulColdWake('on')).toBeNull();
  });

  it('changes it through agent-bot, which asks the owner; a refusal rejects', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => {
      calls.push([cmd, args]);
      return { agentId: 'agent_1', setting: 'off', policy: null, lane: null };
    }) as never;
    await expect(setSoulColdWake('agent_1', false, fake)).resolves.toEqual({ on: false, lane: null });
    expect(calls).toEqual([['soul_cold_wake', { agent: 'agent_1', action: 'off' }]]);
    const refused = (async () => { throw { code: 'cold-wake-failed', message: 'the owner did not approve' }; }) as never;
    await expect(setSoulColdWake('agent_1', true, refused)).rejects.toMatchObject({ code: 'cold-wake-failed', message: 'the owner did not approve' });
    const empty = (async () => ({})) as never;
    await expect(setSoulColdWake('agent_1', true, empty)).rejects.toBeInstanceOf(BridgeError);
  });
});

describe('soul population record (#122)', () => {
  it('keeps the App slug and a recorded sign-in failure, and is null when it cannot say', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => {
      calls.push([cmd, args]);
      return { agentId: 'agent_1', appSlug: 'luna-bot', harnessAuth: { status: 'expired', harness: 'claude', since: '2026-10-05T10:00:00Z' } };
    }) as never;
    await expect(soulPopulation('agent_1', fake)).resolves.toEqual({
      agentId: 'agent_1', appSlug: 'luna-bot', harnessAuth: { status: 'expired', harness: 'claude', since: '2026-10-05T10:00:00Z' },
    });
    expect(calls).toEqual([['soul_population', { agent: 'agent_1' }]]);
    await expect(soulPopulation('agent_1', (async () => { throw new Error('no'); }) as never)).resolves.toBeNull();
    await expect(soulPopulation('agent_1')).resolves.toBeNull();
  });

  it('drops a malformed sign-in failure or slug', () => {
    expect(normalizeSoulPopulation({ agentId: 'a', appSlug: '', harnessAuth: { status: 'stale', harness: 'claude' } }))
      .toEqual({ agentId: 'a', appSlug: null, harnessAuth: null });
    expect(normalizeSoulPopulation({ agentId: 'a', harnessAuth: { status: 'signed-out', harness: 'codex' } }))
      .toEqual({ agentId: 'a', appSlug: null, harnessAuth: { status: 'signed-out', harness: 'codex', since: null } });
    expect(normalizeSoulPopulation({ appSlug: 'x' })).toBeNull();
    // The computer-use switch (agent-bot-identity #482) only when agent-bot says.
    expect(normalizeSoulPopulation({ agentId: 'a', computerUse: false })?.computerUse).toBe(false);
    expect(normalizeSoulPopulation({ agentId: 'a', computerUse: 'off' })).not.toHaveProperty('computerUse');
  });

  it('carries the saved launch brief (#120) only when there is one', async () => {
    expect(normalizeSoulPopulation({ agentId: 'a', brief: 'Review open PRs' })?.brief).toBe('Review open PRs');
    expect(normalizeSoulPopulation({ agentId: 'a', brief: '  ' })).not.toHaveProperty('brief');
    expect(normalizeSoulPopulation({ agentId: 'a', brief: null })).not.toHaveProperty('brief');
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => { calls.push([cmd, args]); return { agentId: 'agent_1', brief: 'Triage the inbox' }; }) as never;
    await expect(savedBrief('agent_1', fake)).resolves.toBe('Triage the inbox');
    expect(calls).toEqual([['soul_population', { agent: 'agent_1' }]]);
    await expect(savedBrief('agent_1', (async () => ({ agentId: 'agent_1', brief: null })) as never)).resolves.toBeNull();
    await expect(savedBrief('agent_1', (async () => { throw new Error('no'); }) as never)).rejects.toThrow('no');
    await expect(savedBrief('agent_1')).resolves.toBeNull();
  });
});

describe('harness sign-in for a soul (#122)', () => {
  it('reads harness auth status with --soul, and is null when it cannot say', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => { calls.push([cmd, args]); return { harness: 'claude', loggedIn: true }; }) as never;
    await expect(harnessSignedIn('claude', 'agent_1', fake)).resolves.toBe(true);
    expect(calls).toEqual([['harness_auth', { action: 'status', harness: 'claude', soul: 'agent_1' }]]);
    await expect(harnessSignedIn('claude', 'agent_1', (async () => ({})) as never)).resolves.toBeNull();
    await expect(harnessSignedIn('claude', 'agent_1')).resolves.toBeNull();
  });

  it('runs the harness sign-in and rejects with its reason', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => { calls.push([cmd, args]); return { harness: 'claude', loggedIn: true }; }) as never;
    await expect(harnessSignIn('claude', 'agent_1', fake)).resolves.toBe(true);
    expect(calls).toEqual([['harness_auth', { action: 'login', harness: 'claude', soul: 'agent_1' }]]);
    const failed = (async () => { throw { code: 'harness-auth-failed', message: 'claude sign-in did not finish' }; }) as never;
    await expect(harnessSignIn('claude', 'agent_1', failed)).rejects.toMatchObject({ code: 'harness-auth-failed', message: 'claude sign-in did not finish' });
  });
});

describe('soul execution mode (#122)', () => {
  it('reads soul mode show, and is null when agent-bot cannot say', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => {
      calls.push([cmd, args]);
      return { agentId: 'agent_1', mode: 'autopilot' };
    }) as never;
    await expect(soulMode('agent_1', fake)).resolves.toBe('autopilot');
    expect(calls).toEqual([['soul_mode', { agent: 'agent_1', action: 'show' }]]);
    // agent-bot 0.10.14 has no `soul mode`: the shell reports a failure.
    const older = (async () => { throw { code: 'soul-mode-failed', message: 'unknown command' }; }) as never;
    await expect(soulMode('agent_1', older)).resolves.toBeNull();
    await expect(soulMode('agent_1', (async () => ({ agentId: 'agent_1', mode: 'yolo' })) as never)).resolves.toBeNull();
    await expect(soulMode('agent_1')).resolves.toBeNull();
  });

  it('normalizes only the two modes', () => {
    expect(normalizeSoulMode({ agentId: 'a', mode: 'safe' })).toBe('safe');
    expect(normalizeSoulMode({ mode: 'autopilot' })).toBe('autopilot');
    expect(normalizeSoulMode({})).toBeNull();
    expect(normalizeSoulMode('safe')).toBeNull();
  });

  it('switches it through agent-bot, which asks the owner; a refusal rejects with the reason', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => {
      calls.push([cmd, args]);
      return { agentId: 'agent_1', mode: 'safe' };
    }) as never;
    await expect(setSoulMode('agent_1', 'safe', fake)).resolves.toBe('safe');
    expect(calls).toEqual([['soul_mode', { agent: 'agent_1', action: 'safe' }]]);
    const refused = (async () => { throw { code: 'soul-mode-failed', message: 'the owner did not approve' }; }) as never;
    await expect(setSoulMode('agent_1', 'autopilot', refused)).rejects.toMatchObject({ code: 'soul-mode-failed', message: 'the owner did not approve' });
    await expect(setSoulMode('agent_1', 'autopilot', (async () => ({})) as never)).rejects.toBeInstanceOf(BridgeError);
  });
});

describe('soul model (#128)', () => {
  const shown = {
    agentId: 'agent_1', model: 'opus', harness: 'claude', listedAt: '2026-10-05T00:00:00.000Z',
    available: [{ modelId: 'opus', name: 'Opus', description: 'Most capable' }, { modelId: 'sonnet', name: 'Sonnet' }],
  };

  it('reads soul model show, and is null when agent-bot cannot say', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => { calls.push([cmd, args]); return shown; }) as never;
    await expect(soulModel('agent_1', fake)).resolves.toEqual({
      model: 'opus', listedAt: '2026-10-05T00:00:00.000Z',
      available: [{ modelId: 'opus', name: 'Opus', description: 'Most capable' }, { modelId: 'sonnet', name: 'Sonnet', description: null }],
    });
    expect(calls).toEqual([['soul_model', { agent: 'agent_1', action: 'show' }]]);
    // agent-bot 0.10.14 has no `soul model`: the shell reports a failure.
    const older = (async () => { throw { code: 'soul-model-failed', message: 'unknown command' }; }) as never;
    await expect(soulModel('agent_1', older)).resolves.toBeNull();
    await expect(soulModel('agent_1', (async () => ({ agentId: 'agent_1' })) as never)).resolves.toBeNull();
    await expect(soulModel('agent_1')).resolves.toBeNull();
  });

  it('normalizes the default, an unlisted harness and malformed list entries', () => {
    expect(normalizeSoulModel({ agentId: 'a', model: null, available: null, listedAt: null }))
      .toEqual({ model: null, available: null, listedAt: null });
    expect(normalizeSoulModel({ model: null, available: [{ modelId: 'x' }, { name: 'no id' }, 'junk'] }))
      .toEqual({ model: null, available: [{ modelId: 'x', name: 'x', description: null }], listedAt: null });
    expect(normalizeSoulModel({ model: 3 })).toBeNull();
    expect(normalizeSoulModel({ model: '' })).toBeNull();
    expect(normalizeSoulModel({})).toBeNull();
    expect(normalizeSoulModel(null)).toBeNull();
  });

  it('sets or clears it through agent-bot, which asks the owner; a refusal rejects with the reason', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => { calls.push([cmd, args]); return shown; }) as never;
    await expect(setSoulModel('agent_1', 'opus', fake)).resolves.toMatchObject({ model: 'opus' });
    await setSoulModel('agent_1', null, fake);
    expect(calls).toEqual([
      ['soul_model', { agent: 'agent_1', action: 'set', model: 'opus' }],
      ['soul_model', { agent: 'agent_1', action: 'clear' }],
    ]);
    const refused = (async () => { throw { code: 'soul-model-failed', message: 'the owner did not approve' }; }) as never;
    await expect(setSoulModel('agent_1', 'opus', refused)).rejects.toMatchObject({ code: 'soul-model-failed', message: 'the owner did not approve' });
    await expect(setSoulModel('agent_1', 'opus', (async () => ({})) as never)).rejects.toBeInstanceOf(BridgeError);
  });
});

describe('archive a soul (#94)', () => {
  it('runs soul remove through the shell and normalizes the result', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => {
      calls.push([cmd, args]);
      return { agentId: 'agent_1', name: 'luna', handle: 'luna', wake: 'off', comms: 'left', retired: true,
        archived: [{ from: '/souls/luna', to: '/souls/.archive/luna' }, { from: 3 }] };
    }) as never;
    await expect(removeSoul('agent_1', null, fake)).resolves.toEqual({
      agentId: 'agent_1', name: 'luna', comms: 'left', archived: [{ from: '/souls/luna', to: '/souls/.archive/luna' }],
    });
    expect(calls).toEqual([['soul_remove', { agent: 'agent_1' }]]);
  });

  it('rejects with agent-bot’s reason, keeping its code', async () => {
    const running = (async () => { throw { code: 'soul-running', message: 'agent_1 is running; stop it before removing it' }; }) as never;
    await expect(removeSoul('agent_1', null, running)).rejects.toMatchObject({ code: 'soul-running', message: 'agent_1 is running; stop it before removing it' });
    // An older bundle answers without retiring.
    await expect(removeSoul('agent_1', null, (async () => ({ agentId: 'agent_1' })) as never)).rejects.toBeInstanceOf(BridgeError);
    expect(normalizeRemovedSoul({ agentId: 'a', retired: false })).toBeNull();
  });
});

describe('removal plan and scope (#283)', () => {
  /** agent-bot-identity #625's team plan for luna, with a nested offline descendant. */
  const plan = {
    schemaVersion: 1, scope: 'team', agentId: 'agent_p',
    capabilities: { plan: true, team: true, independent: true, restore: false, delete: false },
    archived: [
      { agentId: 'agent_p', name: 'luna', displayName: 'luna', status: 'active', harness: 'codex', parentId: null, running: false, depth: 0 },
      { agentId: 'agent_c', name: null, displayName: 'agent_c', status: 'active', harness: null, parentId: 'agent_p', running: false, depth: 1 },
      { agentId: 'agent_s', name: 'sprocket', displayName: 'Sprocket', status: 'active', harness: null, parentId: 'agent_c', running: null, depth: 2 },
    ],
    independent: [], unchanged: [{ agentId: 'agent_r', name: 'rusty', displayName: 'rusty', status: 'retired', harness: null, parentId: 'agent_p', running: false, depth: 1 }],
  };

  it('normalizes a plan, filling what the engine left out, and rejects what is not one', () => {
    const normalized = normalizeRemovalPlan(plan)!;
    expect(normalized.archived.map((e) => [e.displayName, e.depth, e.running])).toEqual([['luna', 0, false], ['agent_c', 1, false], ['Sprocket', 2, null]]);
    expect(normalized.unchanged[0].status).toBe('retired');
    expect(normalized.capabilities).toEqual({ plan: true, team: true, independent: true, restore: false, delete: false });
    expect(normalizeRemovalPlan({ ...plan, capabilities: undefined, independent: [{ agentId: 'x' }, { name: 'no id' }, 3] })!.independent)
      .toEqual([{ agentId: 'x', name: null, displayName: 'x', status: null, harness: null, parentId: null, running: null, depth: 0 }]);
    expect(normalizeRemovalPlan({ ...plan, capabilities: undefined })!.capabilities.team).toBe(false);
    for (const bad of [null, {}, { ...plan, schemaVersion: 2 }, { ...plan, scope: 'fleet' }, { ...plan, archived: 'luna' }]) expect(normalizeRemovalPlan(bad)).toBeNull();
  });

  it('asks the shell for the plan with its scope, and reads null as an engine without --plan', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => { calls.push([cmd, args]); return plan; }) as never;
    await expect(removalPlan('agent_p', 'team', fake)).resolves.toMatchObject({ scope: 'team', agentId: 'agent_p' });
    expect(calls).toEqual([['soul_remove_plan', { agent: 'agent_p', scope: 'team' }]]);
    await expect(removalPlan('agent_p', 'soul', (async () => null) as never)).resolves.toBeNull();
    await expect(removalPlan('agent_p', 'soul', (async () => ({ agentId: 'agent_p' })) as never)).rejects.toMatchObject({ code: 'soul-remove-plan-failed' });
    const refused = (async () => { throw { code: 'soul-remove-failed', message: 'no population record for agent_p' }; }) as never;
    await expect(removalPlan('agent_p', 'soul', refused)).rejects.toMatchObject({ code: 'soul-remove-failed', message: 'no population record for agent_p' });
  });

  it('sends the scope only when given, and keeps the effects an engine reports', async () => {
    const calls: unknown[] = [];
    const result = {
      agentId: 'agent_p', name: 'luna', handle: 'luna', wake: 'off', comms: 'left', retired: true, archived: [], plan,
      effects: {
        scope: 'team',
        archived: [{ agentId: 'agent_s', name: 'Sprocket', comms: 'left', retired: true }, { agentId: 'agent_c', name: null, comms: 'not left: hub down', retired: true }, { agentId: 'agent_p', name: 'luna', comms: 'left', retired: true }],
        independent: [{ agentId: 'agent_i', name: 'ivy', displayName: 'Ivy', formerParentId: 'agent_p' }], notArchived: [],
      },
    };
    const fake = (async (cmd: string, args: unknown) => { calls.push([cmd, args]); return result; }) as never;
    const removed = await removeSoul('agent_p', 'team', fake);
    expect(calls).toEqual([['soul_remove', { agent: 'agent_p', scope: 'team' }]]);
    expect(removed.effects).toEqual({
      scope: 'team',
      archived: [{ agentId: 'agent_s', name: 'Sprocket', comms: 'left' }, { agentId: 'agent_c', name: null, comms: 'not left: hub down' }, { agentId: 'agent_p', name: 'luna', comms: 'left' }],
      independent: [{ agentId: 'agent_i', name: 'ivy', displayName: 'Ivy', formerParentId: 'agent_p' }], notArchived: [],
    });
    expect(normalizeRemovedSoul({ agentId: 'a', retired: true })).not.toHaveProperty('effects');
    expect(normalizeRemovalEffects({ scope: 'soul', notArchived: [{ agentId: 'agent_z' }] })).toEqual({ scope: 'soul', archived: [], independent: [], notArchived: [{ agentId: 'agent_z', name: null, displayName: 'agent_z' }] });
    expect(normalizeRemovalEffects({ archived: [] })).toBeNull();
  });
});

describe('daemon status (#122 computer-use badge)', () => {
  it('reads daemon status, keeping well-formed computer-use entries', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => {
      calls.push([cmd, args]);
      return { running: true, pid: 1, computerUse: [{ agentId: 'agent_1', since: '2026-10-05T00:00:00.000Z' }, { agentId: '' }, { agentId: 'agent_2' }] };
    }) as never;
    await expect(daemonStatus(fake)).resolves.toEqual({
      running: true,
      computerUse: [{ agentId: 'agent_1', since: '2026-10-05T00:00:00.000Z' }, { agentId: 'agent_2', since: null }],
    });
    expect(calls).toEqual([['daemon_status', undefined]]);
  });

  it('reads the souls mid-turn, when the daemon reports them', async () => {
    const fake = (async () => ({ running: true, computerUse: [], busy: ['agent_1', '', 7, 'agent_2'] })) as never;
    await expect(daemonStatus(fake)).resolves.toEqual({ running: true, computerUse: [], busy: ['agent_1', 'agent_2'] });
    expect(normalizeDaemonStatus({ running: true, busy: 'agent_1' })).toEqual({ running: true, computerUse: [] });
    expect(normalizeDaemonStatus({ running: true })).not.toHaveProperty('busy');
  });

  it('is null when agent-bot cannot say, or outside the app', async () => {
    await expect(daemonStatus((async () => null) as never)).resolves.toBeNull();
    await expect(daemonStatus((async () => { throw new Error('no'); }) as never)).resolves.toBeNull();
    await expect(daemonStatus()).resolves.toBeNull();
    expect(normalizeDaemonStatus({ running: false })).toEqual({ running: false, computerUse: [] });
  });
});

describe('services installed (#118)', () => {
  it('reads services_installed, and is null when the shell cannot say', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => { calls.push([cmd, args]); return { broker: true, daemon: false }; }) as never;
    await expect(servicesInstalled(fake)).resolves.toEqual({ broker: true, daemon: false });
    expect(calls).toEqual([['services_installed', undefined]]);
    await expect(servicesInstalled((async () => ({ broker: 'yes' })) as never)).resolves.toEqual({ broker: false, daemon: false });
    await expect(servicesInstalled((async () => null) as never)).resolves.toBeNull();
    await expect(servicesInstalled((async () => { throw new Error('no'); }) as never)).resolves.toBeNull();
    await expect(servicesInstalled()).resolves.toBeNull();
  });
});

describe('population list (#137 comms badges in one call)', () => {
  it('reads population_list, keeping each soul agent id, comms and managed', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => {
      calls.push([cmd, args]);
      return [
        { agentId: 'agent_1', status: 'active', managed: true, comms: true, paused: true },
        { agentId: 'agent_2', status: 'retired', managed: false, comms: false },
        { agentId: 'agent_3', status: 'active', comms: true },
      ];
    }) as never;
    await expect(populationList(fake)).resolves.toEqual([
      { agentId: 'agent_1', comms: true, managed: true, paused: true, status: 'active' },
      { agentId: 'agent_2', comms: false, managed: false, paused: false, status: 'retired' },
      { agentId: 'agent_3', comms: true, managed: false, paused: false, status: 'active' },
    ]);
    expect(calls).toEqual([['population_list', undefined]]);
  });

  it('drops malformed rows and is null when the shell cannot say', async () => {
    expect(normalizePopulationList([
      { agentId: '', comms: true }, { agentId: 'agent_1' }, { comms: true }, null, 'agent_2',
      { agentId: 'agent_3', comms: 'yes', managed: true }, { agentId: 'agent_4', comms: false, managed: 'yes' },
    ])).toEqual([{ agentId: 'agent_4', comms: false, managed: false, paused: false, status: null }]);
    expect(normalizePopulationList([{ agentId: 'agent_5', comms: true, computerUse: false }, { agentId: 'agent_6', comms: true, computerUse: 'no' }]))
      .toEqual([{ agentId: 'agent_5', comms: true, managed: false, paused: false, computerUse: false, status: null },
        { agentId: 'agent_6', comms: true, managed: false, paused: false, status: null }]);
    expect(normalizePopulationList([])).toEqual([]);
    expect(normalizePopulationList({ souls: [] })).toBeNull();
    await expect(populationList((async () => null) as never)).resolves.toBeNull();
    await expect(populationList((async () => { throw new Error('unknown command population_list'); }) as never)).resolves.toBeNull();
    await expect(populationList()).resolves.toBeNull();
  });
});

describe('soul stop (#122, agent-bot-identity #474)', () => {
  it('stops the soul through agent-bot and reports whether a turn was running', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => { calls.push([cmd, args]); return { agentId: 'agent_1', stopped: true }; }) as never;
    await expect(stopSoul('agent_1', fake)).resolves.toEqual({ agentId: 'agent_1', stopped: true });
    expect(calls).toEqual([['soul_stop', { agent: 'agent_1' }]]);
    const idle = (async () => ({ agentId: 'agent_1', stopped: false, reason: 'idle' })) as never;
    await expect(stopSoul('agent_1', idle)).resolves.toEqual({ agentId: 'agent_1', stopped: false, reason: 'idle' });
  });

  it('rejects with the shell error code, telling an older bundle apart', async () => {
    const down = (async () => { throw { code: 'daemon-unavailable', message: 'the daemon is not running' }; }) as never;
    await expect(stopSoul('agent_1', down)).rejects.toMatchObject({ code: 'daemon-unavailable', message: 'the daemon is not running' });
    const older = (async () => { throw { code: 'soul-stop-unsupported', message: 'this agent-bot has no soul stop' }; }) as never;
    await expect(stopSoul('agent_1', older)).rejects.toMatchObject({ code: 'soul-stop-unsupported' });
    await expect(stopSoul('agent_1', (async () => ({ agentId: 'agent_1' })) as never)).rejects.toMatchObject({ code: 'soul-stop-failed' });
  });

  it('normalizes only a well-formed result', () => {
    expect(normalizeSoulStop({ agentId: 'a', stopped: false, reason: 'idle', extra: 1 })).toEqual({ agentId: 'a', stopped: false, reason: 'idle' });
    expect(normalizeSoulStop({ agentId: 'a', stopped: 'yes' })).toBeNull();
    expect(normalizeSoulStop(null)).toBeNull();
  });

  it('probes once whether the bundle has the command; false when it cannot say', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => { calls.push([cmd, args]); return { supported: true }; }) as never;
    await expect(soulStopSupported(fake)).resolves.toBe(true);
    expect(calls).toEqual([['soul_stop_probe', undefined]]);
    await expect(soulStopSupported((async () => ({ supported: false })) as never)).resolves.toBe(false);
    await expect(soulStopSupported((async () => { throw { code: 'soul-stop-unavailable', message: 'x' }; }) as never)).resolves.toBe(false);
    await expect(soulStopSupported()).resolves.toBe(false);
  });
});

describe('soul pause / resume (#122, agent-bot-identity #478)', () => {
  it('pauses and resumes the soul through agent-bot', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => {
      calls.push([cmd, args]);
      return cmd === 'soul_pause' ? { agentId: 'agent_1', paused: true, stopped: true } : { agentId: 'agent_1', paused: false };
    }) as never;
    await expect(pauseSoul('agent_1', fake)).resolves.toEqual({ agentId: 'agent_1', paused: true, stopped: true });
    await expect(resumeSoul('agent_1', fake)).resolves.toEqual({ agentId: 'agent_1', paused: false });
    expect(calls).toEqual([['soul_pause', { agent: 'agent_1' }], ['soul_resume', { agent: 'agent_1' }]]);
  });

  it('rejects with the shell error code, telling an older bundle apart', async () => {
    const down = (async () => { throw { code: 'daemon-unavailable', message: 'the daemon is not running' }; }) as never;
    await expect(pauseSoul('agent_1', down)).rejects.toMatchObject({ code: 'daemon-unavailable', message: 'the daemon is not running' });
    const older = (async () => { throw { code: 'soul-pause-unsupported', message: 'this agent-bot has no soul pause' }; }) as never;
    await expect(resumeSoul('agent_1', older)).rejects.toMatchObject({ code: 'soul-pause-unsupported' });
    await expect(pauseSoul('agent_1', (async () => ({ agentId: 'agent_1' })) as never)).rejects.toMatchObject({ code: 'soul-pause-failed' });
    await expect(resumeSoul('agent_1', (async () => { throw 'boom'; }) as never)).rejects.toMatchObject({ code: 'soul-resume-failed', message: 'boom' });
  });

  it('normalizes only a well-formed result', () => {
    expect(normalizeSoulPause({ agentId: 'a', paused: true, stopped: false, extra: 1 })).toEqual({ agentId: 'a', paused: true, stopped: false });
    expect(normalizeSoulPause({ agentId: 'a', paused: 'yes' })).toBeNull();
    expect(normalizeSoulPause(null)).toBeNull();
  });

  it('probes whether the bundle has the command; false when it cannot say', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => { calls.push([cmd, args]); return { supported: true }; }) as never;
    await expect(soulPauseSupported(fake)).resolves.toBe(true);
    expect(calls).toEqual([['soul_pause_probe', undefined]]);
    await expect(soulPauseSupported((async () => ({ supported: false })) as never)).resolves.toBe(false);
    await expect(soulPauseSupported((async () => { throw { code: 'soul-pause-unavailable', message: 'x' }; }) as never)).resolves.toBe(false);
    await expect(soulPauseSupported()).resolves.toBe(false);
  });
});

describe('soul computer-use (#122, agent-bot-identity #482)', () => {
  it('reads and switches the soul through agent-bot', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: { action: string }) => {
      calls.push([cmd, args]);
      return args.action === 'off' ? { agentId: 'agent_1', computerUse: false, stopped: true } : { agentId: 'agent_1', computerUse: true };
    }) as never;
    await expect(soulComputerUse('agent_1', 'show', fake)).resolves.toEqual({ agentId: 'agent_1', computerUse: true });
    await expect(soulComputerUse('agent_1', 'off', fake)).resolves.toEqual({ agentId: 'agent_1', computerUse: false, stopped: true });
    await expect(soulComputerUse('agent_1', 'on', fake)).resolves.toEqual({ agentId: 'agent_1', computerUse: true });
    expect(calls).toEqual([
      ['soul_computer_use', { agent: 'agent_1', action: 'show' }],
      ['soul_computer_use', { agent: 'agent_1', action: 'off' }],
      ['soul_computer_use', { agent: 'agent_1', action: 'on' }],
    ]);
  });

  it('rejects with the shell error code, telling an older bundle apart', async () => {
    const refused = (async () => { throw { code: 'soul-computer-use-failed', message: 'the owner did not approve' }; }) as never;
    await expect(soulComputerUse('agent_1', 'off', refused)).rejects.toMatchObject({ code: 'soul-computer-use-failed', message: 'the owner did not approve' });
    const older = (async () => { throw { code: 'soul-computer-use-unsupported', message: 'this agent-bot has no soul computer-use' }; }) as never;
    await expect(soulComputerUse('agent_1', 'on', older)).rejects.toMatchObject({ code: 'soul-computer-use-unsupported' });
    await expect(soulComputerUse('agent_1', 'show', (async () => ({ agentId: 'agent_1' })) as never)).rejects.toMatchObject({ code: 'soul-computer-use-failed' });
    await expect(soulComputerUse('agent_1', 'on', (async () => { throw 'boom'; }) as never)).rejects.toMatchObject({ code: 'soul-computer-use-failed', message: 'boom' });
  });

  it('normalizes only a well-formed result', () => {
    expect(normalizeSoulComputerUse({ agentId: 'a', computerUse: false, stopped: true, extra: 1 })).toEqual({ agentId: 'a', computerUse: false, stopped: true });
    expect(normalizeSoulComputerUse({ agentId: 'a', computerUse: true, stopped: false })).toEqual({ agentId: 'a', computerUse: true });
    expect(normalizeSoulComputerUse({ agentId: 'a', computerUse: 'on' })).toBeNull();
    expect(normalizeSoulComputerUse(null)).toBeNull();
  });

  it('probes whether the bundle has the command; false when it cannot say', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => { calls.push([cmd, args]); return { supported: true }; }) as never;
    await expect(soulComputerUseSupported(fake)).resolves.toBe(true);
    expect(calls).toEqual([['soul_computer_use_probe', undefined]]);
    await expect(soulComputerUseSupported((async () => ({ supported: false })) as never)).resolves.toBe(false);
    await expect(soulComputerUseSupported((async () => { throw { code: 'soul-computer-use-unavailable', message: 'x' }; }) as never)).resolves.toBe(false);
    await expect(soulComputerUseSupported()).resolves.toBe(false);
  });

  it('offers nothing outside the app', async () => {
    await expect(liveComputerUse.supported()).resolves.toBe(false);
    await expect(liveComputerUse.read('agent_1')).resolves.toBeNull();
  });
});

describe('soul templates (#65)', () => {
  const row = { name: 'Coder', description: 'Writes code.', preferredHarnesses: ['claude', 7], defaultHarness: 'claude',
    package: '/souls/Coder.soul', revision: 'r1', source: 'config' };

  it('normalizes agent-bot\'s listing, dropping malformed rows', () => {
    expect(normalizeSoulTemplates({
      templates: [row, { ...row }, { ...row, package: 'relative.soul' }, { ...row, name: ' ', package: '/souls/x.soul' },
        { name: 'Bare', package: '/souls/Bare.soul', defaultHarness: '', source: 'elsewhere' }, null],
      soulsRoot: '/souls',
      errors: [{ package: '/souls/Bad.soul', message: 'soul.json is missing' }, { message: 'teams.template must be absolute' }, 'x'],
    })).toEqual({
      templates: [
        { name: 'Coder', description: 'Writes code.', preferredHarnesses: ['claude'], defaultHarness: 'claude', package: '/souls/Coder.soul', revision: 'r1', source: 'config' },
        { name: 'Bare', description: '', preferredHarnesses: [], defaultHarness: null, package: '/souls/Bare.soul', revision: null, source: 'souls-root' },
      ],
      soulsRoot: '/souls',
      errors: [{ package: '/souls/Bad.soul', message: 'soul.json is missing' }, { package: null, message: 'teams.template must be absolute' }],
    });
    expect(normalizeSoulTemplates({ soulsRoot: '/souls' })).toBeNull();
    expect(normalizeSoulTemplates(null)).toBeNull();
  });

  it('lists through the shell, keeping its error code', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => { calls.push([cmd, args]); return { templates: [row], soulsRoot: '/souls', errors: [] }; }) as never;
    await expect(listSoulTemplates(fake)).resolves.toMatchObject({ templates: [{ name: 'Coder' }] });
    expect(calls).toEqual([['list_soul_templates', undefined]]);
    const old = (async () => { throw { code: 'soul-templates-unsupported', message: 'this agent-bot has no soul templates' }; }) as never;
    await expect(listSoulTemplates(old)).rejects.toMatchObject({ code: 'soul-templates-unsupported' });
    await expect(listSoulTemplates((async () => ({ nope: true })) as never)).rejects.toMatchObject({ code: 'soul-templates-failed' });
  });

  it('is unsupported outside the app', async () => {
    await expect(listSoulTemplates()).rejects.toMatchObject({ code: 'soul-templates-unsupported' });
  });
});

describe('soul profile (#64)', () => {
  const raw = {
    agentId: 'agent_p',
    profile: { name: 'luna', displayName: 'Luna', description: 'Leads.', harness: 'claude', package: '/s/Luna.soul', revision: 'r1', template: false, parentId: null, status: 'active' },
    files: [{ path: 'soul.md', kind: 'soul', size: 12, modifiedAt: '2026-10-01T00:00:00.000Z', text: true }, { path: '', kind: 'soul' }, { path: 'x.bin', kind: 'odd', text: 'yes' }],
    skills: [{ name: 'review', source: 'sop', path: 'sop/skills/review/SKILL.md', commit: 'abc123', enabled: true }, { name: 'notes', source: 'soul', path: 'skills/notes/SKILL.md', commit: null, enabled: true }, { source: 'sop' }],
    credentials: [{ name: 'luna-app', provider: 'github', status: 'declared', value: 'ghs_secret', path: '/keys/luna.pem' }],
    sop: { resolved: { source: 'qwts/sop', commit: 'abc123' }, override: { path: 'agent-sop.toml', workflows: ['workflows/ship.toml', 4] } },
    errors: [{ area: 'sop', message: 'pins need the network' }, { area: 'x' }],
  };

  it('normalizes agent-bot\'s profile, keeping only credential names and status', () => {
    const profile = normalizeSoulProfile(raw);
    expect(profile).toEqual({
      agentId: 'agent_p',
      profile: { name: 'luna', displayName: 'Luna', description: 'Leads.', harness: 'claude', package: '/s/Luna.soul', revision: 'r1', template: false, parentId: null, status: 'active', appearance: null, skillsDisabled: [] },
      files: [
        { path: 'soul.md', kind: 'soul', size: 12, modifiedAt: '2026-10-01T00:00:00.000Z', text: true },
        { path: 'x.bin', kind: 'context', size: null, modifiedAt: null, text: false },
      ],
      skills: [
        { name: 'review', source: 'sop', path: 'sop/skills/review/SKILL.md', commit: 'abc123', enabled: true },
        { name: 'notes', source: 'soul', path: 'skills/notes/SKILL.md', commit: null, enabled: true },
      ],
      credentials: [{ name: 'luna-app', provider: 'github', status: 'declared' }],
      sop: { resolved: { source: 'qwts/sop', commit: 'abc123' }, override: { path: 'agent-sop.toml', workflows: ['workflows/ship.toml'] } },
      errors: [{ area: 'sop', message: 'pins need the network' }],
    });
    expect(JSON.stringify(profile)).not.toContain('ghs_secret');
    expect(normalizeSoulProfile({ agentId: 'a', profile: {} })).toMatchObject({ files: [], skills: [], credentials: [], sop: { resolved: null, override: null }, errors: [] });
    expect(normalizeSoulProfile({ agentId: 'a' })).toBeNull();
    expect(normalizeSoulProfile(null)).toBeNull();
  });

  it('reads through the shell, keeping its error code', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => {
      calls.push([cmd, args]);
      return cmd === 'soul_profile' ? raw : { agentId: 'agent_p', path: 'soul.md', size: 7, contents: '# Luna\n' };
    }) as never;
    await expect(soulProfile('agent_p', fake)).resolves.toMatchObject({ profile: { displayName: 'Luna' } });
    await expect(soulProfileFile('agent_p', 'soul.md', fake)).resolves.toEqual({ agentId: 'agent_p', path: 'soul.md', size: 7, contents: '# Luna\n' });
    expect(calls).toEqual([['soul_profile', { agent: 'agent_p' }], ['soul_profile_file', { agent: 'agent_p', path: 'soul.md' }]]);
    const old = (async () => { throw { code: 'soul-profile-unsupported', message: 'this agent-bot has no soul profile' }; }) as never;
    await expect(soulProfile('agent_p', old)).rejects.toMatchObject({ code: 'soul-profile-unsupported' });
    const big = (async () => { throw { code: 'soul-profile-file-too-large', message: 'too large' }; }) as never;
    await expect(soulProfileFile('agent_p', 'big.md', big)).rejects.toMatchObject({ code: 'soul-profile-file-too-large' });
    await expect(soulProfile('agent_p', (async () => ({ nope: true })) as never)).rejects.toMatchObject({ code: 'soul-profile-failed' });
    await expect(soulProfileFile('agent_p', 'soul.md', (async () => ({ path: 'soul.md' })) as never)).rejects.toMatchObject({ code: 'soul-profile-failed' });
  });

  it('is unsupported outside the app', async () => {
    await expect(soulProfile('agent_p')).rejects.toMatchObject({ code: 'soul-profile-unsupported' });
    await expect(soulProfileFile('agent_p', 'soul.md')).rejects.toMatchObject({ code: 'soul-profile-unsupported' });
  });
});

describe('popupVisible (#122)', () => {
  it('asks the popup window whether it shows, and says no when it cannot', async () => {
    const asked: string[] = [];
    const showing = async (label: string) => { asked.push(label); return { isVisible: async () => true }; };
    await expect(popupVisible(showing)).resolves.toBe(true);
    expect(asked).toEqual(['main']);
    await expect(popupVisible(async () => ({ isVisible: async () => false }))).resolves.toBe(false);
    await expect(popupVisible(async () => null)).resolves.toBe(false);
    await expect(popupVisible(async () => { throw new Error('no window'); })).resolves.toBe(false);
    // Outside the app there is no popup.
    await expect(popupVisible()).resolves.toBe(false);
  });
});

describe('soul appearance (#64)', () => {
  it('keeps a whole hue in 0..359 and drops anything else', () => {
    expect(normalizeAppearance({ hue: 210 })).toEqual({ hue: 210 });
    expect(normalizeAppearance({ hue: 0 })).toEqual({ hue: 0 });
    expect(normalizeAppearance({ hue: 359 })).toEqual({ hue: 359 });
    for (const bad of [{ hue: -1 }, { hue: 360 }, { hue: 'x' }, { hue: 12.5 }, { hue: Number.NaN }, {}, null, 'x', 210]) {
      expect(normalizeAppearance(bad)).toBeUndefined();
    }
  });

  it('carries the hue on population rows and records, and leaves malformed ones out', () => {
    const rows = normalizePopulationList([
      { agentId: 'agent_1', comms: true, appearance: { hue: 210 } },
      { agentId: 'agent_2', comms: true, appearance: { hue: -1 } },
      { agentId: 'agent_3', comms: true, appearance: { hue: 360 } },
      { agentId: 'agent_4', comms: true, appearance: { hue: 'x' } },
      { agentId: 'agent_5', comms: true, appearance: {} },
      { agentId: 'agent_6', comms: true },
    ])!;
    expect(rows[0]).toEqual({ agentId: 'agent_1', comms: true, managed: false, paused: false, status: null, appearance: { hue: 210 } });
    for (const row of rows.slice(1)) expect(row).not.toHaveProperty('appearance');
    expect(normalizeSoulPopulation({ agentId: 'a', appearance: { hue: 210 } })?.appearance).toEqual({ hue: 210 });
    for (const appearance of [{ hue: -1 }, { hue: 360 }, { hue: 'x' }, {}]) {
      expect(normalizeSoulPopulation({ agentId: 'a', appearance })).not.toHaveProperty('appearance');
    }
  });

  it('reads the profile\'s appearance, null when absent or malformed', () => {
    const raw = (appearance: unknown) => ({ agentId: 'agent_p', profile: { name: 'luna', appearance } });
    expect(normalizeSoulProfile(raw({ hue: 210 }))?.profile.appearance).toEqual({ hue: 210 });
    expect(normalizeSoulProfile(raw(null))?.profile.appearance).toBeNull();
    expect(normalizeSoulProfile(raw(undefined))?.profile.appearance).toBeNull();
    for (const bad of [{ hue: -1 }, { hue: 360 }, { hue: 'x' }, {}]) {
      expect(normalizeSoulProfile(raw(bad))?.profile.appearance).toBeNull();
    }
  });
});

describe('role and roleLine (agent-bot-identity #535)', () => {
  it('carries a declared role and role line from population_list, and leaves them out when absent', () => {
    expect(normalizePopulationList([
      { agentId: 'agent_a', comms: true, role: 'Release captain', roleLine: 'Release captain' },
      { agentId: 'agent_b', comms: false, role: null, roleLine: 'Lead, 2 subagents' },
      { agentId: 'agent_c', comms: false, role: '  ' },
    ])).toEqual([
      { agentId: 'agent_a', comms: true, managed: false, paused: false, status: null, role: 'Release captain', roleLine: 'Release captain' },
      { agentId: 'agent_b', comms: false, managed: false, paused: false, status: null, roleLine: 'Lead, 2 subagents' },
      { agentId: 'agent_c', comms: false, managed: false, paused: false, status: null },
    ]);
  });

  it('carries the role from population show', () => {
    expect(normalizeSoulPopulation({ agentId: 'a', role: 'Reviewer', roleLine: 'Reviewer' })).toMatchObject({ role: 'Reviewer', roleLine: 'Reviewer' });
    expect(normalizeSoulPopulation({ agentId: 'a', role: null })).not.toHaveProperty('role');
  });
});

describe('soul environment (#268)', () => {
  /** agent-bot 0.10.46's `soul env --json`, cut to what the shape checks need. */
  const raw = {
    schemaVersion: 1,
    engine: { version: '0.10.46', contractVersion: 1, capabilities: ['env', 'revision-prepare'] },
    identity: { agentId: 'agent_p', name: 'example', harness: null },
    root: { soulDir: '/Users/me/souls/example.soul', soulsRoot: '/Users/me/souls', source: 'environment', registered: true, marker: 'ok', copies: [], device: 16777229 },
    components: [
      { id: 'manifest', path: 'soul.json', classification: 'definition', present: true, retention: 'durable' },
      { id: 'generated', path: null, classification: 'generated', present: true, retention: 'reconstructible', paths: ['CLAUDE.md'], marker: '<!-- agent-bot soul-builder: generated -->', drift: [] },
      { id: 'host-tools', path: null, classification: 'external', present: true, retention: null, entries: [{ name: 'git', path: '/usr/bin/git', source: 'host' }] },
      { path: 'x' },
    ],
    classification: { enum: ['definition', 'generated'], rules: [{ match: 'default', classification: 'definition' }] },
    harnesses: { selected: 'claude', declared: [], installed: [{ harness: 'claude', version: '1.0.0', status: 'ok' }], launchable: true },
    runtimes: { declared: { node: { version: '24.11.1' } }, installed: [], missing: [{ name: 'node', version: '24.11.1', reason: 'not provisioned' }], unsupported: [] },
    providers: {},
    launch: { supported: true, lane: 'acp', cwd: '/Users/me/souls/example.soul/.soul-state/home', routing: { HOME: 'host', PATH: 'host', TMPDIR: 'host', odd: 1 }, limitations: [{ harness: 'claude', message: 'shared on the host' }, {}] },
    readiness: { ready: false, problems: [{ code: 'generated-drift', severity: 'warning', component: 'generated', message: 'rebuild', action: 'agent-bot soul build "/Users/me/souls/example.soul"' }, { code: 'marker-invalid', severity: 'error', component: null, message: 'bad marker', action: null }, { message: 'no code' }] },
    migration: { status: 'pending', journal: '.soul-state/migration.json', steps: [{ id: 'space-into-soul', status: 'pending', from: '/Users/me/space', to: '/Users/me/souls/example.soul/.soul-state/space' }] },
    retention: { durable: ['manifest'], reconstructible: ['generated'], disposable: ['temp'] },
    errors: [{ area: 'home', message: 'EACCES' }, { area: 'x' }],
  };

  it('keeps the descriptor as the engine printed it, with its shape checked', () => {
    const env = normalizeSoulEnvironment(raw);
    expect(env).toMatchObject({
      schemaVersion: 1,
      engine: { version: '0.10.46', contractVersion: 1, capabilities: ['env', 'revision-prepare'] },
      root: { soulDir: '/Users/me/souls/example.soul', registered: true, marker: 'ok', copies: [], device: 16777229 },
      harnesses: { selected: 'claude', launchable: true, installed: [{ harness: 'claude', version: '1.0.0', status: 'ok' }] },
      runtimes: { declared: { node: { version: '24.11.1' } }, missing: [{ name: 'node', reason: 'not provisioned' }] },
      launch: { supported: true, lane: 'acp', routing: { HOME: 'host', PATH: 'host', TMPDIR: 'host' }, limitations: [{ harness: 'claude', message: 'shared on the host' }] },
      readiness: { ready: false, problems: [
        { code: 'generated-drift', severity: 'warning', component: 'generated', message: 'rebuild', action: 'agent-bot soul build "/Users/me/souls/example.soul"' },
        { code: 'marker-invalid', severity: 'error', component: null, message: 'bad marker', action: null },
      ] },
      migration: { status: 'pending', steps: [{ id: 'space-into-soul', status: 'pending', from: '/Users/me/space' }] },
      retention: { durable: ['manifest'], reconstructible: ['generated'], disposable: ['temp'] },
      errors: [{ area: 'home', message: 'EACCES' }],
    });
    // A component keeps what it knows beyond the common row.
    expect(env?.components.map((c) => c.id)).toEqual(['manifest', 'generated', 'host-tools']);
    expect(env?.components[1]).toMatchObject({ path: null, retention: 'reconstructible', paths: ['CLAUDE.md'], drift: [] });
    expect(env?.components[2]).toMatchObject({ retention: null, entries: [{ name: 'git' }] });
    expect(normalizeSoulEnvironment({ schemaVersion: 1, engine: {}, components: [] })).toMatchObject({ engine: { version: null, capabilities: [] }, root: { marker: null, registered: false }, readiness: { ready: false, problems: [] }, errors: [] });
    expect(normalizeSoulEnvironment({ schemaVersion: 2, engine: {}, components: [] })).toBeNull();
    expect(normalizeSoulEnvironment({ schemaVersion: 1, components: [] })).toBeNull();
    expect(normalizeSoulEnvironment(null)).toBeNull();
  });

  it('gates on the engine\'s capabilities, never a version', () => {
    const env = normalizeSoulEnvironment(raw);
    expect(engineCan(env, 'revision-prepare')).toBe(true);
    expect(engineCan(env, 'provision')).toBe(false);
    expect(engineCan(normalizeSoulEnvironment({ ...raw, engine: { version: '9.9.9', capabilities: ['env'] } }), 'revision-prepare')).toBe(false);
    expect(engineCan(null, 'env')).toBe(false);
  });

  it('reads through the shell, keeping its error code, and is unsupported outside the app', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => { calls.push([cmd, args]); return raw; }) as never;
    await expect(soulEnvironment('agent_p', fake)).resolves.toMatchObject({ engine: { capabilities: ['env', 'revision-prepare'] } });
    expect(calls).toEqual([['soul_env', { agent: 'agent_p' }]]);
    const old = (async () => { throw { code: 'soul-env-unsupported', message: 'this agent-bot has no soul environment' }; }) as never;
    await expect(soulEnvironment('agent_p', old)).rejects.toMatchObject({ code: 'soul-env-unsupported' });
    await expect(soulEnvironment('agent_p', (async () => ({ nope: true })) as never)).rejects.toMatchObject({ code: 'soul-env-failed' });
    await expect(soulEnvironment('agent_p', (async () => { throw new Error('boom'); }) as never)).rejects.toMatchObject({ code: 'soul-env-failed', message: 'boom' });
    await expect(soulEnvironment('agent_p')).rejects.toMatchObject({ code: 'soul-env-unsupported' });
  });
});

describe('revision staging (#268)', () => {
  /** agent-bot 0.10.46's `soul revision prepare --json` (temp path shortened). */
  const raw = {
    schemaVersion: 1, agentId: 'agent_p', soulDir: '/Users/me/souls/example.soul',
    staging: '/Users/me/souls/example.soul/.soul-state/tmp/revision-44430c4f-05a7-417b-9c3f-36bb4bc2a2eb',
    revision: 'sha256:4d39', parentRevision: null,
    files: [
      { path: '.mcp.json', classification: 'generated', kind: null, editable: false, text: true, size: 235, mode: '100644' },
      { path: 'AGENTS.md', classification: 'definition', kind: 'context', editable: true, text: true, size: 22, mode: '100644' },
      { path: 'bin/run', classification: 'definition', kind: null, editable: false, text: true, size: 19, mode: '100755' },
      { path: 'skills/hello/diagram.png', classification: 'definition', kind: 'skill', editable: true, text: false, size: 4, mode: '100644' },
      { path: 'soul.json', classification: 'definition', kind: 'soul', editable: false, text: true, size: 647, mode: '100644' },
      { path: '' },
    ],
    excluded: { workingState: ['worktrees', '.soul-state'], generated: ['CLAUDE.md', 3] },
    expiresAt: '2026-10-08T23:48:48.629Z',
  };

  it('keeps the engine\'s rows, and lets the dialog edit only editable text', () => {
    const prepared = normalizePreparedRevision(raw);
    expect(prepared).toEqual({
      agentId: 'agent_p', soulDir: '/Users/me/souls/example.soul', staging: raw.staging, revision: 'sha256:4d39', parentRevision: null,
      files: [
        { path: '.mcp.json', classification: 'generated', kind: null, editable: false, text: true, size: 235, mode: '100644' },
        { path: 'AGENTS.md', classification: 'definition', kind: 'context', editable: true, text: true, size: 22, mode: '100644' },
        { path: 'bin/run', classification: 'definition', kind: null, editable: false, text: true, size: 19, mode: '100755' },
        { path: 'skills/hello/diagram.png', classification: 'definition', kind: 'skill', editable: true, text: false, size: 4, mode: '100644' },
        { path: 'soul.json', classification: 'definition', kind: 'soul', editable: false, text: true, size: 647, mode: '100644' },
      ],
      excluded: { workingState: ['worktrees', '.soul-state'], generated: ['CLAUDE.md'] },
      expiresAt: '2026-10-08T23:48:48.629Z',
    });
    expect(editableInStaging(prepared, 'AGENTS.md')).toBe(true);
    expect(editableInStaging(prepared, 'bin/run')).toBe(false);
    expect(editableInStaging(prepared, '.mcp.json')).toBe(false);
    expect(editableInStaging(prepared, 'soul.json')).toBe(false);
    expect(editableInStaging(prepared, 'skills/hello/diagram.png')).toBe(false);
    expect(editableInStaging(prepared, 'CLAUDE.md')).toBe(false);
    expect(editableInStaging(null, 'AGENTS.md')).toBe(false);
    // The app's fallback answers the same shape with no staging.
    expect(normalizePreparedRevision({ ...raw, staging: null, expiresAt: null })).toMatchObject({ staging: null, expiresAt: null });
    expect(normalizePreparedRevision({ agentId: 'agent_p' })).toBeNull();
    expect(normalizePreparedRevision(null)).toBeNull();
  });

  it('prepares and discards through the shell, keeping the error code', async () => {
    const calls: unknown[] = [];
    const fake = (async (cmd: string, args: unknown) => { calls.push([cmd, args]); return cmd === 'soul_revision_prepare' ? raw : { discarded: raw.staging }; }) as never;
    await expect(prepareRevision('agent_p', fake)).resolves.toMatchObject({ staging: raw.staging });
    await expect(discardRevision(raw.staging, fake)).resolves.toBeUndefined();
    expect(calls).toEqual([['soul_revision_prepare', { agent: 'agent_p' }], ['soul_revision_discard', { staging: raw.staging }]]);
    const refused = (async () => { throw { code: 'soul-state-missing', message: 'launch it once' }; }) as never;
    await expect(prepareRevision('agent_p', refused)).rejects.toMatchObject({ code: 'soul-state-missing', message: 'launch it once' });
    await expect(prepareRevision('agent_p', (async () => ({ nope: true })) as never)).rejects.toMatchObject({ code: 'soul-revision-failed' });
    const gone = (async () => { throw { code: 'staging-missing', message: 'no staging directory' }; }) as never;
    await expect(discardRevision(raw.staging, gone)).rejects.toMatchObject({ code: 'staging-missing' });
    await expect(prepareRevision('agent_p')).rejects.toMatchObject({ code: 'soul-revision-unavailable' });
    await expect(discardRevision(raw.staging)).rejects.toMatchObject({ code: 'soul-revision-unavailable' });
  });
});

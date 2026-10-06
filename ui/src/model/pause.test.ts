import { describe, expect, it } from 'vitest';
import { actOnAll, applyPaused, fleetPaused, pauseAction, pauseTargets, resumeTargets, type PauseEntry } from './pause';

const soul = (agentId: string, over: Partial<PauseEntry> = {}): PauseEntry =>
  ({ agentId, managed: true, paused: false, status: 'active', ...over });

describe('pause all / resume (#122)', () => {
  const fleet = [
    soul('agent_a'),
    soul('agent_b', { paused: true }),
    soul('agent_u', { managed: false }),
    soul('agent_r', { status: 'retired', paused: true }),
    soul('agent_o', { paused: undefined, status: undefined }),
  ];

  it('is paused while any managed, unarchived soul is', () => {
    expect(fleetPaused(fleet)).toBe(true);
    expect(fleetPaused([soul('agent_a'), soul('agent_u', { managed: false, paused: true })])).toBe(false);
    expect(fleetPaused([soul('agent_r', { status: 'retired', paused: true })])).toBe(false);
    expect(fleetPaused([])).toBe(false);
  });

  it('pauses every managed, unarchived soul and resumes only paused ones', () => {
    expect(pauseTargets(fleet)).toEqual(['agent_a', 'agent_b', 'agent_o']);
    expect(resumeTargets(fleet)).toEqual(['agent_b']);
    expect(resumeTargets([...fleet, soul('agent_x', { managed: false, paused: true })])).toEqual(['agent_b', 'agent_x']);
  });

  it('toggles: resume while paused, pause all otherwise', () => {
    expect(pauseAction(fleet)).toEqual({ action: 'resume', agentIds: ['agent_b'] });
    expect(pauseAction([soul('agent_a'), soul('agent_c')])).toEqual({ action: 'pause', agentIds: ['agent_a', 'agent_c'] });
  });

  it('applies what agent-bot answered', () => {
    const next = applyPaused(fleet, [{ agentId: 'agent_a', paused: true }, { agentId: 'agent_b', paused: false }]);
    expect(next.map((e) => e.paused)).toEqual([true, false, false, true, undefined]);
  });

  it('acts on every soul in parallel and reports the first failure in order', async () => {
    const started: string[] = [];
    const result = await actOnAll(['agent_a', 'agent_b', 'agent_c'], async (agentId) => {
      started.push(agentId);
      if (agentId === 'agent_b') throw { code: 'daemon-unavailable', message: 'the daemon is not running' };
      if (agentId === 'agent_c') throw new Error('later');
      return { agentId, paused: true };
    });
    expect(started).toEqual(['agent_a', 'agent_b', 'agent_c']);
    expect(result).toEqual({ answers: [{ agentId: 'agent_a', paused: true }], failure: { code: 'daemon-unavailable', message: 'the daemon is not running' } });
    expect(await actOnAll(['agent_a'], async (agentId) => ({ agentId, paused: false })))
      .toEqual({ answers: [{ agentId: 'agent_a', paused: false }], failure: null });
    expect((await actOnAll(['agent_a'], async () => { throw 'boom'; })).failure).toEqual({ code: 'soul-pause-failed', message: 'boom' });
  });
});

import { describe, expect, it } from 'vitest';
import { buildSoulForest, type CensusRow } from './census';
import { computerUserName, floatingLead, floatingState, menuStep } from './floating';

const row = (agentId: string, name: string | null, parent: string | null = null, presence: CensusRow['presence'] = 'joined'): CensusRow =>
  ({ account: 'user', agentId, name, harness: 'claude', parent, presence, unacked: 0, lastWake: null });

const roster = [row('agent_p', 'luna'), row('agent_c', 'coder', 'agent_p'), row('agent_n', 'nova')];
const forest = buildSoulForest(roster);

describe('floatingLead', () => {
  it('is the first team lead the desktop shows', () => {
    expect(floatingLead(forest)?.agentId).toBe('agent_p');
    expect(floatingLead(forest, ['user/agent_p'])?.agentId).toBe('agent_n');
  });

  it('skips a lead that has left, and falls back to any soul', () => {
    const gone = buildSoulForest([row('agent_p', 'luna', null, 'left'), row('agent_c', 'coder', 'agent_p')]);
    expect(floatingLead(gone)?.agentId).toBe('agent_c');
    expect(floatingLead(buildSoulForest([row('agent_x', 'x', null, 'left')]))?.agentId).toBe('agent_x');
    expect(floatingLead([])).toBeNull();
  });
});

describe('floatingState', () => {
  it('is idle with nothing pending', () => {
    expect(floatingState({ roster, approvals: 0 })).toBe('idle');
  });

  it('is working while a soul is mid-turn or drives the screen', () => {
    expect(floatingState({ roster, approvals: 0, busy: new Set(['agent_c']) })).toBe('working');
    expect(floatingState({ roster, approvals: 0, computerUse: new Set(['agent_n']) })).toBe('working');
    const busyPresence = [{ ...roster[0], presence: 'busy' as unknown as CensusRow['presence'] }];
    expect(floatingState({ roster: busyPresence, approvals: 0 })).toBe('working');
  });

  it('ignores busy reports for souls not in the roster', () => {
    expect(floatingState({ roster, approvals: 0, busy: new Set(['agent_other']) })).toBe('idle');
  });

  it('is awaiting while any approval waits, over working', () => {
    expect(floatingState({ roster, approvals: 2, busy: new Set(['agent_c']) })).toBe('awaiting');
  });
});

describe('computerUserName', () => {
  it('names the soul driving the screen, or its agent ID, or nobody', () => {
    expect(computerUserName(roster, new Set(['agent_c']))).toBe('coder');
    expect(computerUserName(roster, new Set(['agent_zz']))).toBe('agent_zz');
    expect(computerUserName(roster, new Set())).toBeNull();
    expect(computerUserName(roster)).toBeNull();
  });
});

describe('menuStep', () => {
  it('moves with the arrows, wrapping, and jumps with Home and End', () => {
    expect(menuStep('ArrowDown', 0, 2)).toBe(1);
    expect(menuStep('ArrowRight', 1, 2)).toBe(0);
    expect(menuStep('ArrowUp', 0, 2)).toBe(1);
    expect(menuStep('ArrowLeft', 1, 2)).toBe(0);
    expect(menuStep('Home', 1, 2)).toBe(0);
    expect(menuStep('End', 0, 2)).toBe(1);
    expect(menuStep('a', 0, 2)).toBeNull();
    expect(menuStep('ArrowDown', 0, 0)).toBeNull();
  });
});

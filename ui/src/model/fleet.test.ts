import { describe, expect, it } from 'vitest';
import { en } from '../locales/en';
import { buildSoulForest, type CensusRow } from './census';
import { companionLabel, matchesQuery, searchTeams, teamKeys, teamNodeOf, teamsOf } from './fleet';
import { sampleCensus } from './fixtures';
import { translate } from '../lib/i18n';

const t = (key: keyof typeof en, vars?: Record<string, string | number>) => translate('en', key, vars);
const row = (agentId: string, parent: string | null = null, name: string | null = null): CensusRow => ({
  account: 'user', agentId, name, harness: 'claude', parent, presence: 'joined', unacked: 0, lastWake: null,
});

describe('fleet', () => {
  const nested = [row('lead', null, 'Luna'), row('a', 'lead', 'Scout'), row('b', 'a', 'Pixel'), row('solo', null, 'Archie')];

  it('makes one team per root, with every descendant and its depth', () => {
    const teams = teamsOf(buildSoulForest(nested));
    expect(teams.map((team) => team.lead.agentId)).toEqual(['lead', 'solo']);
    expect(teams[0].members.map((m) => [m.soul.agentId, m.depth])).toEqual([['a', 1], ['b', 2]]);
    expect(teams[1].members).toEqual([]);
    expect(teamKeys(teams[0])).toEqual(['user/lead', 'user/a', 'user/b']);
  });

  it('searches name, agent ID and harness, keeping a team while any soul matches', () => {
    const teams = teamsOf(buildSoulForest(nested));
    expect(matchesQuery(nested[1], '  SCOUT ')).toBe(true);
    expect(matchesQuery(nested[1], 'claude')).toBe(true);
    expect(matchesQuery(nested[1], 'pix')).toBe(false);
    const found = searchTeams(teams, 'pix');
    expect(found).toHaveLength(1);
    expect(found[0].leadMatches).toBe(false);
    expect(found[0].members.map((m) => m.soul.agentId)).toEqual(['b']);
    expect(searchTeams(teams, '')).toHaveLength(2);
    expect(searchTeams(teams, 'nobody')).toEqual([]);
  });

  it('finds the team a soul belongs to', () => {
    const forest = buildSoulForest(nested);
    expect(teamNodeOf(forest, 'user/b')?.soul.agentId).toBe('lead');
    expect(teamNodeOf(forest, 'user/solo')?.soul.agentId).toBe('solo');
    expect(teamNodeOf(forest, 'user/none')).toBeNull();
  });

  it('speaks friendly state and unread counts', () => {
    const [luna, child, left] = sampleCensus;
    expect(companionLabel(luna, t)).toBe('luna, codex, Ready');
    expect(companionLabel(child, t)).toBe('agent_c, unknown harness, Starting');
    expect(companionLabel(child, t, 1)).toBe('agent_c, unknown harness, Starting, 1 unread message');
    expect(companionLabel(child, t, 2)).toBe('agent_c, unknown harness, Starting, 2 unread messages');
    expect(companionLabel(left, t)).toMatch(/Offline.*Left — no longer available/);
  });
});

describe('matchesQuery role (agent-bot-identity #535)', () => {
  it('matches the declared role as the design\'s search does', () => {
    const [luna] = sampleCensus;
    expect(matchesQuery({ ...luna, role: 'Release captain' }, 'captain')).toBe(true);
    expect(matchesQuery(luna, 'captain')).toBe(false);
  });
});

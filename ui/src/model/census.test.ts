import { describe, expect, it } from 'vitest';
import {
  allSouls,
  availabilityNote,
  buildSoulForest,
  countSouls,
  displayHarness,
  displayName,
  findSoul,
  parentDisplayName,
  soulKey,
  withHues,
  type CensusRow,
  type Presence,
  type SoulNode,
  withoutArchived,
} from './census';

function mk(
  agentId: string,
  opts: Partial<Omit<CensusRow, 'agentId'>> = {},
): CensusRow {
  return {
    account: 'user',
    agentId,
    name: null,
    harness: null,
    parent: null,
    presence: 'joined',
    unacked: 0,
    lastWake: null,
    ...opts,
  };
}

// SuiteTests.swift's soul(_:parent:presence:) helper.
function soul(id: string, parent: string | null = null, presence: Presence = 'joined'): CensusRow {
  return mk(id, { name: id, harness: 'codex', parent, presence, lastWake: '2026-01-01T00:00:01Z' });
}

const ids = (nodes: SoulNode[]): string[] => nodes.flatMap((n) => [n.soul.agentId, ...ids(n.children)]);
const keys = (nodes: SoulNode[]) => nodes.map((n) => soulKey(n.soul));

describe('Soul forest', () => {
  it('nests subagents under their parent', () => {
    const forest = buildSoulForest([soul('agent_p'), soul('agent_c', 'agent_p')]);
    expect(forest).toHaveLength(1);
    expect(forest[0].soul.agentId).toBe('agent_p');
    expect(forest[0].children.map((n) => n.soul.agentId)).toEqual(['agent_c']);
  });

  it('makes orphaned children (parent absent) roots', () => {
    const forest = buildSoulForest([soul('agent_c', 'agent_gone')]);
    expect(forest.map((n) => n.soul.agentId)).toEqual(['agent_c']);
  });

  it('renders every soul once through a parent cycle or a self-parent', () => {
    const cycle = buildSoulForest([soul('agent_a', 'agent_b'), soul('agent_b', 'agent_a')]);
    expect(ids(cycle)).toEqual(['agent_a', 'agent_b']);
    expect(cycle).toHaveLength(1);
    const selfParent = buildSoulForest([soul('agent_x', 'agent_x'), soul('agent_r')]);
    expect(ids(selfParent).sort()).toEqual(['agent_r', 'agent_x']);
  });

  it('renders every census soul, including left presence', () => {
    const forest = buildSoulForest([soul('agent_p'), soul('agent_c', 'agent_p', 'left')]);
    expect(forest[0].children).toHaveLength(1);
  });

  it('sorts children by agent ID for a stable listing', () => {
    const forest = buildSoulForest([soul('agent_p'), soul('agent_z', 'agent_p'), soul('agent_a', 'agent_p')]);
    expect(forest[0].children.map((n) => n.soul.agentId)).toEqual(['agent_a', 'agent_z']);
  });

  it('nests the census contract sample, null fields included', () => {
    // BrokerClientTests.censusContract's reply; decoding now belongs to
    // agent-comms, so only the rows-to-forest half is ported.
    const reply = JSON.parse(
      '{"ok":true,"souls":[{"account":"user","agentId":"agent_1","name":"luna","harness":"codex","parent":null,"presence":"joined","unacked":0,"lastWake":"2026-01-01T00:00:01Z"},{"account":"user","agentId":"agent_2","name":null,"harness":null,"parent":"agent_1","presence":"watching","unacked":3,"lastWake":null}]}',
    ) as { souls: CensusRow[] };
    const souls = reply.souls;
    expect(souls).toHaveLength(2);
    expect(souls[0].name).toBe('luna');
    expect(souls[1].parent).toBe('agent_1');
    const forest = buildSoulForest(souls);
    expect(forest).toHaveLength(1);
    expect(forest[0].children).toHaveLength(1);
  });
});

describe('Roster keys and fallbacks', () => {
  it('keys rows by account and agent ID, never by display name', () => {
    expect(soulKey(mk('agent_1', { name: 'luna' }))).toBe('user/agent_1');
    expect(soulKey(mk('agent_1', { account: 'other', name: 'luna' }))).toBe('other/agent_1');
  });

  it('keeps duplicate display names as separate rows', () => {
    const forest = buildSoulForest([mk('agent_1', { name: 'luna' }), mk('agent_2', { name: 'luna' })]);
    expect(forest).toHaveLength(2);
    expect(new Set(keys(forest)).size).toBe(2);
  });

  it('never merges the same agent ID under different accounts', () => {
    const forest = buildSoulForest([
      mk('agent_p', { account: 'a' }),
      mk('agent_c', { account: 'a', parent: 'agent_p' }),
      mk('agent_p', { account: 'b' }),
    ]);
    expect(forest).toHaveLength(2);
    const aRoot = forest.find((n) => soulKey(n.soul) === 'a/agent_p');
    const bRoot = forest.find((n) => soulKey(n.soul) === 'b/agent_p');
    expect(aRoot && keys(aRoot.children)).toEqual(['a/agent_c']);
    expect(bRoot?.children).toEqual([]);
  });

  it('falls back to the short agent ID when the name is missing', () => {
    expect(displayName(mk('agent_abcdef1234'))).toBe('agent_ab');
    expect(displayName(mk('agent_abcdef1234', { name: '' }))).toBe('agent_ab');
    expect(displayName(mk('agent_abcdef1234', { name: 'luna' }))).toBe('luna');
  });

  it('falls back to unknown harness when the harness is missing', () => {
    expect(displayHarness(mk('agent_1'))).toBe('unknown harness');
    expect(displayHarness(mk('agent_1', { harness: '' }))).toBe('unknown harness');
    expect(displayHarness(mk('agent_1', { harness: 'codex' }))).toBe('codex');
  });

  it('gives left souls a text state and explanation', () => {
    expect(availabilityNote(mk('agent_1', { presence: 'left' }))).not.toBeNull();
    expect(availabilityNote(mk('agent_1', { presence: 'joined' }))).toBeNull();
    expect(availabilityNote(mk('agent_1', { presence: 'watching' }))).toBeNull();
  });

  it('collapses repeat census entries instead of duplicating rows', () => {
    const dupe = mk('agent_1', { name: 'luna' });
    expect(buildSoulForest([dupe, dupe])).toHaveLength(1);
  });

  it('replaces rows without duplication when reconciling after an outage', () => {
    buildSoulForest([mk('agent_a'), mk('agent_b')]);
    const after = buildSoulForest([mk('agent_b'), mk('agent_c')]);
    expect(keys(after).sort()).toEqual(['user/agent_b', 'user/agent_c']);
  });
});

describe('Parent name', () => {
  it("resolves a known parent to the parent soul's name", () => {
    const parent = mk('agent_p', { name: 'claude-main' });
    const child = mk('agent_c', { parent: 'agent_p' });
    expect(parentDisplayName(child, [parent, child])).toBe('claude-main');
  });

  it('falls back to null for an unknown parent (the caller shows the raw ID)', () => {
    const child = mk('agent_c', { parent: 'agent_gone' });
    expect(parentDisplayName(child, [child])).toBeNull();
  });

  it('gives a root soul no parent name', () => {
    const root = mk('agent_p', { name: 'claude-main' });
    expect(parentDisplayName(root, [root])).toBeNull();
  });
});

describe('Forest helpers', () => {
  it('finds souls by bare and roster-key IDs, and counts the forest', () => {
    const forest = buildSoulForest([
      mk('agent_p', { name: 'p' }),
      mk('agent_c', { name: 'c', parent: 'agent_p', presence: 'left' }),
    ]);
    expect(countSouls(forest)).toBe(2);
    expect(findSoul(forest, 'agent_c')?.presence).toBe('left');
    expect(findSoul(forest, 'user/agent_c')?.agentId).toBe('agent_c');
    expect(findSoul(forest, 'agent_gone')).toBeNull();
    expect(countSouls([])).toBe(0);
    expect(allSouls(forest).map((s) => s.agentId)).toEqual(['agent_p', 'agent_c']);
  });
});

describe('withHues (#64)', () => {
  const a: CensusRow = { account: 'u', agentId: 'agent_a', name: 'a', harness: null, parent: null, presence: 'joined', unacked: 0, lastWake: null };
  const b: CensusRow = { ...a, agentId: 'agent_b', name: 'b' };

  it('joins declared hues by agent ID and keeps the rest of each row', () => {
    const out = withHues([a, b], new Map([['agent_a', 210]]));
    expect(out[0]).toEqual({ ...a, hue: 210 });
    expect(out[1]).toBe(b);
  });

  it('keeps the same array when nothing changes, and drops a hue no longer declared', () => {
    const rows = [a, b];
    expect(withHues(rows, undefined)).toBe(rows);
    expect(withHues(rows, new Map())).toBe(rows);
    const hued = withHues(rows, new Map([['agent_b', 30]]));
    expect(withHues(hued, new Map([['agent_b', 30]]))).toBe(hued);
    expect(withHues(hued, new Map())[1]).not.toHaveProperty('hue');
  });
});

describe('withoutArchived (#196)', () => {
  const left = { account: 'a', agentId: 'agent_gone', presence: 'left' } as never;
  const stays = { account: 'a', agentId: 'agent_left', presence: 'left' } as never;
  const joined = { account: 'a', agentId: 'agent_here', presence: 'joined' } as never;
  const souls = [left, stays, joined];

  it('drops the rows of souls agent-bot has archived, and only those', () => {
    const population = [
      { agentId: 'agent_gone', status: 'retired' },
      { agentId: 'agent_left', status: 'active' },
      { agentId: 'agent_here', status: null },
    ];
    expect(withoutArchived(souls, population)).toEqual([stays, joined]);
  });

  it('hides nothing without a population read or without archived souls', () => {
    expect(withoutArchived(souls, null)).toBe(souls);
    expect(withoutArchived(souls, [{ agentId: 'agent_here', status: 'active' }])).toBe(souls);
  });
});

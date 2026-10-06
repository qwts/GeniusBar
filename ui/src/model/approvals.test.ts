import { describe, expect, it } from 'vitest';
import { badgeText, menuApprovals, workingCount } from './approvals';
import type { CensusRow } from './census';
import type { ApprovalRecord, LocalApproval } from './chat';

const record = (proposalId: string, agentId: string, createdAt: string, extra: Partial<ApprovalRecord> = {}): ApprovalRecord =>
  ({ proposalId, agentId, soul: null, tool: 'Bash', summary: `run ${proposalId}`, createdAt, expiresAt: null, status: 'pending', ...extra });
const row = (agentId: string, name: string | null, presence: string = 'joined'): CensusRow =>
  ({ account: 'user', agentId, name, harness: 'claude', parent: null, presence: presence as CensusRow['presence'], unacked: 0, lastWake: null });

describe('menuApprovals', () => {
  const roster = [row('agent_a', 'atlas'), row('agent_b', 'beacon')];

  it('lists pending proposals across companions, oldest first, named from the census', () => {
    const items = menuApprovals([
      record('p2', 'agent_b', '2026-10-05T10:05:00Z', { tool: 'terminal' }),
      record('p1', 'agent_a', '2026-10-05T10:00:00Z'),
      record('p3', 'agent_a', '2026-10-05T10:01:00Z', { status: 'approved' }),
    ], new Map(), roster);
    expect(items.map((i) => i.proposalId)).toEqual(['p1', 'p2']);
    expect(items[0]).toMatchObject({ name: 'atlas', tool: 'Bash', command: 'run p1', deciding: false, error: null });
    expect(items[0].soul?.agentId).toBe('agent_a');
    expect(items[1]).toMatchObject({ name: 'beacon', tool: 'terminal' });
  });

  it('names a companion missing from the census by its soul name or short id, and cannot open it', () => {
    const items = menuApprovals([
      record('p1', 'agent_unknown_long', '2026-10-05T10:00:00Z', { soul: 'ghost' }),
      record('p2', 'agent_unknown_long', '2026-10-05T10:01:00Z', { tool: null }),
    ]);
    expect(items[0]).toMatchObject({ name: 'ghost', soul: null });
    expect(items[1]).toMatchObject({ name: 'agent_un', tool: 'tool' });
  });

  it('drops proposals decided here and carries a decision in flight or failed', () => {
    const entry = (id: string, status: 'pending' | 'approved', deciding: boolean, error: string | null): LocalApproval => ({
      agentId: 'agent_a',
      entry: { id, kind: 'approval_request', tool: 'Bash', args: '', risk: 'external', status, at: 0, seq: null, deciding, error },
    });
    const local = new Map([
      ['p1', entry('p1', 'approved', false, null)],
      ['p2', entry('p2', 'pending', true, null)],
      ['p3', entry('p3', 'pending', false, 'not confirmed')],
    ]);
    const items = menuApprovals(['p1', 'p2', 'p3'].map((id, i) => record(id, 'agent_a', `2026-10-05T10:0${i}:00Z`)), local, roster);
    expect(items.map((i) => [i.proposalId, i.deciding, i.error])).toEqual([['p2', true, null], ['p3', false, 'not confirmed']]);
  });

  it('keeps one card per proposal and puts unknown times first', () => {
    const items = menuApprovals([record('p2', 'agent_a', '2026-10-05T10:00:00Z'), record('p2', 'agent_a', 'x'), record('p1', 'agent_a', '')]);
    expect(items.map((i) => [i.proposalId, i.createdAt])).toEqual([['p1', 0], ['p2', Date.parse('2026-10-05T10:00:00Z')]]);
  });
});

describe('counts', () => {
  it('counts busy companions from the census', () => {
    expect(workingCount([row('a', 'a'), row('b', 'b', 'watching'), row('c', 'c', 'left')])).toBe(0);
    expect(workingCount([row('a', 'a', 'working'), row('b', 'b', 'busy'), row('c', 'c')])).toBe(2);
  });

  it('badges nothing at zero and caps large counts', () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(3)).toBe('3');
    expect(badgeText(120)).toBe('99+');
  });
});

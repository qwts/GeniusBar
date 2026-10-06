import { describe, expect, it } from 'vitest';
import { AUDIT_HOST, auditJson, auditRows, auditTime, normalizeAudit, normalizeAuditRecord } from './audit';
import { sampleAudit, sampleCensus } from './fixtures';

describe('audit records', () => {
  it('keeps the known string fields and drops malformed records', () => {
    expect(normalizeAudit({ records: [
      { at: '2026-10-05T10:00:00Z', event: 'permission', agentId: 'agent_p', operation: 'Bash', decision: 'allow', detail: 'Bash: ls', extra: 'x', transport: 7 },
      { at: '2026-10-05T10:01:00Z' },
      { event: 'permission' },
      { at: 1, event: 'permission' },
      { at: '2026-10-05T10:02:00Z', event: '' },
      null,
      'line',
      { at: '2026-10-05T10:03:00Z', event: 'credential-mint', detail: '' },
    ] })).toEqual([
      { at: '2026-10-05T10:00:00Z', event: 'permission', agentId: 'agent_p', operation: 'Bash', decision: 'allow', detail: 'Bash: ls' },
      { at: '2026-10-05T10:03:00Z', event: 'credential-mint' },
    ]);
    expect(normalizeAudit({ records: [] })).toEqual([]);
  });

  it('is null for anything but a records list', () => {
    expect(normalizeAudit(null)).toBeNull();
    expect(normalizeAudit([])).toBeNull();
    expect(normalizeAudit({ records: {} })).toBeNull();
    expect(normalizeAudit({ error: { code: 'x', message: 'y' } })).toBeNull();
    expect(normalizeAuditRecord([])).toBeNull();
  });
});

describe('audit rows', () => {
  it('shows newest first with names from the roster', () => {
    const rows = auditRows(sampleAudit, sampleCensus);
    expect(rows.map((r) => r.at)).toEqual([...sampleAudit].map((r) => r.at).reverse());
    expect(rows[0]).toMatchObject({ who: 'luna', event: 'permission · allow', detail: 'Bash: npm test' });
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it('falls back to the agent id, then GeniusBar, and to the operation for detail', () => {
    const rows = auditRows([
      { at: '2026-10-05T10:00:00Z', event: 'credential-grant', agentId: 'agent_x', operation: 'grant' },
      { at: '2026-10-05T10:01:00Z', event: 'cold-wake-setting' },
    ], sampleCensus);
    expect(rows.map(({ who, event, detail }) => ({ who, event, detail }))).toEqual([
      { who: AUDIT_HOST, event: 'cold-wake-setting', detail: '' },
      { who: 'agent_x', event: 'credential-grant', detail: 'grant' },
    ]);
  });

  it('sorts by time, keeping ties newest-last order reversed and unreadable times last', () => {
    const rows = auditRows([
      { at: 'later?', event: 'a' },
      { at: '2026-10-05T10:00:00Z', event: 'b' },
      { at: '2026-10-05T12:00:00Z', event: 'c' },
      { at: '2026-10-05T10:00:00Z', event: 'd' },
    ]);
    expect(rows.map((r) => r.event)).toEqual(['c', 'd', 'b', 'a']);
  });

  it('exports the shown records, pretty-printed', () => {
    const rows = auditRows(sampleAudit.slice(0, 2), sampleCensus);
    const json = auditJson(rows);
    expect(JSON.parse(json)).toEqual([sampleAudit[1], sampleAudit[0]]);
    expect(json).toContain('\n  {');
    expect(auditJson([])).toBe('[]');
  });

  it('formats times, keeping unreadable ones as given', () => {
    expect(auditTime('2026-10-05T10:00:00Z', 'en')).toMatch(/2026/);
    expect(auditTime('soon', 'en')).toBe('soon');
  });
});

import { describe, expect, it } from 'vitest';
import { normalizeSoulDreamStatus, soulDreamQuarantined } from './soulDream';

const AGENT = 'agent_00000000-0000-4000-8000-000000000000';
const RUN = '00000000-0000-4000-8000-000000000000';

const status = (flightStatus: string | null = null) => ({
  schemaVersion: 1, agentId: AGENT, available: true, executorConfigured: false, started: true, closing: false,
  orphanRecovery: 'process-group-or-quarantine', fault: null, maintenanceCoverage: 'unverified',
  registration: null, flights: flightStatus ? [{ agentId: AGENT, runId: RUN, status: flightStatus }] : [],
  notices: { schemaVersion: 1, agentId: AGENT, lastRunId: null, suppressed: 0, notices: [{
    id: 'ntc_0123456789abcdef01234567', fingerprint: `sha256:${'a'.repeat(64)}`, kind: 'recovery', subject: {},
    detail: 'recovery-required', claim: 'host-observed', state: 'acknowledged', delivery: 'host-acknowledged',
    firstRunId: RUN, lastRunId: RUN, firstSeenAt: '2026-10-08T09:12:00.000Z', lastSeenAt: '2026-10-08T09:12:00.000Z',
    occurrences: 2, acknowledgedAt: '2026-10-09T12:00:00.000Z',
  }] },
});

describe('native soul dream status', () => {
  it('normalizes only schema-1 status for the requested soul and retains the real notice ledger', () => {
    const value = normalizeSoulDreamStatus(status(), AGENT);
    expect(value?.notices?.notices[0]).toMatchObject({ kind: 'recovery', occurrences: 2, state: 'acknowledged', delivery: 'host-acknowledged' });
    expect(value?.maintenanceCoverage).toBe('unverified');
    expect(normalizeSoulDreamStatus(status(), 'agent_other')).toBeNull();
    expect(normalizeSoulDreamStatus({ ...status(), schemaVersion: 2 }, AGENT)).toBeNull();
  });

  it('does not treat daemon recovery mode or an acknowledged notice as a live quarantine', () => {
    const value = normalizeSoulDreamStatus(status(), AGENT)!;
    expect(soulDreamQuarantined(value)).toBe(false);
    const quarantined = normalizeSoulDreamStatus(status('recovery-required'), AGENT)!;
    expect(soulDreamQuarantined(quarantined)).toBe(true);
    // Acknowledging only changes the ledger delivery state; the flight stays quarantined.
    expect(quarantined.notices?.notices[0].state).toBe('acknowledged');
  });

  it('uses the engine registration shape and accepts paused rows only with a null next due time', () => {
    const registration = { agentId: AGENT, soulDir: '/souls/example.soul', generation: RUN, intervalHours: 24,
      paused: true, nextDueAt: null, createdAt: '2026-10-08T09:12:00.000Z', updatedAt: '2026-10-09T12:00:00.000Z', lastRun: null };
    expect(normalizeSoulDreamStatus({ ...status(), registration }, AGENT)?.registration?.paused).toBe(true);
    expect(normalizeSoulDreamStatus({ ...status(), registration: { ...registration, paused: false } }, AGENT)).toBeNull();
    expect(normalizeSoulDreamStatus({ ...status(), registration: { ...registration, paused: false, nextDueAt: '2026-10-10T12:00:00.000Z' } }, AGENT)?.registration?.paused).toBe(false);
  });

  it('rejects malformed notice ledgers instead of presenting a partial, misleading list', () => {
    const raw = status();
    (raw.notices.notices[0] as { occurrences: number }).occurrences = 0;
    expect(normalizeSoulDreamStatus(raw, AGENT)).toBeNull();
  });
});

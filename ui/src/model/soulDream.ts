import { BridgeError, soulDreamStatus } from '../bridge';

export type DreamNoticeKind = 'execution' | 'report' | 'evidence' | 'item-blocked' | 'capability' | 'change' | 'recovery';
export type DreamNoticeClaim = 'host-observed' | 'agent-reported' | 'unattributed-change';
export interface SoulDreamNotice {
  id: string;
  fingerprint: string;
  kind: DreamNoticeKind;
  subject: Record<string, unknown>;
  detail: string;
  claim: DreamNoticeClaim;
  state: 'open' | 'acknowledged';
  delivery: 'pending-host-read' | 'host-acknowledged';
  firstRunId: string;
  lastRunId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  acknowledgedAt: string | null;
}
export interface SoulDreamFlight {
  agentId: string;
  runId: string;
  status: string;
  [field: string]: unknown;
}
export interface SoulDreamRegistration extends Record<string, unknown> {
  agentId: string;
  intervalHours: number;
  paused: boolean;
  nextDueAt: string | null;
}
export interface SoulDreamStatus {
  schemaVersion: 1;
  agentId: string;
  available: boolean;
  executorConfigured: boolean;
  started: boolean | null;
  closing: boolean | null;
  orphanRecovery: string | null;
  fault: string | null;
  maintenanceCoverage: 'unverified';
  registration: SoulDreamRegistration | null;
  flights: SoulDreamFlight[];
  notices: { schemaVersion: 1; agentId: string; lastRunId: string | null; suppressed: number; notices: SoulDreamNotice[] } | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const NOTICE_KINDS: readonly string[] = ['execution', 'report', 'evidence', 'item-blocked', 'capability', 'change', 'recovery'];
const CLAIMS: readonly string[] = ['host-observed', 'agent-reported', 'unattributed-change'];

function normalizeNotice(raw: unknown): SoulDreamNotice | null {
  if (!isRecord(raw) || !text(raw.id) || !text(raw.fingerprint) || !text(raw.kind) || !NOTICE_KINDS.includes(raw.kind)
    || !isRecord(raw.subject) || !text(raw.detail) || !text(raw.claim) || !CLAIMS.includes(raw.claim)
    || (raw.state !== 'open' && raw.state !== 'acknowledged')
    || (raw.delivery !== 'pending-host-read' && raw.delivery !== 'host-acknowledged')
    || !text(raw.firstRunId) || !text(raw.lastRunId) || !text(raw.firstSeenAt) || !text(raw.lastSeenAt)
    || !Number.isSafeInteger(raw.occurrences) || (raw.occurrences as number) < 1
    || !(raw.acknowledgedAt === null || text(raw.acknowledgedAt))) return null;
  return {
    id: raw.id, fingerprint: raw.fingerprint, kind: raw.kind as DreamNoticeKind, subject: raw.subject,
    detail: raw.detail, claim: raw.claim as DreamNoticeClaim, state: raw.state, delivery: raw.delivery,
    firstRunId: raw.firstRunId, lastRunId: raw.lastRunId, firstSeenAt: raw.firstSeenAt, lastSeenAt: raw.lastSeenAt,
    occurrences: raw.occurrences as number, acknowledgedAt: raw.acknowledgedAt,
  };
}

/** Validate the daemon's per-soul `soul skill dream --status --json` response. */
export function normalizeSoulDreamStatus(raw: unknown, expectedAgentId: string): SoulDreamStatus | null {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.agentId !== expectedAgentId || raw.maintenanceCoverage !== 'unverified'
    || typeof raw.available !== 'boolean' || typeof raw.executorConfigured !== 'boolean'
    || !(typeof raw.started === 'boolean' || raw.started === null)
    || !(typeof raw.closing === 'boolean' || raw.closing === null)
    || !(raw.orphanRecovery === null || text(raw.orphanRecovery)) || !(raw.fault === null || text(raw.fault))
    || !Array.isArray(raw.flights)) return null;
  let registration: SoulDreamRegistration | null = null;
  if (raw.registration !== null) {
    if (!isRecord(raw.registration) || raw.registration.agentId !== expectedAgentId
      || !Number.isSafeInteger(raw.registration.intervalHours) || (raw.registration.intervalHours as number) < 1
      || (raw.registration.intervalHours as number) > 720 || typeof raw.registration.paused !== 'boolean'
      || !(raw.registration.paused ? raw.registration.nextDueAt === null : text(raw.registration.nextDueAt))) return null;
    registration = raw.registration as SoulDreamRegistration;
  }
  const flights: SoulDreamFlight[] = [];
  for (const flight of raw.flights) {
    if (!isRecord(flight) || flight.agentId !== expectedAgentId || !text(flight.runId) || !text(flight.status)) return null;
    flights.push(flight as SoulDreamFlight);
  }
  let notices: SoulDreamStatus['notices'] = null;
  if (raw.notices !== null) {
    if (!isRecord(raw.notices) || raw.notices.schemaVersion !== 1 || raw.notices.agentId !== expectedAgentId
      || !(raw.notices.lastRunId === null || text(raw.notices.lastRunId)) || !Number.isSafeInteger(raw.notices.suppressed)
      || (raw.notices.suppressed as number) < 0 || !Array.isArray(raw.notices.notices)) return null;
    const rows = raw.notices.notices.map(normalizeNotice);
    if (rows.some((notice) => notice === null)) return null;
    notices = { schemaVersion: 1, agentId: expectedAgentId, lastRunId: raw.notices.lastRunId,
      suppressed: raw.notices.suppressed as number, notices: rows as SoulDreamNotice[] };
  }
  return {
    schemaVersion: 1, agentId: expectedAgentId, available: raw.available, executorConfigured: raw.executorConfigured,
    started: raw.started, closing: raw.closing, orphanRecovery: raw.orphanRecovery, fault: raw.fault,
    maintenanceCoverage: 'unverified', registration,
    flights, notices,
  };
}

export function soulDreamQuarantined(status: SoulDreamStatus): boolean {
  // `orphanRecovery` currently describes the daemon's recovery mechanism;
  // only a per-soul flight marked recovery-required is a live quarantine.
  return status.flights.some((flight) => flight.status === 'recovery-required');
}

export async function readSoulDream(agentId: string): Promise<SoulDreamStatus> {
  const raw = await soulDreamStatus(agentId);
  const result = normalizeSoulDreamStatus(raw, agentId);
  if (!result) throw new BridgeError('soul-dream-failed', 'agent-bot gave no valid dream status for this soul');
  return result;
}


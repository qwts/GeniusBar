// The audit log (#122): agent-bot's `audit list --json` records, as the
// Lovable Audit log table shows them. agent-bot already sanitizes and
// bounds every field; this only drops malformed records and arranges rows.
import { displayName, type CensusRow } from './census';

/** One record from `agent-bot audit list --json`; every field a string. */
export interface AuditRecord {
  at: string;
  event: string;
  principalId?: string;
  transport?: string;
  agentId?: string;
  operation?: string;
  decision?: string;
  detail?: string;
}

const OPTIONAL = ['principalId', 'transport', 'agentId', 'operation', 'decision', 'detail'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One record with only the known fields, or null when it lacks `at` or `event`. */
export function normalizeAuditRecord(raw: unknown): AuditRecord | null {
  if (!isRecord(raw) || typeof raw.at !== 'string' || typeof raw.event !== 'string' || raw.event === '') return null;
  const record: AuditRecord = { at: raw.at, event: raw.event };
  for (const key of OPTIONAL) {
    const value = raw[key];
    if (typeof value === 'string' && value !== '') record[key] = value;
  }
  return record;
}

/** `{records: [...]}` with malformed records dropped; null for any other shape. */
export function normalizeAudit(raw: unknown): AuditRecord[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.records)) return null;
  return raw.records.map(normalizeAuditRecord).filter((r): r is AuditRecord => r !== null);
}

/** A table row: Time / Companion / Event / Detail, with the record it shows. */
export interface AuditRow {
  key: string;
  at: string;
  who: string;
  event: string;
  detail: string;
  record: AuditRecord;
}

/** The fallback name for a record no companion made. */
export const AUDIT_HOST = 'GeniusBar';

const timeOf = (at: string): number => {
  const time = Date.parse(at);
  return Number.isFinite(time) ? time : -Infinity;
};

/**
 * Rows newest first. agent-bot lists newest last, so ties (and unreadable
 * times, which sink to the end) keep that order reversed.
 */
export function auditRows(records: readonly AuditRecord[], roster: readonly CensusRow[] = []): AuditRow[] {
  return records
    .map((record, index) => ({ record, index, time: timeOf(record.at) }))
    .reverse()
    .sort((a, b) => (a.time === b.time ? 0 : b.time > a.time ? 1 : -1))
    .map(({ record, index }) => {
      const soul = record.agentId ? roster.find((row) => row.agentId === record.agentId) : undefined;
      return {
        key: `${index}:${record.at}:${record.event}`,
        at: record.at,
        who: soul ? displayName(soul) : record.agentId ?? AUDIT_HOST,
        event: record.decision ? `${record.event} · ${record.decision}` : record.event,
        detail: record.detail ?? record.operation ?? '',
        record,
      };
    });
}

/** The shown rows' records, newest first, pretty-printed for export. */
export function auditJson(rows: readonly AuditRow[]): string {
  return JSON.stringify(rows.map((row) => row.record), null, 2);
}

/** The design's medium date and time; the raw value when it is not a time. */
export function auditTime(at: string, lang: string): string {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return at;
  return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'medium' }).format(time);
}

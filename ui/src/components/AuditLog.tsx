import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { exportAudit, listAudit } from '../bridge';
import { useI18n } from '../lib/i18n';
import { auditJson, auditRows, auditTime, type AuditRecord } from '../model/audit';
import type { CensusRow } from '../model/census';

/** Reads the audit log; null when agent-bot cannot say. The preview swaps in fixtures. */
export type AuditSource = (agentId: string | null) => Promise<AuditRecord[] | null>;
export const AuditSourceContext = createContext<AuditSource>((agentId) => listAudit(agentId));

/** What the last Export JSON or Copy JSON did; each is an `audit.*` string. */
type Notice = 'saved' | 'saveFailed' | 'copied' | 'copyFailed';

/** The design refreshes the log while it is shown; never otherwise. */
export const AUDIT_REFRESH_MS = 10_000;

/**
 * The design's Audit log (Lovable `AuditLog`): Time / Companion / Event /
 * Detail, newest first, with Export JSON (a file) and Copy JSON at the top right. One companion's
 * records, or (agentId null) every companion's. It reads while mounted, so
 * only the shown tab polls; a hidden window skips its reads.
 */
export function AuditLog({ agentId, roster = [] }: { agentId: string | null; roster?: readonly CensusRow[] }) {
  const { t, lang } = useI18n();
  const load = useContext(AuditSourceContext);
  // undefined while the first read is out; null when agent-bot cannot say.
  const [records, setRecords] = useState<AuditRecord[] | null | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    let active = true;
    setRecords(undefined);
    const read = () => {
      void load(agentId).then((next) => {
        // A refresh that fails keeps the last list rather than flashing away.
        if (active) setRecords((prev) => next ?? (Array.isArray(prev) ? prev : null));
      }, () => { if (active) setRecords((prev) => (Array.isArray(prev) ? prev : null)); });
    };
    read();
    const timer = setInterval(() => { if (!document.hidden) read(); }, AUDIT_REFRESH_MS);
    return () => { active = false; clearInterval(timer); };
  }, [agentId, load]);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const rows = useMemo(() => auditRows(records ?? [], roster), [records, roster]);

  const done = (result: Notice) => {
    setNotice(result);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setNotice(null), 2000);
  };
  // As the design: Export JSON saves a file (the bridge writes it to ~/Downloads).
  const exportJson = () => {
    exportAudit(auditJson(rows)).then(() => done('saved'), () => done('saveFailed'));
  };
  // The earlier export, kept: the same JSON onto the clipboard.
  const copyJson = () => {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard?.writeText) { done('copyFailed'); return; }
    clipboard.writeText(auditJson(rows)).then(() => done('copied'), () => done('copyFailed'));
  };

  let body;
  if (records === undefined) body = <p className="m-0 text-sm text-muted-foreground" role="status">{t('audit.loading')}</p>;
  else if (records === null) body = <p className="m-0 text-sm text-muted-foreground">{t('audit.unavailable')}</p>;
  else if (rows.length === 0) body = <p className="m-0 text-sm text-muted-foreground">{t('auditEmpty')}</p>;
  else {
    body = (
      <div className="relative w-full overflow-auto">
        <table className="w-full text-sm" aria-label={t('auditTitle')}>
          <thead className="[&_tr]:border-b">
            <tr className="border-b border-border">
              {(['audit.time', 'audit.who', 'audit.event', 'audit.detail'] as const).map((key) => (
                <th key={key} scope="col" className="h-10 px-2 text-left align-middle font-medium text-muted-foreground">{t(key)}</th>
              ))}
            </tr>
          </thead>
          <tbody className="[&_tr:last-child]:border-0">
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-border transition-colors hover:bg-muted/50">
                <td className="p-2 align-middle whitespace-nowrap font-mono text-xs text-muted-foreground">
                  <time dateTime={row.at}>{auditTime(row.at, lang)}</time>
                </td>
                <td className="p-2 align-middle text-sm">{row.who}</td>
                <td className="p-2 align-middle font-mono text-xs text-primary">{row.event}</td>
                <td className="max-w-md truncate p-2 align-middle text-xs" title={row.detail || undefined}>{row.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6">
      <div className="mb-3 flex items-center justify-end gap-2">
        {notice && (
          <span role="status" className={`text-xs ${notice.endsWith('Failed') ? 'error' : 'text-muted-foreground'}`}>
            {t(`audit.${notice}`)}
          </span>
        )}
        <button type="button" onClick={copyJson} disabled={rows.length === 0}
          className="h-8 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-50">
          {t('audit.copy')}
        </button>
        <button type="button" onClick={exportJson} disabled={rows.length === 0}
          className="inline-flex h-8 items-center gap-2 rounded-md bg-secondary px-3 text-xs font-medium text-secondary-foreground shadow-sm hover:bg-secondary/80 disabled:pointer-events-none disabled:opacity-50">
          <Download className="size-4" aria-hidden /> {t('exportJson')}
        </button>
      </div>
      {body}
    </div>
  );
}

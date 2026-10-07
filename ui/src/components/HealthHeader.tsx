import type { ReactNode } from 'react';
import { useI18n } from '../lib/i18n';
import { credentialNote, healthHeader, type ConnectionSnapshot } from '../model/status';

/**
 * The GeniusBar menu's title row, as the Lovable design: the name on the
 * left and, where the design has its counts, the broker health in mono
 * (destructive when it fails), then the credential state.
 */
export function HealthHeader({ connection, children }: { connection: ConnectionSnapshot; children?: ReactNode }) {
  const { t } = useI18n();
  const header = healthHeader(connection, t);
  const note = credentialNote(connection);
  return (
    <header className="border-b border-border p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h1 className="m-0 flex-1 text-sm font-semibold">GeniusBar</h1>
        <div role="status" aria-label={header.label} className="min-w-0">
          <p className={`health-title justify-end font-mono text-[11px] ${header.tone === 'bad' ? 'text-destructive' : ''}`}>
            <span className={`dot dot-${header.tone}`} aria-hidden="true" />
            {header.title}
          </p>
          {header.detail && <p className="muted small m-0 text-right font-mono">{header.detail}</p>}
        </div>
        {children}
      </div>
      {note && <p className="note small">{note}</p>}
    </header>
  );
}

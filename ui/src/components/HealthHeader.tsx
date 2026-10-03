import type { ReactNode } from 'react';
import { credentialNote, healthHeader, type ConnectionSnapshot } from '../model/status';

/** The GeniusBar menu's title, with broker health and the credential state. */
export function HealthHeader({ connection, children }: { connection: ConnectionSnapshot; children?: ReactNode }) {
  const header = healthHeader(connection);
  const note = credentialNote(connection);
  return (
    <header className="border-b border-border px-3.5 py-2.5">
      <div className="flex items-center gap-2">
        <span className="grid size-5 place-items-center rounded-[5px] bg-foreground text-[11px] font-bold text-background" aria-hidden>G</span>
        <h1 className="m-0 flex-1 text-sm font-semibold">GeniusBar</h1>
        {children}
      </div>
      <div role="status" aria-label={header.label} className="mt-1">
        <p className="health-title">
          <span className={`dot dot-${header.tone}`} aria-hidden="true" />
          {header.title}
        </p>
        {header.detail && <p className="muted small m-0">{header.detail}</p>}
      </div>
      {note && <p className="note small">{note}</p>}
    </header>
  );
}

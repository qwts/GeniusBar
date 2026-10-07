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
  const note = credentialNote(connection, t);
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

/**
 * The popover's header while setup is not done (Lovable SetupPanel): the
 * name, a status line with a dot (primary while setup runs), and what
 * GeniusBar needs. A failure the footer would show sits under it.
 */
export function SetupHeader({ connection, running, error }: { connection: ConnectionSnapshot; running: boolean; error?: string | null }) {
  const { t } = useI18n();
  const header = healthHeader(connection, t);
  const status = running ? t('setup.settingUp') : header.title;
  return (
    <header className="space-y-1 border-b border-border p-4 text-sm">
      <h1 className="m-0 text-base font-semibold">GeniusBar</h1>
      <p role="status" aria-label={running ? status : header.label} className="m-0 flex items-center gap-2 font-medium text-muted-foreground">
        <span className={`size-2 shrink-0 rounded-full ${running ? 'bg-primary' : 'bg-muted-foreground'}`} aria-hidden="true" />
        {status}
      </p>
      {!running && <p className="m-0 text-muted-foreground">{t('setup.needs')}</p>}
      {error && <p className="m-0 text-xs text-destructive" role="alert">{error}</p>}
    </header>
  );
}

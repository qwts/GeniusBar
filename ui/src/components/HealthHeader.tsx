import type { ReactNode } from 'react';
import { useI18n } from '../lib/i18n';
import { needsSetup } from '../model/setup';
import { credentialNote, healthHeader, type ConnectionSnapshot } from '../model/status';

/**
 * The GeniusBar menu's title row, as the Lovable design: the name, then the
 * counts in mono. While the broker is healthy and the credential has nothing
 * to say, that is all (the health stays for screen readers only); otherwise
 * the health line (destructive when it fails) and the credential state sit
 * under the row.
 */
export function HealthHeader({ connection, children }: { connection: ConnectionSnapshot; children?: ReactNode }) {
  const { t, lang } = useI18n();
  const header = healthHeader(connection, t, lang);
  const note = credentialNote(connection, t);
  const quiet = header.tone === 'ok' && !note;
  return (
    <header className="border-b border-border p-3">
      <div className="flex items-center gap-2">
        <h1 className="m-0 flex-1 text-sm font-semibold">GeniusBar</h1>
        {children}
      </div>
      {quiet ? (
        <span role="status" aria-label={header.label} className="sr-only">{header.title}</span>
      ) : (
        <div role="status" aria-label={header.label} className="mt-1 min-w-0">
          <p className={`health-title m-0 font-mono text-[11px] ${header.tone === 'bad' ? 'text-destructive' : ''}`}>
            <span className={`dot dot-${header.tone}`} aria-hidden="true" />
            {header.title}
          </p>
          {header.detail && <p className="m-0 font-mono text-xs text-muted-foreground">{header.detail}</p>}
        </div>
      )}
      {note && <p className="m-0 mt-1 text-xs text-muted-foreground">{note}</p>}
    </header>
  );
}

/**
 * The popover's header while setup is not done (Lovable SetupPanel): the
 * name, a status line with a dot (primary while setup runs), and, in the
 * design's `needs` phase only, what GeniusBar needs. Before anything is
 * known it says it is checking (`setup.checking`). A failure the footer
 * would show sits under it.
 */
export function SetupHeader({ connection, running, error }: { connection: ConnectionSnapshot; running: boolean; error?: string | null }) {
  const { t, lang } = useI18n();
  const header = healthHeader(connection, t, lang);
  const phase = running ? 'running' : needsSetup(connection) ? 'needs' : 'checking';
  const status = phase === 'running' ? t('setup.settingUp') : phase === 'checking' ? t('setup.checking') : header.title;
  return (
    <header className="space-y-1 border-b border-border p-4 text-sm">
      <h1 className="m-0 text-base font-semibold">GeniusBar</h1>
      <p role="status" aria-label={phase === 'needs' ? header.label : status} className="m-0 flex items-center gap-2 font-medium text-muted-foreground">
        <span className={`size-2 shrink-0 rounded-full ${running ? 'bg-primary' : 'bg-muted-foreground'}`} aria-hidden="true" />
        {status}
      </p>
      {phase === 'needs' && <p className="m-0 text-muted-foreground">{t('setup.needs')}</p>}
      {error && <p className="m-0 text-xs text-destructive" role="alert">{error}</p>}
    </header>
  );
}

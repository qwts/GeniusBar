import { useEffect, useState } from 'react';
import { Check, Circle, Download, Loader2, Terminal, TriangleAlert } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { textLink } from './ui';

export type ToolState = 'absent' | 'installed' | 'stale' | 'other';
export interface ToolsStatus {
  dir: string;
  tools: { name: string; state: ToolState; target?: string }[];
  /** Whether a new terminal finds `dir`, and the profile GeniusBar added it to. */
  path?: { onPath: boolean; profile: string | null };
}
export interface CliToolsApi {
  status: () => Promise<ToolsStatus>;
  install: (replace: string[]) => Promise<ToolsStatus>;
  uninstall: () => Promise<ToolsStatus>;
}

const errorText = (e: unknown, fallback: string) => {
  const message = (e as { message?: unknown })?.message;
  return typeof message === 'string' && message ? message : fallback;
};

/**
 * "Command-line tools" (#41): puts the bundled agent-bot and agent-comms on
 * PATH, like VS Code's `code` command, so an agent GeniusBar did not start
 * can join without Homebrew. Another copy already there is shown and only
 * replaced after the user says so; Uninstall puts it back.
 */
export function CliTools({ api, startOpen = false, onClose }: {
  api: CliToolsApi;
  /** Opened from a menu: starts on the panel, checking, and reports Close. */
  startOpen?: boolean;
  onClose?: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpenState] = useState(startOpen);
  const setOpen = (next: boolean) => { setOpenState(next); if (!next) onClose?.(); };
  const [status, setStatus] = useState<ToolsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<ToolsStatus>, fallback: string) => {
    setBusy(true);
    setError(null);
    try { setStatus(await action()); } catch (e) { setError(errorText(e, fallback)); } finally { setBusy(false); }
  };
  useEffect(() => { if (startOpen) void run(api.status, t('cli.checkFailed')); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) {
    return (
      <button type="button" className={textLink} onClick={() => { setOpen(true); void run(api.status, t('cli.checkFailed')); }}>
        <Terminal className="size-3.5" aria-hidden />{t('cli.action')}
      </button>
    );
  }
  const others = status?.tools.filter((tool) => tool.state === 'other') ?? [];
  const ours = status?.tools.some((tool) => tool.state === 'installed' || tool.state === 'stale') ?? false;
  const complete = status?.tools.every((tool) => tool.state === 'installed') ?? false;
  return (
    <div className="w-full min-w-0 space-y-2 rounded-md border border-border bg-muted/50 p-3 text-xs" role="group" aria-label={t('cli.label')}>
      <p className="break-words text-xs leading-relaxed text-muted-foreground">
        {t('cli.description')}
        {status && <> {t('cli.directory', { dir: status.dir })}</>}
      </p>
      {status?.path?.profile && (
        <p className="break-words text-xs leading-relaxed text-muted-foreground">{t('cli.profile', { profile: status.path.profile })}</p>
      )}
      {status?.path && !status.path.onPath && status.tools.some((tool) => tool.state === 'installed') && (
        <p className="break-words text-xs leading-relaxed text-muted-foreground">{t('cli.addPath', { dir: status.dir })}</p>
      )}
      {status && (
        <ul className="break-words text-xs leading-relaxed text-muted-foreground">
          {status.tools.map((tool) => (
            <li key={tool.name} className="flex flex-wrap items-center gap-1.5 py-1">
              {tool.state === 'installed' ? <Check className="size-3.5" aria-hidden /> : tool.state === 'absent' ? <Circle className="size-3.5" aria-hidden /> : <TriangleAlert className="size-3.5" aria-hidden />}
              <code>{tool.name}</code>{' '}
              {tool.state === 'installed' && t('cli.installed')}
              {tool.state === 'stale' && t('cli.stale')}
              {tool.state === 'absent' && t('cli.absent')}
              {tool.state === 'other' && <>{t('cli.other')} <code className="break-all">{tool.target}</code></>}
            </li>
          ))}
        </ul>
      )}
      {complete && (
        <p className="flex items-center gap-1.5 text-xs text-foreground" role="status">
          <Check className="size-3.5 text-success" aria-hidden />{t('bar.cliInstalled')}
        </p>
      )}
      {others.length > 0 && (
        <p className="break-words text-xs leading-relaxed text-muted-foreground">
          {t('cli.replace', { tools: others.map((tool) => tool.name).join(t('list.and')) })}
        </p>
      )}
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="inline-flex min-h-7 items-center justify-center gap-1.5 rounded-md border border-border bg-secondary px-3 py-1 text-xs text-secondary-foreground hover:bg-accent disabled:opacity-50" disabled={busy} onClick={() => setOpen(false)}>{t('close')}</button>
        {ours && (
          <button type="button" className="inline-flex min-h-7 items-center justify-center gap-1.5 rounded-md border border-border bg-secondary px-3 py-1 text-xs text-secondary-foreground hover:bg-accent disabled:opacity-50" disabled={busy} onClick={() => void run(api.uninstall, t('cli.uninstallFailed'))}>
            {t('cli.uninstall')}
          </button>
        )}
        {status && !complete && (
          <button type="button" className="inline-flex min-h-7 items-center justify-center gap-1.5 rounded-md border border-border bg-secondary px-3 py-1 text-xs text-secondary-foreground hover:bg-accent disabled:opacity-50" disabled={busy}
            onClick={() => void run(() => api.install(others.map((tool) => tool.name)), t('cli.installFailed'))}>
            <span className="inline-flex items-center gap-1.5">
              {busy ? <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /> : <Download className="size-3.5" aria-hidden />}
              {busy ? t('cli.installing') : others.length ? t('cli.replaceInstall') : t('cli.install')}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

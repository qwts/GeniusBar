import { useEffect, useRef, useState } from 'react';
import { Archive } from 'lucide-react';
import { removeSoul, soulComms, type RemovedSoul } from '../bridge';
import { displayName, type CensusRow } from '../model/census';
import { useI18n } from '../lib/i18n';

/** How GeniusBar archives a soul (#94); the app's is agent-bot's, previews pass a fake. */
export interface Archiver {
  remove: (agentId: string) => Promise<RemovedSoul>;
  /** Whether the soul runs now, the comms switch's lock; null when agent-bot cannot say. */
  running: (agentId: string) => Promise<boolean | null>;
}

export const liveArchiver: Archiver = {
  remove: (agentId) => removeSoul(agentId),
  running: (agentId) => soulComms(agentId).then((state) => state?.running ?? null),
};

/**
 * Asks before archiving a soul (#94), naming it and saying what happens.
 * Not `window.confirm`, which the Tauri web view blocks. Archive is locked
 * while the soul runs, as the comms switch is; agent-bot asks the owner
 * (Touch ID) and its refusals show here as-is, and the soul stays.
 */
export function ArchiveDialog({ soul, archiver, onCancel, onArchived }: {
  soul: CensusRow;
  archiver: Archiver;
  onCancel: () => void;
  onArchived: (soul: CensusRow, result: RemovedSoul) => void;
}) {
  const { t } = useI18n();
  const name = displayName(soul);
  const [running, setRunning] = useState<boolean | null | 'checking'>('checking');
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let active = true;
    setRunning('checking');
    archiver.running(soul.agentId).catch(() => null).then((value) => { if (active) setRunning(value); });
    return () => { active = false; };
  }, [archiver, soul.agentId]);
  useEffect(() => cancel.current?.focus(), []);
  const close = () => { if (!archiving) onCancel(); };
  const archive = () => {
    setArchiving(true);
    setError(null);
    archiver.remove(soul.agentId).then(
      (result) => onArchived(soul, result),
      (e: unknown) => {
        const message = (e as { message?: unknown })?.message;
        setError(typeof message === 'string' && message ? message : String(e));
        setArchiving(false);
      },
    );
  };
  const blocked = running === 'checking' || running === true;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <section role="alertdialog" aria-modal="true" aria-label={`${t('bar.archive')}: ${name}`}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}
        className="grid max-h-full w-full max-w-sm gap-3 overflow-y-auto rounded-lg border border-border bg-popover p-5 text-sm shadow-2xl">
        <h2 className="m-0 flex items-center gap-2 text-base font-semibold tracking-tight">
          <Archive className="size-4 text-destructive" aria-hidden /> {t('bar.archiveConfirm', { name })}
        </h2>
        <p className="m-0 font-mono text-[11px] text-muted-foreground">{t('bar.archiveId', { id: soul.agentId })}</p>
        <div>
          <p className="m-0 text-muted-foreground">{t('bar.archiveWhat')}</p>
          <ul className="m-0 mt-1 grid gap-0.5 pl-5">
            <li>{t('bar.archiveWhatWake')}</li>
            <li>{t('bar.archiveWhatComms')}</li>
            <li>{t('bar.archiveWhatRetire')}</li>
            <li>{t('bar.archiveWhatFolder')}</li>
            <li>{t('bar.archiveWhatKept')}</li>
          </ul>
        </div>
        {running === true && <p className="m-0 text-[11px] text-muted-foreground">{t('bar.archiveRunning')}</p>}
        {running === 'checking' && <p className="m-0 text-[11px] text-muted-foreground">{t('bar.archiveChecking')}</p>}
        {archiving && <p className="m-0 text-[11px] text-muted-foreground" role="status">{t('bar.archiving')}</p>}
        {error && <p className="error small m-0" role="alert">{error}</p>}
        <div className="flex justify-end gap-2">
          <button ref={cancel} type="button" onClick={close} disabled={archiving}
            className="h-9 rounded-md px-4 text-sm font-medium hover:bg-accent disabled:opacity-50">{t('cancel')}</button>
          <button type="button" onClick={archive} disabled={blocked || archiving}
            title={running === true ? t('bar.archiveRunning') : undefined}
            className="h-9 rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50">
            {t('bar.archive')}
          </button>
        </div>
      </section>
    </div>
  );
}

/** The design's toast after an archive: a short line that fades on its own. */
export function ArchivedNotice({ text, onDone }: { text: string; onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, 4000);
    return () => clearTimeout(timer);
  }, [text, onDone]);
  return (
    <p role="status" className="fixed bottom-10 left-1/2 z-50 m-0 max-w-[90%] -translate-x-1/2 rounded-md border border-border bg-popover px-3 py-2 text-xs text-foreground shadow-lg">
      {text}
    </p>
  );
}

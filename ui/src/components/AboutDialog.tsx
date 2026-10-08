import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, Copy, ExternalLink } from 'lucide-react';
import { aboutInfo, aboutRunning, openInBrowser, type AboutInfo, type AboutRunning } from '../bridge';
import { useI18n } from '../lib/i18n';
import { aboutSummary, aboutVersions, RELEASE_NOTES_URL, REPORT_PROBLEM_URL } from '../model/about';
import { errorLine, secondaryButton, textLink } from './ui';

/** Where About reads from (#290); the app's is the shell's, previews and tests pass a fake. */
export interface AboutSource {
  /** The app's version and build, the bundled engines and the OS (`about_info`); null when the shell cannot say. */
  info: () => Promise<AboutInfo | null>;
  /** What the live engines answer (`about_running`); null when the shell cannot say. */
  running: () => Promise<AboutRunning | null>;
  /** Opens a link in the owner's browser; rejects when the shell would not. */
  open: (url: string) => Promise<void>;
  /** Writes the summary to the clipboard; absent uses the browser's own. */
  copy?: (text: string) => Promise<void>;
}

export const liveAbout: AboutSource = {
  info: () => aboutInfo(),
  running: () => aboutRunning(),
  open: (url) => openInBrowser(url),
};

/**
 * Where focus goes back to once the dialog closes: the element that opened
 * it or, for a footer ⋯ menu item (gone with its menu), the ⋯ itself.
 */
export function focusReturnOf(active: Element | null): HTMLElement | null {
  if (!(active instanceof HTMLElement)) return null;
  const menu = active.closest('[role="menu"]');
  if (!menu) return active;
  return menu.parentElement?.querySelector<HTMLElement>('[aria-haspopup="menu"]') ?? active;
}

type CopyState = 'idle' | 'copied' | 'failed';

/**
 * About GeniusBar (#290, Lovable `AboutDialog`): the app's version and
 * build, prominent; the bundled and running engine versions behind a
 * collapsed disclosure; a read-only, selectable summary of only those
 * lines, with Copy, which says it copied only after the clipboard took
 * the text and otherwise selects the text for a manual copy; release
 * notes and a problem report in the owner's browser, and the App guide
 * (#287) when given, which closes About and opens the guide in its place.
 * Escape, Close or a backdrop click closes it. Opening it reads nothing
 * else and changes nothing.
 */
export function AboutDialog({ source, brokerReachable, onClose, onGuide }: {
  source: AboutSource;
  /** Whether the broker answers now, which is when agent-comms's running version is shown. */
  brokerReachable: boolean;
  onClose: () => void;
  /** Opens the App guide (#287) in About's place; absent, the link is not offered. */
  onGuide?: () => void;
}) {
  const { t } = useI18n();
  const ids = useId();
  // undefined while the shell is still answering.
  const [info, setInfo] = useState<AboutInfo | null | undefined>(undefined);
  const [running, setRunning] = useState<AboutRunning | null | undefined>(undefined);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [openError, setOpenError] = useState<string | null>(null);
  const dialog = useRef<HTMLElement>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  const pressedBackdrop = useRef(false);
  useEffect(() => {
    let active = true;
    source.info().catch(() => null).then((value) => { if (active) setInfo(value); });
    source.running().catch(() => null).then((value) => { if (active) setRunning(value); });
    return () => { active = false; };
  }, [source]);
  useEffect(() => dialog.current?.focus(), []);
  const versions = aboutVersions(info ?? null, running ?? null, brokerReachable);
  const unknown = t('about.unknown');
  const pending = running === undefined ? t('about.checking') : null;
  const summary = aboutSummary(versions, t, pending);
  const selectText = () => { text.current?.focus(); text.current?.select(); };
  const copy = async () => {
    setCopyState('idle');
    try {
      if (source.copy) await source.copy(summary);
      else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(summary);
      else throw new Error('clipboard unavailable');
      setCopyState('copied');
    } catch {
      // The selection stays for a manual copy; the older copy command is
      // tried from it, and only its own true counts as copied.
      selectText();
      let copied = false;
      try { copied = typeof document.execCommand === 'function' && document.execCommand('copy'); } catch { copied = false; }
      setCopyState(copied ? 'copied' : 'failed');
    }
  };
  const openLink = (url: string) => {
    setOpenError(null);
    source.open(url).catch((e: unknown) => setOpenError(t('about.openFailed', { message: e instanceof Error ? e.message : String(e) })));
  };
  const value = 'selectable m-0 font-mono text-muted-foreground';
  // Portalled to the body, as Customize…: a companion window's transform
  // would contain the fixed overlay.
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-3"
      onPointerDown={(e) => { e.stopPropagation(); pressedBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && pressedBackdrop.current) onClose(); }}>
      <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby={`${ids}-title`} tabIndex={-1}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
        className="grid max-h-full w-full max-w-md gap-3 overflow-y-auto rounded-lg border border-border bg-background p-5 text-sm shadow-lg outline-none">
        <h2 id={`${ids}-title`} className="m-0 flex items-center gap-3 text-base font-semibold tracking-tight">
          <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-lg bg-foreground text-xl font-bold text-background">G</span>
          {t('about.title')}
        </h2>
        <dl className="m-0 grid grid-cols-2 gap-3 border-y border-border py-3">
          <div>
            <dt className="text-xs text-muted-foreground">{t('about.version')}</dt>
            <dd className="selectable m-0 mt-1 font-mono text-2xl font-semibold break-all">{versions.app.version ?? unknown}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('about.build')}</dt>
            <dd className="selectable m-0 mt-1 font-mono text-2xl font-semibold break-all">{versions.app.build ?? unknown}</dd>
          </div>
        </dl>
        <details className="border-b border-border pb-3">
          <summary className="cursor-pointer rounded-sm text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('about.components')}</summary>
          <div className="mt-3 grid gap-3 text-xs">
            {versions.components.map((component) => (
              <section key={component.name} aria-label={component.name}>
                <h3 className="m-0 font-mono text-xs font-semibold">{component.name}</h3>
                <dl className="m-0 mt-1 grid gap-1">
                  <div className="flex flex-wrap justify-between gap-x-2"><dt>{t('about.bundled')}</dt><dd className={value}>{component.bundled ?? unknown}</dd></div>
                  <div className="flex flex-wrap justify-between gap-x-2"><dt>{t('about.running')}</dt><dd className={value}>{component.running ?? pending ?? unknown}</dd></div>
                </dl>
              </section>
            ))}
          </div>
        </details>
        <div className="grid gap-2">
          <label htmlFor={`${ids}-summary`} className="text-xs font-medium">{t('about.summary')}</label>
          <textarea ref={text} id={`${ids}-summary`} readOnly value={summary} spellCheck={false} rows={9}
            className="selectable w-full resize-none rounded-md border border-input bg-muted p-2 font-mono text-[11px] leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          <div className="flex flex-wrap gap-2">
            <button type="button" className={secondaryButton} onClick={() => { void copy(); }}>
              <Copy className="size-3.5" aria-hidden />{t('about.copy')}
            </button>
            <button type="button" className={secondaryButton} onClick={selectText}>{t('about.select')}</button>
          </div>
          <p role="status" aria-live="polite" className={`m-0 min-h-4 text-xs ${copyState === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>
            {copyState === 'idle' ? '' : t(copyState === 'copied' ? 'about.copied' : 'about.failed')}
          </p>
        </div>
        <nav aria-label={t('about.links')} className="flex flex-wrap gap-3 border-t border-border pt-3">
          <button type="button" className={textLink} onClick={() => openLink(RELEASE_NOTES_URL)}>
            <ExternalLink className="size-3" aria-hidden />{t('about.releases')}
          </button>
          <button type="button" className={textLink} onClick={() => openLink(REPORT_PROBLEM_URL)}>
            <ExternalLink className="size-3" aria-hidden />{t('about.report')}
          </button>
          {onGuide && (
            <button type="button" className={textLink} aria-haspopup="dialog" onClick={onGuide}>
              <BookOpen className="size-3" aria-hidden />{t('guide.title')}
            </button>
          )}
        </nav>
        {openError && <p className={errorLine} role="alert">{openError}</p>}
        <div className="flex justify-end">
          <button type="button" onClick={onClose} className="h-9 rounded-md border border-border px-4 text-sm font-medium hover:bg-accent">{t('close')}</button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

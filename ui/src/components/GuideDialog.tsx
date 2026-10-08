import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, ExternalLink, Search } from 'lucide-react';
import { openInBrowser } from '../bridge';
import { useI18n } from '../lib/i18n';
import { GUIDE, GUIDE_META, searchGuide, type GuideChapter, type GuideMeta, type Provenance } from '../model/guide';
import { MessageBody } from './Entries';
import { errorLine, textLink } from './ui';

/** The provenance chips (Lovable `TONE`): what the app does, and what is only designed. */
const TONE: Record<Provenance, string> = {
  observed: 'border-success/50 text-success',
  design: 'border-info/50 text-info',
};

/**
 * The App guide (#287, Lovable `GuideDialog`): the chapters Genius carries
 * in its package, searchable, with each paragraph's provenance, the
 * technical details behind a disclosure and the sources as links opened in
 * the owner's browser. The header names the guide draft and the GeniusBar
 * version it was written for. Below 640px the chapter list collapses to a
 * short scrolling strip above the chapter. Portalled to the body as About
 * is; Escape, Close or a backdrop click closes it; the caller returns
 * focus to what opened it.
 */
export function GuideDialog({ onClose, chapters = GUIDE, meta = GUIDE_META, open = openInBrowser }: {
  onClose: () => void;
  chapters?: readonly GuideChapter[];
  meta?: GuideMeta | null;
  /** Opens a source in the browser; rejects when the shell would not. */
  open?: (url: string) => Promise<void>;
}) {
  const { t, lang } = useI18n();
  const ids = useId();
  const dialog = useRef<HTMLElement>(null);
  const pressedBackdrop = useRef(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(chapters[0]?.id ?? '');
  const [openError, setOpenError] = useState<string | null>(null);
  useEffect(() => dialog.current?.focus(), []);
  const results = searchGuide(query, chapters);
  const current = results.find((c) => c.id === selected) ?? results[0];
  const openSource = (url: string) => {
    setOpenError(null);
    open(url).catch((e: unknown) => setOpenError(t('about.openFailed', { message: e instanceof Error ? e.message : String(e) })));
  };
  const count = results.length === 1 ? t('guide.resultOne') : t('guide.results', { count: results.length });
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-3"
      onPointerDown={(e) => { e.stopPropagation(); pressedBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && pressedBackdrop.current) onClose(); }}>
      <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby={`${ids}-title`} aria-describedby={`${ids}-version`} tabIndex={-1}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
        className="flex max-h-full w-full max-w-3xl flex-col gap-3 rounded-lg border border-border bg-background p-5 text-sm shadow-lg outline-none">
        <div className="grid gap-1">
          <h2 id={`${ids}-title`} className="m-0 flex items-center gap-2 text-base font-semibold tracking-tight">
            <BookOpen className="size-4" aria-hidden />{t('guide.title')}
          </h2>
          <p id={`${ids}-version`} className="m-0 text-xs text-muted-foreground">
            {meta ? t('guide.version', { draft: meta.draft, appVersion: meta.appVersion }) : t('guide.unbuilt')}
            {lang !== 'en' && <> · {t('guide.english')}</>}
          </p>
        </div>
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t('guide.search')} placeholder={t('guide.search')}
            className="h-8 w-full rounded-md bg-muted pr-2 pl-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </div>
        <p className="sr-only" aria-live="polite">{count}</p>
        <div className="grid min-h-0 flex-1 gap-3 sm:grid-cols-[190px_1fr]">
          <nav aria-label={t('guide.chapters')} className="max-h-40 overflow-y-auto rounded-md border border-border sm:max-h-none">
            {results.length === 0 && <p className="m-0 p-2 text-xs text-muted-foreground">{t('guide.none')}</p>}
            <ol className="m-0 list-none p-0">
              {results.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => setSelected(c.id)} aria-current={current?.id === c.id ? 'page' : undefined}
                    className={`w-full px-2 py-1.5 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring ${current?.id === c.id ? 'bg-accent font-medium' : ''}`}>
                    <span className="mr-1 font-mono text-muted-foreground">{chapters.indexOf(c) + 1}.</span>{c.title}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          <article className="min-h-0 overflow-y-auto rounded-md border border-border p-4" aria-labelledby={`${ids}-chapter`}>
            {current && (
              <>
                <h3 id={`${ids}-chapter`} className="m-0 mb-3 text-base font-semibold">{current.title}</h3>
                <div className="space-y-3">
                  {current.sections.map((s, i) => (
                    <div key={i} className="space-y-1">
                      <span className={`inline-block rounded-full border px-1.5 text-[10px] ${TONE[s.tag]}`}>{t(`guide.tag.${s.tag}`)}</span>
                      <MessageBody body={s.text} className="text-sm leading-relaxed" />
                    </div>
                  ))}
                </div>
                {current.technical.length > 0 && (
                  <details className="mt-4 rounded-md border border-border p-3 text-xs">
                    <summary className="cursor-pointer font-medium">{t('guide.technical')}</summary>
                    <ul className="mt-2 list-disc space-y-1 pl-4">{current.technical.map((item) => <li key={item}><MessageBody body={item} /></li>)}</ul>
                  </details>
                )}
                {current.sources.length > 0 && (
                  <nav className="mt-4 text-xs" aria-label={t('guide.sources')}>
                    <h4 className="m-0 font-medium">{t('guide.sources')}</h4>
                    <ul className="m-0 mt-1 list-none space-y-1 p-0">
                      {current.sources.map((s) => (
                        <li key={s.url}>
                          <button type="button" className={textLink} onClick={() => openSource(s.url)}>
                            <ExternalLink className="size-3" aria-hidden />{s.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </nav>
                )}
              </>
            )}
          </article>
        </div>
        {openError && <p className={errorLine} role="alert">{openError}</p>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="m-0 text-[11px] text-muted-foreground">{t('guide.updateNote')}</p>
          <button type="button" onClick={onClose} className="h-9 rounded-md border border-border px-4 text-sm font-medium hover:bg-accent">{t('close')}</button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

/**
 * The banner at the top of Genius's chat (Lovable `GeniusNotice`): this
 * companion is the guide, and the guide itself is one click away.
 */
export function GeniusNotice({ name, onOpen, meta = GUIDE_META }: { name: string; onOpen: () => void; meta?: GuideMeta | null }) {
  const { t } = useI18n();
  return (
    <div role="note" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-info/10 px-3 py-2 text-xs">
      <BookOpen className="size-4 shrink-0 text-info" aria-hidden />
      <p className="m-0 min-w-0 flex-1">{t('guide.banner', { name, draft: meta?.draft ?? '?' })}</p>
      <button type="button" className={textLink} onClick={onOpen}>{t('guide.open')}</button>
    </div>
  );
}

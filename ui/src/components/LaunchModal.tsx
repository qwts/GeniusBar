import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useI18n } from '../lib/i18n';

/**
 * The launch dialog's frame (Lovable 20.03.51): a modal titled "Launch a
 * new companion" with a close ×. Escape or a click on the backdrop closes
 * it; the form inside carries Cancel and Launch. A drag that starts in a
 * field and ends on the backdrop (selecting text) is not a backdrop click.
 * Escape works wherever focus is, even after it left the dialog (the Launch
 * button disables while a launch runs), and is ignored while `busy` (#116).
 */
export function LaunchModal({ onClose, busy = false, children }: { onClose: () => void; busy?: boolean; children: ReactNode }) {
  const { t } = useI18n();
  const box = useRef<HTMLElement>(null);
  const titleId = useId();
  const pressedBackdrop = useRef(false);
  const escape = useRef(() => {});
  escape.current = () => { if (!busy) onClose(); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') escape.current(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('input:not([readonly]), select')?.focus();
  }, []);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4"
      onPointerDown={(e) => { pressedBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && pressedBackdrop.current) onClose(); }}>
      <section ref={box} role="dialog" aria-modal="true" aria-labelledby={titleId}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); escape.current(); } }}
        className="relative grid max-h-full w-full max-w-lg gap-5 overflow-y-auto rounded-lg border border-border bg-background p-6 shadow-lg">
        <button type="button" onClick={onClose} aria-label={t('close')}
          className="absolute top-4 right-4 rounded-sm text-foreground opacity-70 hover:opacity-100">
          <X className="size-4" aria-hidden />
        </button>
        <h2 id={titleId} className="m-0 pr-8 text-lg leading-none font-semibold tracking-tight">{t('launchDialogTitle')}</h2>
        {children}
      </section>
    </div>
  );
}

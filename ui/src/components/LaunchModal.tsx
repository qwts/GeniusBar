import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useI18n } from '../lib/i18n';

/**
 * The launch dialog's frame (Lovable 20.03.51): a modal titled "Launch a
 * new companion" with a close ×. Escape or a click on the backdrop closes
 * it; the form inside carries Cancel and Launch. A drag that starts in a
 * field and ends on the backdrop (selecting text) is not a backdrop click.
 */
export function LaunchModal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const { t } = useI18n();
  const box = useRef<HTMLElement>(null);
  const pressedBackdrop = useRef(false);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('input:not([readonly]), select')?.focus();
  }, []);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onPointerDown={(e) => { pressedBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && pressedBackdrop.current) onClose(); }}>
      <section ref={box} role="dialog" aria-modal="true" aria-label={t('launchDialogTitle')}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
        className="relative grid max-h-full w-full max-w-lg gap-5 overflow-y-auto rounded-lg border border-border bg-popover p-6 shadow-2xl">
        <button type="button" onClick={onClose} aria-label={t('close')}
          className="absolute top-4 right-4 rounded p-1 text-muted-foreground hover:text-foreground">
          <X className="size-4" aria-hidden />
        </button>
        <h2 className="m-0 pr-8 text-lg font-semibold tracking-tight">{t('launchDialogTitle')}</h2>
        {children}
      </section>
    </div>
  );
}

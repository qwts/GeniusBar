// The computer-use indicator on the real screen (#122): Lovable's orange
// perimeter and its Stop pill, each as a transparent native window over the
// desktop while a soul drives the computer. The popup opens and closes them
// (usePerimeter); the border is click-through, the pill takes the click.
import { useEffect, useMemo } from 'react';
import { OctagonX } from 'lucide-react';
import { useHoldEscape, useStop, type Stopper } from '../components/FloatingDudle';
import { useI18n } from '../lib/i18n';
import { computerUserName } from '../model/floating';
import type { SurfaceData } from './common';

/** A transparent page: the window shows the desktop through it. */
function useTransparentPage() {
  useEffect(() => {
    document.documentElement.classList.add('gb-transparent');
    return () => document.documentElement.classList.remove('gb-transparent');
  }, []);
}

/** The border: the whole window is the perimeter. */
export function PerimeterSurface({ isStatic = false }: { isStatic?: boolean }) {
  useTransparentPage();
  return (
    <div className="gb h-full">
      <div className={`perimeter fixed inset-0 ${isStatic ? 'motion-safe:[animation:none]' : ''}`} aria-hidden />
    </div>
  );
}

/**
 * The pill: who drives the screen, with Stop (and holding Escape while the
 * pill has focus) halting every soul the daemon reports driving it.
 */
export function HaltSurface({ census, badges, stopper }: Pick<SurfaceData, 'census' | 'badges'> & { stopper?: Stopper }) {
  useTransparentPage();
  const { t } = useI18n();
  const computerUse = badges?.computerUse;
  const roster = useMemo(() => census.filter((s) => s.presence !== 'left'), [census]);
  const name = computerUserName(roster, computerUse);
  const stop = useStop(stopper, computerUse);
  useHoldEscape(name !== null && stop.offered, stop.halt);
  if (name === null) return <div className="gb h-full" />;
  return (
    <div className="gb flex h-full flex-col items-center gap-1 pt-1">
      <div role={stop.offered ? 'alert' : 'status'} data-tauri-drag-region=""
        className="flex max-w-full items-center gap-3 rounded-full bg-warning px-4 py-1.5 text-xs font-semibold text-warning-foreground shadow-lg">
        <span data-tauri-drag-region="" className="truncate">{stop.offered ? t('computerActiveStop', { name }) : t('computerActive', { name })}</span>
        {stop.offered && (
          <button type="button" onClick={() => { void stop.halt(); }} disabled={stop.phase.phase === 'stopping'}
            className="flex min-h-7 shrink-0 items-center gap-1 rounded-full bg-warning-foreground px-3 py-0.5 text-warning outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70">
            <OctagonX className="size-3.5" aria-hidden /> {stop.phase.phase === 'stopping' ? t('stopping') : t('stop')}
          </button>
        )}
      </div>
      {stop.offered && stop.phase.phase === 'failed' && (
        <p className="m-0 rounded-md bg-card px-3 py-1 text-xs text-destructive shadow-lg">{t('stopFailed', { message: stop.phase.message })}</p>
      )}
    </div>
  );
}

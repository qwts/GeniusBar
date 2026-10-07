import { CustomizeDialog } from '../components/CustomizeDialog';
import { liveState } from '../components/FleetList';
import { useI18n } from '../lib/i18n';
import { displayName, findSoul } from '../model/census';
import { closeWindow, useSurfaceFleet, useWindowTitle, type SurfaceData } from './common';

/**
 * Customize… as its own native window (#223): the dialog's content is the
 * page. Cancel, ×, Escape or a finished save's Close close the window.
 */
export function CustomizeSurface({ soul: key, census, loaded, chat, badges, win }: SurfaceData & { soul: string | null }) {
  const { t } = useI18n();
  const { forest, awaiting, busy } = useSurfaceFleet({ census, chat, badges });
  const soul = key ? findSoul(forest, key) : null;
  useWindowTitle(soul ? t('surface.title', { name: `${t('edit.title')} ${displayName(soul)}` }) : null, win);
  const state = soul ? liveState(soul, awaiting, busy) : undefined;
  return (
    <main className="gb flex min-h-full flex-col bg-background">
      {/* The title bar's strip, above the page, drags the window. */}
      <div data-tauri-drag-region="" className="fixed inset-x-0 top-0 z-10 h-8" />
      {soul ? (
        <CustomizeDialog page soul={soul} state={state === 'awaiting' || state === 'working' ? state : undefined} onClose={() => closeWindow(win)} />
      ) : (
        loaded && <p className="m-0 p-6 pt-10 text-sm text-muted-foreground">{t('surface.gone')}</p>
      )}
    </main>
  );
}

import { AuditWindow } from '../components/Desktop';
import { useI18n } from '../lib/i18n';
import { displayName, findSoul } from '../model/census';
import { closeWindow, useSurfaceFleet, useWindowTitle, type SurfaceData } from './common';

/**
 * The audit log as its own native window (#223), Lovable's /audit page:
 * every companion's records, or one companion's when the window names a
 * soul. Escape closes it.
 */
export function AuditSurface({ soul: key, census, chat, badges, win }: SurfaceData & { soul: string | null }) {
  const { t } = useI18n();
  const { forest, roster } = useSurfaceFleet({ census, chat, badges });
  const found = key ? findSoul(forest, key) : null;
  // A soul the census does not list (yet) still has records under its agent ID.
  const soul = found ?? (key ? { agentId: key.slice(key.lastIndexOf('/') + 1), name: null } : null);
  useWindowTitle(t('surface.title', { name: soul ? `${t('auditTitle')} · ${displayName(soul)}` : t('auditTitle') }), win);
  return (
    <main className="gb h-full">
      <AuditWindow native roster={roster} soul={soul} onClose={() => closeWindow(win)} />
    </main>
  );
}

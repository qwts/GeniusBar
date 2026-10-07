import { useMemo } from 'react';
import { LaunchForm } from '../components/LaunchForm';
import { LaunchModal } from '../components/LaunchModal';
import { useI18n } from '../lib/i18n';
import { findSoul, soulKey } from '../model/census';
import { canLaunch } from '../model/launch';
import { usePreferences } from '../state/preferences';
import type { LaunchApi } from '../useLaunch';
import type { TemplateLister } from '../useSoulTemplates';
import { closeWindow, useSurfaceFleet, useWindowTitle, type SurfaceData } from './common';
import type { OpenSurface } from './opener';

/**
 * The launch dialog as its own native window (#223): soul templates, then
 * a custom soul. Cancel, × or Escape close it; a launch closes it and opens
 * the new companion's session window (#116).
 */
export function LaunchSurface({ census, chat, badges, win, launcher, listTemplates, open }: SurfaceData & {
  launcher: LaunchApi;
  listTemplates?: TemplateLister;
  open: OpenSurface | null;
}) {
  const { t } = useI18n();
  const { forest, roster } = useSurfaceFleet({ census, chat, badges });
  const { defaultHarness } = usePreferences();
  const accounts = useMemo(() => [...new Set(roster.map((s) => s.account))].sort(), [roster]);
  const harnesses = useMemo(() => [...new Set(roster.flatMap((s) => (s.harness ? [s.harness] : [])))].sort(), [roster]);
  useWindowTitle(t('surface.title', { name: t('launchDialogTitle') }), win);
  const close = () => closeWindow(win);
  const launched = (agentId: string | null) => {
    launcher.reset();
    // The census may not list it yet: its agent ID names it until it does.
    const soul = agentId ? findSoul(forest, agentId) : null;
    if (agentId) open?.({ surface: 'session', soul: soul ? soulKey(soul) : agentId }).catch(() => {});
    close();
  };
  return (
    <main className="gb flex min-h-full flex-col bg-background">
      <div data-tauri-drag-region="" className="fixed inset-x-0 top-0 z-10 h-8" />
      <LaunchModal page onClose={close} busy={!canLaunch(launcher.state)}>
        <LaunchForm launcher={launcher} accounts={accounts} harnesses={harnesses} defaultHarness={defaultHarness} roster={roster}
          onCancel={close} onLaunched={launched} listTemplates={listTemplates} />
      </LaunchModal>
    </main>
  );
}

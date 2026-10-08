import { useEffect, useMemo, useRef, useState } from 'react';
import { LaunchForm } from '../components/LaunchForm';
import { LaunchModal } from '../components/LaunchModal';
import { useI18n } from '../lib/i18n';
import { findSoul, soulKey } from '../model/census';
import { canLaunch } from '../model/launch';
import type { OpenedPackage, PackageChecker } from '../soulPackage';
import { usePreferences } from '../state/preferences';
import type { LaunchApi } from '../useLaunch';
import type { TemplateLister } from '../useSoulTemplates';
import { closeWindow, useSurfaceFleet, useWindowTitle, type SurfaceData } from './common';
import type { OpenSurface } from './opener';

/**
 * The launch dialog as its own native window (#223): soul templates, then
 * a custom soul. Cancel, × or Escape close it; a launch closes it and opens
 * the new companion's session window (#116). Opened with a `.soul` package
 * (dropped on the popup or a window, #98), it checks the package and fills
 * the form as a Finder-opened one does in the popup.
 */
export function LaunchSurface({ census, chat, badges, win, launcher, listTemplates, open, packagePath = null, checkPackage }: SurfaceData & {
  launcher: LaunchApi;
  listTemplates?: TemplateLister;
  open: OpenSurface | null;
  /** The query's package path; null for a plain launch. */
  packagePath?: string | null;
  /** The shell's and agent-bot's check of the package; without it the path is taken as is. */
  checkPackage?: PackageChecker;
}) {
  const { t } = useI18n();
  const { forest, roster } = useSurfaceFleet({ census, chat, badges });
  const { defaultHarness } = usePreferences();
  const accounts = useMemo(() => [...new Set(roster.map((s) => s.account))].sort(), [roster]);
  const harnesses = useMemo(() => [...new Set(roster.flatMap((s) => (s.harness ? [s.harness] : [])))].sort(), [roster]);
  useWindowTitle(t('surface.title', { name: t('launchDialogTitle') }), win);
  const opened = useOpenedPackage(packagePath, checkPackage);
  const close = () => closeWindow(win);
  const launched = (agentId: string | null) => {
    launcher.reset();
    // The census may not list it yet: its agent ID names it until it does.
    const soul = agentId ? findSoul(forest, agentId) : null;
    if (agentId) open?.({ surface: 'session', soul: soul ? soulKey(soul) : agentId }).catch(() => {});
    close();
  };
  // An installed soul's own folder is that companion, never a new launch
  // (#80): its session opens instead. One not in the roster yet keeps the form.
  const installed = opened?.agentId ? findSoul(forest, opened.agentId) : null;
  const installedKey = installed ? soulKey(installed) : null;
  useEffect(() => {
    if (!installedKey) return;
    open?.({ surface: 'session', soul: installedKey }).catch(() => {});
    closeWindow(win);
  }, [installedKey, open, win]);
  return (
    <main className="gb flex h-full flex-col overflow-y-auto overscroll-contain bg-background">
      {/* The title bar's strip drags the window; the form scrolls under it, never the document (#260). */}
      <div data-tauri-drag-region="" className="fixed inset-x-0 top-0 z-10 h-8" />
      <LaunchModal page onClose={close} busy={!canLaunch(launcher.state)}>
        <LaunchForm key={opened?.id ?? 'manual'} launcher={launcher} accounts={accounts} harnesses={harnesses} defaultHarness={defaultHarness} roster={roster}
          initialPackagePath={opened?.path}
          packageName={opened?.name}
          preferredHarnesses={opened?.preferredHarnesses}
          packageDescription={opened?.description}
          copyOf={opened?.copyOf}
          checkingPackage={opened?.checking}
          packageError={opened?.error}
          onCancel={close} onLaunched={launched} listTemplates={listTemplates} />
      </LaunchModal>
    </main>
  );
}

/** The query's package, checking until its check answers; undefined without one. */
function useOpenedPackage(path: string | null, check?: PackageChecker): OpenedPackage | undefined {
  const [opened, setOpened] = useState<OpenedPackage>();
  const sequence = useRef(0);
  useEffect(() => {
    if (!path) { setOpened(undefined); return; }
    const id = ++sequence.current;
    if (!check) { setOpened({ id, path, checking: false, error: null }); return; }
    setOpened({ id, path, checking: true, error: null });
    let active = true;
    check(path).then(
      (checked) => { if (active) setOpened({ id, path, ...checked, checking: false }); },
      () => { if (active) setOpened({ id, path, checking: false, error: 'GeniusBar couldn’t read this companion package. Check that it’s accessible and contains a soul.json file, then try again.' }); },
    );
    return () => { active = false; };
  }, [path, check]);
  return opened;
}

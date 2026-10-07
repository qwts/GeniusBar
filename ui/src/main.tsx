import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App, type AppMode } from './App';
import type { CliToolsApi } from './components/CliTools';
import type { DevTools, HarnessAuth, Starter } from './components/FirstLaunch';
import { currentWindow, inApp, openDesktop, openSurface } from './bridge';
import { DropCue } from './components/DropCue';
import { menuApprovals } from './model/approvals';
import { parseSurface } from './model/surface';
import { checkSoulPackage, routeDroppedPackage, useSoulDrop, type OpenedPackage } from './soulPackage';
import { LiveSurface } from './surfaces/LiveSurface';
import { useCensus } from './useCensus';
import { useChat } from './useChat';
import { useLaunch } from './useLaunch';
import { useSetup } from './useSetup';
import { useSnapshot, type SnapshotOptions } from './useSnapshot';
import { useUpdates } from './useUpdates';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-600.css';
import './styles.css';

// The live app: census and connection come from the bridge. A snapshot
// renders the same popup statically and changes nothing: no inbox polling
// or acks, and no Finder-opened packages taken from the queue.
function Live({ snapshot }: { snapshot: SnapshotOptions | null }) {
  const { census, connection, refresh, settled } = useCensus();
  const select = useSnapshot(snapshot, census, connection, refresh);
  const { setup, existing, runSetup } = useSetup(() => { void refresh?.(); });
  const chat = useChat({ enabled: inApp() && !snapshot, roster: census });
  // The tray's G shows how many proposals wait on the owner (#85).
  const waiting = useMemo(() => menuApprovals(chat.approvals?.records ?? [], chat.approvals?.local).length, [chat.approvals]);
  useEffect(() => {
    if (snapshot || !inApp()) return;
    invoke('set_tray_badge', { count: waiting }).catch(() => {});
  }, [waiting, snapshot]);
  const launcher = useLaunch();
  const updates = useUpdates();
  const [openedPackage, setOpenedPackage] = useState<OpenedPackage>();
  const packageSequence = useRef(0);
  // A package from Finder or dropped here (#98): checked, then the form shows it.
  const showPackage = useCallback(async (path: string) => {
    const id = ++packageSequence.current;
    setOpenedPackage({ id, path, checking: true, error: null });
    const checked = await checkSoulPackage(path);
    setOpenedPackage((current) => current?.id === id ? { ...current, checking: false, ...checked } : current);
  }, []);
  const loadOpenedPackages = useCallback(async () => {
    const paths = await invoke<string[]>('take_opened_soul_packages');
    for (const path of paths) await showPackage(path);
  }, [showPackage]);
  useEffect(() => {
    if (snapshot) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen('soul-package-opened', () => { void loadOpenedPackages(); }).then((stop) => {
      if (!active) stop();
      else {
        unlisten = stop;
        void loadOpenedPackages();
      }
    });
    return () => { active = false; unlisten?.(); };
  }, [loadOpenedPackages, snapshot]);
  // Without the starter soul the empty roster just says so.
  const [starter, setStarter] = useState<Starter>();
  const harnessAuth: HarnessAuth = (action, harness, soul) => invoke('harness_auth', { action, harness, soul });
  const loadStarter = () => { invoke<Starter>('starter_soul').then(setStarter, () => {}); };
  const devTools: DevTools = { install: () => invoke('install_dev_tools'), recheck: loadStarter };
  useEffect(loadStarter, []);
  const cliTools: CliToolsApi = {
    status: () => invoke('cli_tools', { action: 'status' }),
    install: (replace) => invoke('cli_tools', { action: 'install', replace }),
    uninstall: () => invoke('cli_tools', { action: 'uninstall' }),
  };
  // The shell answers per window (#69): the desktop window and --window draw
  // the desktop; the popup is the default.
  const [mode, setMode] = useState<AppMode>('tray');
  useEffect(() => { invoke<AppMode>('app_mode').then(setMode, () => {}); }, []);
  // A `.soul` dropped on the popup (#98): the tray popup opens the launch
  // window with it; --window, a snapshot, or a shell without windows shows
  // it here, as Finder's "Open with GeniusBar" does.
  const nativeLaunch = mode === 'tray' && inApp() && !snapshot;
  const dropPackage = useCallback((path: string) => {
    void routeDroppedPackage(path, {
      open: nativeLaunch ? openSurface : null,
      show: (dropped) => { void showPackage(dropped); },
      opened: () => { currentWindow()?.hide().catch(() => {}); },
    });
  }, [nativeLaunch, showPackage]);
  const dropping = useSoulDrop(dropPackage);
  return (
    <>
    <App mode={mode} census={census} connection={connection} rosterSettled={settled} onRefresh={refresh} setup={setup} isStatic={Boolean(snapshot)} select={select}
      onSetup={(migrate) => { void runSetup(migrate); }} existingServices={existing} cliTools={cliTools} chat={snapshot ? undefined : chat} launcher={launcher} starter={starter} harnessAuth={harnessAuth}
      devTools={devTools} openedPackage={openedPackage} updates={updates}
      onOpenDesktop={inApp() && !snapshot ? () => { void openDesktop().catch(() => {}); } : undefined}
      onRemoveServices={async () => { await invoke('remove_services'); void refresh?.(); }} />
    {dropping && <div className="gb"><DropCue fill /></div>}
    </>
  );
}

// The shell says before the first render whether this is a snapshot.
const snapshot = inApp() ? await invoke<SnapshotOptions | null>('snapshot_options').catch(() => null) : null;
// Which window this is (#223): the popup and the --window desktop are
// today's Live; a team card, a session, the audit log, Customize and
// Launch are native windows of their own.
const query = parseSurface(location.search);
const native = query.surface !== null && query.surface !== 'tray' && query.surface !== 'window';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {native ? <LiveSurface query={query} snapshot={Boolean(snapshot)} /> : <Live snapshot={snapshot} />}
  </StrictMode>,
);

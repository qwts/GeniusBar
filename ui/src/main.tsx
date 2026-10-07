import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App, type AppMode } from './App';
import type { CliToolsApi } from './components/CliTools';
import type { DevTools, HarnessAuth, Starter } from './components/FirstLaunch';
import { inApp, openDesktop } from './bridge';
import { menuApprovals } from './model/approvals';
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
  const { census, connection, refresh } = useCensus();
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
  const [openedPackage, setOpenedPackage] = useState<{ id: number; path: string; checking: boolean; error: string | null; agentId?: string; name?: string;
    preferredHarnesses?: string[]; description?: string; copyOf?: { name: string | null; agentId: string } }>();
  const packageSequence = useRef(0);
  const loadOpenedPackages = useCallback(async () => {
    const paths = await invoke<string[]>('take_opened_soul_packages');
    for (const path of paths) {
      const id = ++packageSequence.current;
      setOpenedPackage({ id, path, checking: true, error: null });
      try {
        await invoke('validate_soul_package', { package: path });
        // agent-bot says whether this folder is an installed soul, a copy of
        // one, or one that must not be launched (#80). A copy launches under
        // a new name, which agent-bot's daemon forks into a new soul (#110);
        // an older daemon still refuses it, and LaunchStatus shows why.
        // An older bundle without `soul locate` keeps the package flow.
        const located = await invoke<{ status: string; agentId?: string; message?: string; name?: string; description?: string; preferredHarnesses?: string[] }>('locate_soul_package', { package: path })
          .catch(() => null);
        const refused = located && !['package', 'installed', 'copy'].includes(located.status);
        const copyOf = located?.status === 'copy' && typeof located.agentId === 'string'
          ? { agentId: located.agentId, name: typeof located.name === 'string' ? located.name : null } : null;
        setOpenedPackage((current) => current?.id === id ? {
          ...current,
          checking: false,
          ...(located?.status === 'installed' && located.agentId ? { agentId: located.agentId } : {}),
          // A package says what it is (agent-bot 0.10.14+): the form prefills from it (#120).
          ...(located?.status === 'package' && typeof located.name === 'string' ? { name: located.name } : {}),
          ...(located?.status === 'package' && typeof located.description === 'string' ? { description: located.description } : {}),
          ...(located?.status === 'package' && Array.isArray(located.preferredHarnesses) ? { preferredHarnesses: located.preferredHarnesses.filter((h) => typeof h === 'string') } : {}),
          ...(copyOf ? { copyOf } : {}),
          ...(refused ? { error: located.message ?? 'This folder can’t be launched as a companion.' } : {}),
        } : current);
      } catch {
        setOpenedPackage((current) => current?.id === id ? {
          ...current,
          checking: false,
          error: 'GeniusBar couldn’t read this companion package. Check that it’s accessible and contains a soul.json file, then try again.',
        } : current);
      }
    }
  }, []);
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
  return (
    <App mode={mode} census={census} connection={connection} onRefresh={refresh} setup={setup} isStatic={Boolean(snapshot)} select={select}
      onSetup={(migrate) => { void runSetup(migrate); }} existingServices={existing} cliTools={cliTools} chat={snapshot ? undefined : chat} launcher={launcher} starter={starter} harnessAuth={harnessAuth}
      devTools={devTools} openedPackage={openedPackage} updates={updates}
      onOpenDesktop={inApp() && !snapshot ? () => { void openDesktop().catch(() => {}); } : undefined}
      onRemoveServices={async () => { await invoke('remove_services'); void refresh?.(); }} />
  );
}

// The shell says before the first render whether this is a snapshot.
const snapshot = inApp() ? await invoke<SnapshotOptions | null>('snapshot_options').catch(() => null) : null;
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Live snapshot={snapshot} />
  </StrictMode>,
);

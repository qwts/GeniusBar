import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App, type AppMode } from './App';
import type { CliToolsApi } from './components/CliTools';
import type { DevTools, HarnessAuth, Starter } from './components/FirstLaunch';
import { useCensus } from './useCensus';
import { useChat } from './useChat';
import { useLaunch } from './useLaunch';
import { useSetup } from './useSetup';
import { useUpdates } from './useUpdates';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import './styles.css';

// The live app: census and connection come from the bridge.
function Live() {
  const { census, connection, refresh } = useCensus();
  const { setup, existing, runSetup } = useSetup(() => { void refresh?.(); });
  const chat = useChat();
  const launcher = useLaunch();
  const updates = useUpdates();
  const [openedPackage, setOpenedPackage] = useState<{ id: number; path: string; checking: boolean; error: string | null }>();
  const packageSequence = useRef(0);
  const loadOpenedPackages = useCallback(async () => {
    const paths = await invoke<string[]>('take_opened_soul_packages');
    for (const path of paths) {
      const id = ++packageSequence.current;
      setOpenedPackage({ id, path, checking: true, error: null });
      try {
        await invoke('validate_soul_package', { package: path });
        setOpenedPackage((current) => current?.id === id ? { ...current, checking: false } : current);
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
  }, [loadOpenedPackages]);
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
  // The shell's --window flag picks the desktop; the popup is the default.
  const [mode, setMode] = useState<AppMode>('tray');
  useEffect(() => { invoke<AppMode>('app_mode').then(setMode, () => {}); }, []);
  return (
    <App mode={mode} census={census} connection={connection} onRefresh={refresh} setup={setup}
      onSetup={(migrate) => { void runSetup(migrate); }} existingServices={existing} cliTools={cliTools} chat={chat} launcher={launcher} starter={starter} harnessAuth={harnessAuth}
      devTools={devTools} openedPackage={openedPackage} updates={updates}
      onRemoveServices={async () => { await invoke('remove_services'); void refresh?.(); }} />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Live />
  </StrictMode>,
);

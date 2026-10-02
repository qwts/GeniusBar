import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import type { DevTools, HarnessAuth, Starter } from './components/FirstLaunch';
import { useCensus } from './useCensus';
import { useChat } from './useChat';
import { useLaunch } from './useLaunch';
import { useSetup } from './useSetup';
import './styles.css';

// The live app: census and connection come from the bridge.
function Live() {
  const { census, connection, refresh } = useCensus();
  const { setup, runSetup } = useSetup(() => { void refresh?.(); });
  const chat = useChat();
  const launcher = useLaunch();
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
          error: 'GeniusBar couldn’t read this soul package. Check that it’s accessible and contains a soul.json file, then try again.',
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
  return (
    <App census={census} connection={connection} onRefresh={refresh} setup={setup}
      onSetup={() => { void runSetup(); }} chat={chat} launcher={launcher} starter={starter} harnessAuth={harnessAuth}
      devTools={devTools} openedPackage={openedPackage}
      onRemoveServices={async () => { await invoke('remove_services'); void refresh?.(); }} />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Live />
  </StrictMode>,
);

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import type { DevTools, HarnessAuth, Starter } from './components/FirstLaunch';
import { inApp } from './bridge';
import { useCensus } from './useCensus';
import { useChat } from './useChat';
import { useLaunch } from './useLaunch';
import { useSetup } from './useSetup';
import { useSnapshot, type SnapshotOptions } from './useSnapshot';
import { useUpdates } from './useUpdates';
import './styles.css';

// The live app: census and connection come from the bridge. A snapshot
// renders the same popup statically and changes nothing: no inbox polling
// or acks, and no Finder-opened packages taken from the queue.
function Live({ snapshot }: { snapshot: SnapshotOptions | null }) {
  const { census, connection, refresh } = useCensus();
  const select = useSnapshot(snapshot, census, connection, refresh);
  const { setup, runSetup } = useSetup(() => { void refresh?.(); });
  const chat = useChat({ enabled: inApp() && !snapshot });
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
          error: 'GeniusBar couldn’t read this soul package. Check that it’s accessible and contains a soul.json file, then try again.',
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
  return (
    <App census={census} connection={connection} onRefresh={refresh} setup={setup} isStatic={Boolean(snapshot)} select={select}
      onSetup={() => { void runSetup(); }} chat={snapshot ? undefined : chat} launcher={launcher} starter={starter} harnessAuth={harnessAuth}
      devTools={devTools} openedPackage={openedPackage} updates={updates}
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

import { invoke } from '@tauri-apps/api/core';
import { StrictMode, useEffect, useState } from 'react';
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
  // Without the starter soul the empty roster just says so.
  const [starter, setStarter] = useState<Starter>();
  const harnessAuth: HarnessAuth = (action, harness, soul) => invoke('harness_auth', { action, harness, soul });
  const loadStarter = () => { invoke<Starter>('starter_soul').then(setStarter, () => {}); };
  const devTools: DevTools = { install: () => invoke('install_dev_tools'), recheck: loadStarter };
  useEffect(loadStarter, []);
  return (
    <App census={census} connection={connection} onRefresh={refresh} setup={setup}
      onSetup={() => { void runSetup(); }} chat={chat} launcher={launcher} starter={starter} harnessAuth={harnessAuth}
      devTools={devTools}
      onRemoveServices={async () => { await invoke('remove_services'); void refresh?.(); }} />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Live />
  </StrictMode>,
);

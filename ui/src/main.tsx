import { invoke } from '@tauri-apps/api/core';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import type { Starter } from './components/FirstLaunch';
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
  useEffect(() => { invoke<Starter>('starter_soul').then(setStarter, () => {}); }, []);
  return (
    <App census={census} connection={connection} onRefresh={refresh} setup={setup}
      onSetup={() => { void runSetup(); }} chat={chat} launcher={launcher} starter={starter}
      onRemoveServices={async () => { await invoke('remove_services'); void refresh?.(); }} />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Live />
  </StrictMode>,
);

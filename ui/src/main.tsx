import { invoke } from '@tauri-apps/api/core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { inApp } from './bridge';
import { SnapshotApp } from './SnapshotApp';
import { deliverSnapshot, snapshotOptions, type SnapshotOptions } from './snapshot';
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
  return (
    <App census={census} connection={connection} onRefresh={refresh} setup={setup}
      onSetup={() => { void runSetup(); }} chat={chat} launcher={launcher}
      onRemoveServices={async () => { await invoke('remove_services'); void refresh?.(); }} />
  );
}

async function start() {
  const root = document.getElementById('root')!;
  const snapshot: SnapshotOptions | null = inApp() ? await snapshotOptions() : null;
  if (snapshot) document.documentElement.classList.add('snapshot');
  const deliver = (souls: number, error: string | null) => { void deliverSnapshot(root, souls, error); };
  createRoot(root).render(
    <StrictMode>
      {snapshot ? <SnapshotApp options={snapshot} deliver={deliver} /> : <Live />}
    </StrictMode>,
  );
}

void start();

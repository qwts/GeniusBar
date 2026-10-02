// Runs first-run setup in the shell and tracks its progress events.
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useCallback, useState } from 'react';
import { applyProgress, idleSetup, type SetupState } from './model/setup';

export function useSetup(onDone: () => void) {
  const [setup, setSetup] = useState<SetupState>(idleSetup);
  const run = useCallback(async () => {
    setSetup({ ...idleSetup, running: true });
    const unlisten = await listen<{ step?: unknown; state?: unknown }>('setup-progress',
      (event) => setSetup((s) => applyProgress(s, event.payload)));
    try {
      await invoke('setup');
      setSetup((s) => ({ ...s, running: false }));
      onDone();
    } catch (error) {
      const e = error as { message?: unknown };
      setSetup((s) => ({ ...s, running: false, error: typeof e?.message === 'string' && e.message ? e.message : 'Setup failed.' }));
    } finally {
      unlisten();
    }
  }, [onDone]);
  return { setup, runSetup: run };
}

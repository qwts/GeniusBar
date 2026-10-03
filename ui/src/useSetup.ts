// Runs first-run setup in the shell and tracks its progress events.
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useState } from 'react';
import { applyProgress, idleSetup, type ExistingServices, type SetupState } from './model/setup';

export function useSetup(onDone: () => void) {
  const [setup, setSetup] = useState<SetupState>(idleSetup);
  // Another install's broker and daemon (Homebrew's), which setup offers to move over (#41).
  const [existing, setExisting] = useState<ExistingServices | null>(null);
  const inspect = useCallback(async () => {
    try { setExisting(await invoke<ExistingServices>('inspect_services')); } catch { setExisting(null); }
  }, []);
  useEffect(() => { void inspect(); }, [inspect]);
  const run = useCallback(async (migrate = false) => {
    setSetup({ ...idleSetup, running: true });
    const unlisten = await listen<{ step?: unknown; state?: unknown }>('setup-progress',
      (event) => setSetup((s) => applyProgress(s, event.payload)));
    try {
      if (migrate) await invoke('migrate_services');
      await invoke('setup');
      setSetup((s) => ({ ...s, running: false }));
      onDone();
    } catch (error) {
      const e = error as { message?: unknown };
      setSetup((s) => ({ ...s, running: false, error: typeof e?.message === 'string' && e.message ? e.message : 'Setup failed.' }));
    } finally {
      unlisten();
      if (migrate) void inspect();
    }
  }, [onDone, inspect]);
  return { setup, existing, runSetup: run };
}

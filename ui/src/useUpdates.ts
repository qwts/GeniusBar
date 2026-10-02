// Tracks the shell's update status (#34): read once on mount, then kept
// current by the `update-status` events the shell emits on every change.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useState } from 'react';
import { inApp } from './bridge';
import { idleUpdate, type UpdateStatus } from './model/updates';

export interface UpdateApi {
  status: UpdateStatus;
  act: () => void;
}

export function useUpdates(enabled: boolean = inApp()): UpdateApi {
  const [status, setStatus] = useState<UpdateStatus>(idleUpdate);
  useEffect(() => {
    if (!enabled) return;
    // Registration resolves later; an unmount before then (StrictMode's
    // effect replay) must still remove the listener once it arrives.
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void invoke<UpdateStatus>('update_status').then(setStatus, () => {});
    void listen<UpdateStatus>('update-status', (event) => setStatus(event.payload))
      .then((stop) => { if (disposed) stop(); else unlisten = stop; }, () => {});
    return () => { disposed = true; unlisten?.(); };
  }, [enabled]);
  const act = useCallback(() => { void invoke('update_action'); }, []);
  return { status: enabled ? status : idleUpdate, act };
}

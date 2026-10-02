// Update status as the shell reports it (#34): the same states the tray
// item shows, pushed as `update-status` events and read via `update_status`.

export type UpdateState =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'installing'
  | 'ready-to-restart'
  | 'failed';

export interface UpdateStatus {
  state: UpdateState;
  version: string | null;
}

export const idleUpdate: UpdateStatus = { state: 'idle', version: null };

export interface UpdateNotice {
  text: string;
  action: string | null;
  isError: boolean;
}

/** The popup's update line: only the states a person should see or act on. */
export function updateNotice(s: UpdateStatus): UpdateNotice | null {
  switch (s.state) {
    case 'available':
      return { text: `GeniusBar ${s.version} is available.`, action: 'Install and restart', isError: false };
    case 'installing':
      return { text: `Installing GeniusBar ${s.version}…`, action: null, isError: false };
    case 'ready-to-restart':
      return { text: `GeniusBar ${s.version} is installed.`, action: 'Restart to finish', isError: false };
    case 'failed':
      return { text: 'Update failed.', action: 'Try again', isError: true };
    default:
      return null;
  }
}

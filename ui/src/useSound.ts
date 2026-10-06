import { useCallback, useEffect, useRef, useState } from 'react';
import { chime } from './lib/chime';

// The design's Sound cues toggle (#122): off by default, remembered as
// "1"/"0" under the Lovable key.
export const SOUND_KEY = 'gb.sound';

function readSound(): boolean {
  try { return localStorage.getItem(SOUND_KEY) === '1'; } catch { return false; }
}

export function useSound(): { sound: boolean; setSound: (on: boolean) => void } {
  const [sound, setState] = useState(readSound);
  const setSound = useCallback((on: boolean) => {
    setState(on);
    try { localStorage.setItem(SOUND_KEY, on ? '1' : '0'); } catch { /* not remembered */ }
  }, []);
  return { sound, setSound };
}

export interface ChimeSignals {
  sound: boolean;
  /** Approvals waiting on the user (App's `waiting`, from menuApprovals). */
  waiting: number;
  /** Souls with a turn in flight (`badges.busy`); empty when the bundle cannot say. */
  busy: ReadonlySet<string>;
}

/**
 * "ask" when the waiting approvals rise, "done" when a soul leaves the busy
 * set. Never on the first render, while muted, or while the page is hidden;
 * at most one chime per change ("ask" wins when both happen at once).
 */
export function useChimes({ sound, waiting, busy }: ChimeSignals, play: (kind: 'ask' | 'done') => void = chime): void {
  const last = useRef<{ waiting: number; busy: ReadonlySet<string> } | null>(null);
  useEffect(() => {
    const prev = last.current;
    last.current = { waiting, busy };
    if (!prev || !sound) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    if (waiting > prev.waiting) play('ask');
    else if ([...prev.busy].some((id) => !busy.has(id))) play('done');
  }, [sound, waiting, busy, play]);
}

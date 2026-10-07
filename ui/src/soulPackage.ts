// A `.soul` package handed to GeniusBar: opened from Finder ("Open with
// GeniusBar") or dropped onto the popup or a native window (#98). Both go
// through the same check before the launch form shows it.
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useEffect, useRef, useState } from 'react';
import { inApp } from './bridge';

/** What the shell and agent-bot say about a package, for the launch form. */
export interface PackageCheck {
  /** Why it cannot be launched; null when it can. */
  error: string | null;
  /** The installed soul this folder is (#80): that companion opens instead of a new launch. */
  agentId?: string;
  /** What the package's soul.json says, for prefilling the form (#120). */
  name?: string;
  preferredHarnesses?: string[];
  description?: string;
  /** A copy of this companion's folder (#110): launched under a new name, it forks. */
  copyOf?: { name: string | null; agentId: string };
}

/** A package being shown in the launch form: checking until its check answers. */
export type OpenedPackage = { id: number; path: string; checking: boolean } & PackageCheck;

export type PackageChecker = (path: string) => Promise<PackageCheck>;

/**
 * The shell validates the folder (`validate_soul_package`), then agent-bot
 * says whether it is an installed soul, a copy of one, or one that must not
 * be launched (#80). A copy launches under a new name, which agent-bot's
 * daemon forks into a new soul (#110); an older daemon still refuses it, and
 * LaunchStatus shows why. An older bundle without `soul locate` keeps the
 * package flow. Never rejects: a failure is the check's `error`.
 */
export async function checkSoulPackage(path: string, invokeImpl: typeof invoke = invoke): Promise<PackageCheck> {
  try {
    await invokeImpl('validate_soul_package', { package: path });
  } catch {
    return { error: 'GeniusBar couldn’t read this companion package. Check that it’s accessible and contains a soul.json file, then try again.' };
  }
  const located = await invokeImpl<{ status: string; agentId?: string; message?: string; name?: string; description?: string; preferredHarnesses?: string[] }>('locate_soul_package', { package: path })
    .catch(() => null);
  const refused = located && !['package', 'installed', 'copy'].includes(located.status);
  const copyOf = located?.status === 'copy' && typeof located.agentId === 'string'
    ? { agentId: located.agentId, name: typeof located.name === 'string' ? located.name : null } : null;
  return {
    error: refused ? located.message ?? 'This folder can’t be launched as a companion.' : null,
    ...(located?.status === 'installed' && located.agentId ? { agentId: located.agentId } : {}),
    // A package says what it is (agent-bot 0.10.14+): the form prefills from it (#120).
    ...(located?.status === 'package' && typeof located.name === 'string' ? { name: located.name } : {}),
    ...(located?.status === 'package' && typeof located.description === 'string' ? { description: located.description } : {}),
    ...(located?.status === 'package' && Array.isArray(located.preferredHarnesses) ? { preferredHarnesses: located.preferredHarnesses.filter((h) => typeof h === 'string') } : {}),
    ...(copyOf ? { copyOf } : {}),
  };
}

/** Whether a dropped path names a `.soul` package (Finder may end a folder with `/`). */
export function isSoulPackagePath(path: unknown): path is string {
  // eslint-disable-next-line no-control-regex
  return typeof path === 'string' && path.startsWith('/') && /\.soul\/*$/i.test(path) && !/[\u0000-\u001f\u007f]/.test(path);
}

/** The first `.soul` package among dropped paths, or null. */
export function soulPackageIn(paths: unknown): string | null {
  if (!Array.isArray(paths)) return null;
  const found = paths.find(isSoulPackagePath);
  return found ?? null;
}

/** Tauri's drag-and-drop payload, as far as the drop needs it. */
export type DropEvent = { type: 'enter'; paths: string[] } | { type: 'over' } | { type: 'drop'; paths: string[] } | { type: 'leave' };
/** `getCurrentWebview().onDragDropEvent`; tests pass a fake. */
export type DropListener = (handler: (event: { payload: DropEvent }) => void) => Promise<() => void>;

const liveDropListener: DropListener = (handler) => getCurrentWebview().onDragDropEvent(handler);

/**
 * Drops onto this web view (#98): a `.soul` package dropped calls `onPackage`
 * with its path; anything else is ignored. True while a drag carrying one
 * hovers, for the drop cue. Listens only in the app (or with `listen`).
 * A dropped path is data: it only goes to the package check and the form.
 */
export function useSoulDrop(onPackage: ((path: string) => void) | null, listen?: DropListener): boolean {
  const [hovering, setHovering] = useState(false);
  const handler = useRef(onPackage);
  handler.current = onPackage;
  const on = Boolean(onPackage);
  const source = listen ?? (inApp() ? liveDropListener : null);
  useEffect(() => {
    if (!on || !source) return;
    let active = true;
    let stop: (() => void) | undefined;
    source(({ payload }) => {
      if (!active) return;
      switch (payload.type) {
        case 'enter': setHovering(soulPackageIn(payload.paths) !== null); break;
        case 'over': break;
        case 'leave': setHovering(false); break;
        case 'drop': {
          setHovering(false);
          const path = soulPackageIn(payload.paths);
          if (path) handler.current?.(path);
          break;
        }
      }
    }).then((unlisten) => { if (active) stop = unlisten; else unlisten(); }, () => {});
    return () => { active = false; stop?.(); setHovering(false); };
  }, [on, source]);
  return hovering;
}

/**
 * Where a dropped package goes (#98). With native windows (`open`), the
 * launch window opens prefilled with it and `opened` runs (the popup hides
 * behind it); without them, or when the shell has none after all, `show`
 * puts it in this window's launch form, as a Finder-opened one.
 */
export function routeDroppedPackage(path: string, { open, show, opened }: {
  open: ((request: { surface: 'launch'; package: string }) => Promise<void>) | null;
  show: (path: string) => void;
  opened?: () => void;
}): Promise<void> {
  if (!open) { show(path); return Promise.resolve(); }
  return open({ surface: 'launch', package: path }).then(() => { opened?.(); }, () => { show(path); });
}

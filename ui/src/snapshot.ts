// Snapshot mode (#6, R1's --snapshot): fetch the census once through the
// same bridge path as the popup, render it still, and hand a PNG of the
// page to the shell, which writes it and exits. On failure the PNG still
// shows what the UI would show, and the error goes with it.
import { invoke } from '@tauri-apps/api/core';
import { call } from './bridge';
import { soulKey, type CensusRow } from './model/census';
import type { CensusOutcome } from './model/refresh';
import { fetchCensus } from './useCensus';

/** What the shell asked for: `--snapshot-detail ID` selects a soul's detail. */
export interface SnapshotOptions {
  detail: string | null;
}

/** How long the bridge may take to come up before the census counts as failed. */
export const BRIDGE_START_MS = 10_000;

/**
 * One census, retried only while the shell reports the bridge still
 * starting (bridge-* codes); a broker answer, good or bad, is final.
 */
export async function censusOnce({ callImpl = call, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now }: { callImpl?: typeof call; sleep?: (ms: number) => Promise<unknown>; now?: () => number } = {},
): Promise<CensusOutcome> {
  const deadline = now() + BRIDGE_START_MS;
  for (;;) {
    const outcome = await fetchCensus(callImpl);
    if (outcome.ok || !outcome.code.startsWith('bridge-') || now() > deadline) return outcome;
    await sleep(250);
  }
}

/** The roster key to open for `--snapshot-detail`, matched by agent ID. */
export function detailKey(census: readonly CensusRow[], agentId: string | null): string | null {
  const soul = agentId === null ? undefined : census.find((row) => row.agentId === agentId);
  return soul ? soulKey(soul) : null;
}

/** The error to report with the PNG, or null for a clean snapshot. */
export function snapshotError(outcome: CensusOutcome, options: SnapshotOptions, key: string | null): string | null {
  if (!outcome.ok) return `${outcome.code}: ${outcome.message}`;
  if (options.detail !== null && key === null) return `unknown detail ID ${options.detail}`;
  return null;
}

/** The shell's snapshot request, or null for an ordinary launch. */
export function snapshotOptions(): Promise<SnapshotOptions | null> {
  return invoke<SnapshotOptions | null>('snapshot_options');
}

/** Captures the page at scale 2 on white and sends it to the shell. */
export async function deliverSnapshot(root: HTMLElement, souls: number, error: string | null): Promise<void> {
  const { toBlob } = await import('html-to-image');
  let bytes = new Uint8Array();
  let failure = error;
  try {
    const blob = await toBlob(root, { pixelRatio: 2, backgroundColor: '#ffffff' });
    if (blob) bytes = new Uint8Array(await blob.arrayBuffer());
    else failure ??= 'snapshot-failed: the page could not be rendered';
  } catch (e) {
    failure ??= `snapshot-failed: ${String(e)}`;
  }
  await invoke('snapshot_write', bytes, {
    headers: { 'x-souls': String(souls), ...(failure ? { 'x-error': encodeURIComponent(failure) } : {}) },
  });
}

// `--snapshot` (#6): the shell loads the popup hidden and captures it once
// the first census through the bridge has settled. This tells the shell
// when that is, what the PNG shows, and opens `--snapshot-detail`'s soul.
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildSoulForest, countSouls, findSoul, soulKey, type CensusRow, type SoulNode } from './model/census';
import { errorText, unpairedMessage, type ConnectionSnapshot } from './model/status';

/** From the shell's `snapshot_options`; null on a normal launch. */
export interface SnapshotOptions {
  detail: string | null;
}

/** What the shell prints: the soul count, and the failure the PNG shows. */
export interface SnapshotReport {
  souls: number;
  error: string | null;
}

/** How often to ask again while the bridge is still starting. */
export const SNAPSHOT_RETRY_MS = 500;
/** Time for the opened detail to render before the shell captures. */
export const SNAPSHOT_SETTLE_MS = 100;

/**
 * The report once a census settled, or null while the bridge has not
 * answered yet. Unpaired and unreachable are settled outcomes: the PNG
 * shows them and the shell exits 1.
 */
export function snapshotReport(forest: readonly SoulNode[], connection: ConnectionSnapshot,
  detail: string | null): SnapshotReport | null {
  if (!connection.bridgeConnected) return null;
  // The shell prints this, so it stays English.
  let error = connection.lastError !== null ? errorText(connection.lastError) : connection.unpaired ? unpairedMessage : null;
  if (error === null && detail !== null && !findSoul(forest, detail)) error = `no soul with agent ID '${detail}'`;
  return { souls: countSouls(forest), error };
}

const tellShell = (report: SnapshotReport) => invoke('snapshot_ready', { souls: report.souls, error: report.error });

/**
 * Drives one snapshot: retries the census until the bridge answers, then
 * reports once. Returns the roster key of the soul whose detail to open.
 */
export function useSnapshot(options: SnapshotOptions | null, census: readonly CensusRow[],
  connection: ConnectionSnapshot, refresh: (() => Promise<void>) | undefined,
  { ready = tellShell, retryMs = SNAPSHOT_RETRY_MS, settleMs = SNAPSHOT_SETTLE_MS } = {}): string | null {
  const forest = useMemo(() => buildSoulForest(census), [census]);
  const [select, setSelect] = useState<string | null>(null);
  const reported = useRef(false);
  // The first census can beat the bridge's start; each failure is a new
  // connection snapshot, so this keeps asking until one settles.
  useEffect(() => {
    if (!options || !refresh || connection.bridgeConnected) return;
    const timer = setTimeout(() => { void refresh(); }, retryMs);
    return () => clearTimeout(timer);
  }, [options, refresh, connection, retryMs]);
  useEffect(() => {
    if (!options || reported.current) return;
    const report = snapshotReport(forest, connection, options.detail);
    if (!report) return;
    reported.current = true;
    const soul = options.detail === null ? null : findSoul(forest, options.detail);
    if (soul) setSelect(soulKey(soul));
    // A hidden page gets no animation frames, so wait on a timer instead.
    setTimeout(() => { void ready(report); }, settleMs);
  }, [options, forest, connection, ready, settleMs]);
  return select;
}

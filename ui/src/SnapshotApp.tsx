import { useEffect, useState } from 'react';
import { App } from './App';
import type { CensusRow } from './model/census';
import { applyCensus, type CensusOutcome } from './model/refresh';
import { disconnected, type ConnectionSnapshot } from './model/status';
import { censusOnce, detailKey, snapshotError, type SnapshotOptions } from './snapshot';

interface Rendered {
  census: readonly CensusRow[];
  connection: ConnectionSnapshot;
  selectedKey: string | null;
  error: string | null;
}

interface SnapshotAppProps {
  options: SnapshotOptions;
  /** Seams for tests; the defaults use the bridge and the shell. */
  fetchOnce?: () => Promise<CensusOutcome>;
  deliver: (souls: number, error: string | null) => void;
}

/**
 * Snapshot mode (#6): one census, the popup rendered still with any
 * requested detail open, then one delivery. Nothing polls or animates.
 */
export function SnapshotApp({ options, fetchOnce = censusOnce, deliver }: SnapshotAppProps) {
  const [rendered, setRendered] = useState<Rendered | null>(null);
  useEffect(() => {
    let stale = false;
    void fetchOnce().then((outcome) => {
      if (stale) return;
      const census = outcome.ok ? outcome.souls : [];
      const selectedKey = detailKey(census, options.detail);
      setRendered({
        census,
        connection: applyCensus(disconnected, outcome, new Date()),
        selectedKey,
        error: snapshotError(outcome, options, selectedKey),
      });
    });
    return () => { stale = true; };
  }, [fetchOnce, options]);
  useEffect(() => {
    if (!rendered) return;
    // A timer, not requestAnimationFrame: a hidden web view may never paint.
    const timer = setTimeout(() => deliver(rendered.census.length, rendered.error), 100);
    return () => clearTimeout(timer);
  }, [rendered, deliver]);
  return rendered && (
    <App census={rendered.census} connection={rendered.connection} isStatic initialSelectedKey={rendered.selectedKey} />
  );
}

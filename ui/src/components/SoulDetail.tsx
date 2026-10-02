import { useEffect, useRef, type ReactNode } from 'react';
import {
  availabilityNote,
  displayHarness,
  displayName,
  parentDisplayName,
  type CensusRow,
} from '../model/census';
import { deriveDudle } from '../model/dudle';
import { Dudle } from './Dudle';

interface SoulDetailProps {
  soul: CensusRow;
  /** Full roster for the parent's name; empty falls back to the raw ID. */
  roster?: readonly CensusRow[];
  paused?: boolean;
  onDone: () => void;
}

function yesNo(value: boolean | null | undefined): string {
  return value === true ? 'yes' : value === false ? 'no' : 'unknown';
}

/**
 * Read-only detail panel for one soul: no actions, no chat (R3). Done
 * takes focus on open so the keyboard lands inside, and Escape closes it.
 */
export function SoulDetail({ soul, roster = [], paused = false, onDone }: SoulDetailProps) {
  const done = useRef<HTMLButtonElement>(null);
  useEffect(() => done.current?.focus(), []);

  const name = displayName(soul);
  const note = availabilityNote(soul);
  const parentName = parentDisplayName(soul, roster);
  let parent: ReactNode = 'none';
  if (soul.parent !== null) {
    parent = parentName ? (
      <>
        {parentName}
        <span className="muted small block">{soul.parent}</span>
      </>
    ) : (
      soul.parent
    );
  }

  const rows: [string, ReactNode][] = [
    ['Account', soul.account],
    ['Harness', displayHarness(soul)],
    ['Presence', soul.presence],
    ['Parent', parent],
    ['Unacked', String(soul.unacked)],
    ['Last wake', soul.lastWake ?? 'none'],
  ];
  // Principal-client fields that R1's census did not carry; shown only
  // when the bridge supplies them.
  if (soul.verification !== undefined) rows.push(['Verification', soul.verification ?? 'none']);
  if (soul.hardened !== undefined) rows.push(['Hardened', yesNo(soul.hardened)]);
  if (soul.daemonWatching !== undefined) rows.push(['Daemon watching', yesNo(soul.daemonWatching)]);

  return (
    <section
      className="detail"
      role="dialog"
      aria-label={`${name}, ${soul.agentId}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDone();
      }}
    >
      <div className="detail-head">
        <Dudle spec={deriveDudle(soul.agentId)} diameter={56} paused={paused} label={`Avatar for ${name}`} />
        <div>
          <h2>{name}</h2>
          <p className="muted small selectable">{soul.agentId}</p>
        </div>
      </div>
      {note && <p className="muted">{note}</p>}
      <dl>
        {rows.map(([term, value]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="detail-actions">
        <button type="button" ref={done} onClick={onDone}>
          Done
        </button>
      </div>
    </section>
  );
}

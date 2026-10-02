import {
  availabilityNote,
  displayHarness,
  displayName,
  soulKey,
  type CensusRow,
  type SoulNode,
} from '../model/census';
import { deriveDudle } from '../model/dudle';
import { Dudle } from './Dudle';

/** Spoken summary of a row; presence and last wake are always text. */
export function soulRowLabel(soul: CensusRow, unread = 0): string {
  const parts = [
    displayName(soul),
    displayHarness(soul),
    `presence ${soul.presence}`,
    `unacked ${soul.unacked}`,
    `last wake ${soul.lastWake ?? 'none'}`,
  ];
  if (unread > 0) parts.push(`${unread} unread ${unread === 1 ? 'message' : 'messages'}`);
  const note = availabilityNote(soul);
  if (note) parts.push(note);
  return parts.join(', ');
}

interface SoulRowProps {
  node: SoulNode;
  depth: number;
  /** Set while the popup is hidden so Dudle blink timers stop. */
  paused?: boolean;
  /** Unread chat messages from a soul (#17); absent means none. */
  unreadOf?: (soul: CensusRow) => number;
  onSelect: (soul: CensusRow) => void;
}

/**
 * One soul and, indented beneath it, its subagents. Every soul is
 * selectable, 'left' ones included, and opens the read-only detail.
 */
export function SoulRow({ node, depth, paused = false, unreadOf, onSelect }: SoulRowProps) {
  const { soul } = node;
  const unread = unreadOf?.(soul) ?? 0;
  const name = displayName(soul);
  const note = availabilityNote(soul);
  return (
    <div className="soul">
      <button
        type="button"
        className="soul-row"
        style={{ paddingLeft: 14 + depth * 16 }}
        title={`Show details for ${name}`}
        aria-label={soulRowLabel(soul, unread)}
        aria-description="Shows details."
        onClick={() => onSelect(soul)}
      >
        <Dudle spec={deriveDudle(soul.agentId)} paused={paused} label={`Avatar for ${name}`} />
        <span className="soul-text">
          <span className="soul-line">
            <span className="soul-name">{name}</span>
            <span className="muted small">{displayHarness(soul)}</span>
            {unread > 0 && <span className="unread-badge small">{unread} new</span>}
          </span>
          <span className="soul-line small">
            <span className={`presence presence-${soul.presence}`}>{soul.presence}</span>
            <span className={soul.unacked > 0 ? 'unacked' : 'muted'}>unacked {soul.unacked}</span>
            <span className="muted">last wake {soul.lastWake ?? 'none'}</span>
          </span>
          {note && <span className="muted small">{note}</span>}
        </span>
      </button>
      {node.children.map((child) => (
        <SoulRow key={soulKey(child.soul)} node={child} depth={depth + 1} paused={paused} unreadOf={unreadOf} onSelect={onSelect} />
      ))}
    </div>
  );
}

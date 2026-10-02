import { useEffect, useRef, type ReactNode } from 'react';
import {
  availabilityNote,
  displayHarness,
  displayName,
  parentDisplayName,
  type CensusRow,
} from '../model/census';
import type { ChatEntry, Composer } from '../model/chat';
import { deriveDudle } from '../model/dudle';
import { Conversation } from './Conversation';
import { Dudle } from './Dudle';

/** The conversation with this soul, when chat is available (#17). */
export interface SoulChat {
  entries: readonly ChatEntry[];
  composer: Composer;
  onDraft: (draft: string) => void;
  onSend: () => void;
}

interface SoulDetailProps {
  soul: CensusRow;
  /** Full roster for the parent's name; empty falls back to the raw ID. */
  roster?: readonly CensusRow[];
  paused?: boolean;
  chat?: SoulChat;
  onDone: () => void;
}

function yesNo(value: boolean | null | undefined): string {
  return value === true ? 'yes' : value === false ? 'no' : 'unknown';
}

/**
 * Detail panel for one soul, with the conversation when chat is given.
 * Done takes focus on open so the keyboard lands inside, and Escape
 * closes it (a draft survives, held by the chat store).
 */
export function SoulDetail({ soul, roster = [], paused = false, chat, onDone }: SoulDetailProps) {
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
      {chat && (
        <Conversation name={name} entries={chat.entries} composer={chat.composer} onDraft={chat.onDraft} onSend={chat.onSend} />
      )}
      <div className="detail-actions">
        <button type="button" ref={done} onClick={onDone}>
          Done
        </button>
      </div>
    </section>
  );
}

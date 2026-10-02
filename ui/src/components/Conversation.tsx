import { useEffect, useRef } from 'react';
import { canSend, type ChatEntry, type Composer } from '../model/chat';

interface ConversationProps {
  /** The soul's display name. */
  name: string;
  entries: readonly ChatEntry[];
  composer: Composer;
  onDraft: (draft: string) => void;
  onSend: () => void;
}

/**
 * Messages between this principal and one soul, newest at the bottom,
 * with a composer. Bodies are untrusted text: rendered as React text
 * nodes only (no HTML, no markdown), with whitespace kept by CSS.
 */
export function Conversation({ name, entries, composer, onDraft, onSend }: ConversationProps) {
  const list = useRef<HTMLOListElement>(null);
  const last = entries.at(-1)?.id;
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [last]);

  const ready = canSend(composer);
  const errorId = 'chat-error';
  return (
    <div className="chat">
      {entries.length === 0 ? (
        <p className="muted small">Say hello to {name} to start chatting.</p>
      ) : (
        <ol className="chat-log" ref={list} aria-label={`Conversation with ${name}`}>
          {entries.map((entry) => (
            <li key={entry.id} className={`chat-msg chat-${entry.direction}`}>
              <span className="muted small">
                {entry.direction === 'in' ? name : 'You'} · {new Date(entry.at).toLocaleTimeString()}
              </span>
              <p className="chat-body selectable">{entry.body}</p>
            </li>
          ))}
        </ol>
      )}
      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) onSend();
        }}
      >
        <textarea
          aria-label={`Message to ${name}`}
          aria-describedby={composer.error ? errorId : undefined}
          placeholder="Write a message…"
          rows={2}
          value={composer.draft}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => {
            // Cmd/Ctrl+Enter sends; Enter alone is a newline.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (ready) onSend();
            }
          }}
        />
        <button type="submit" disabled={!ready}>
          {composer.sending ? 'Sending…' : 'Send'}
        </button>
      </form>
      {composer.error && (
        <p id={errorId} role="alert" className="error small">
          {composer.error}
        </p>
      )}
    </div>
  );
}

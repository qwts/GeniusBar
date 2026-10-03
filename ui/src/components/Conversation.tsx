import { useEffect, useRef } from 'react';
import { ArrowUp } from 'lucide-react';
import { canSend, type ChatEntry, type Composer } from '../model/chat';
import type { DudleSpec } from '../model/dudle';
import { useI18n } from '../lib/i18n';
import { Dudle } from './Dudle';

interface ConversationProps {
  /** The soul's display name. */
  name: string;
  entries: readonly ChatEntry[];
  composer: Composer;
  onDraft: (draft: string) => void;
  onSend: () => void;
  /** The soul's Dudle beside its messages; omitted in plain renders. */
  dudle?: DudleSpec;
  paused?: boolean;
}

/**
 * Messages between this principal and one soul, newest at the bottom,
 * with a composer. Bodies are untrusted text: rendered as React text
 * nodes only (no HTML, no markdown), with whitespace kept by CSS.
 */
export function Conversation({ name, entries, composer, onDraft, onSend, dudle, paused = false }: ConversationProps) {
  const { t } = useI18n();
  const list = useRef<HTMLOListElement>(null);
  const last = entries.at(-1)?.id;
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [last]);

  const ready = canSend(composer);
  const errorId = 'chat-error';
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {entries.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          {dudle && <Dudle spec={dudle} diameter={56} paused={paused} />}
          <p className="text-sm text-muted-foreground">{t('emptyChat', { name })}</p>
        </div>
      ) : (
        <ol
          className="m-0 flex flex-1 list-none flex-col gap-3 overflow-y-auto px-3 py-4"
          ref={list}
          aria-label={t('conversationWith', { name })}
        >
          {entries.map((entry) => {
            const mine = entry.direction === 'out';
            return (
              <li key={entry.id} className={`flex items-end gap-2 ${mine ? 'justify-end' : ''}`}>
                {!mine && dudle && <Dudle spec={dudle} diameter={24} paused={paused} />}
                <div className={mine
                  ? 'max-w-[85%] rounded-lg rounded-br-sm bg-primary px-3 py-1.5 text-primary-foreground'
                  : 'max-w-[85%] rounded-lg rounded-bl-sm bg-muted px-3 py-1.5'}>
                  <span className={`block text-[10px] ${mine ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>
                    {mine ? t('you') : name} · {new Date(entry.at).toLocaleTimeString()}
                  </span>
                  <p className="chat-body selectable m-0 whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">{entry.body}</p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <form
        className="border-t border-border p-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) onSend();
        }}
      >
        <div className="flex items-end gap-2 rounded-lg border border-input bg-card p-1.5 focus-within:ring-2 focus-within:ring-ring">
          <textarea
            className="max-h-32 min-h-8 flex-1 resize-none border-0 bg-transparent px-1.5 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            aria-label={t('composerLabel', { name })}
            aria-describedby={composer.error ? errorId : undefined}
            placeholder={t('composerPlaceholder')}
            title={t('sendHint')}
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
          <button
            type="submit"
            disabled={!ready}
            aria-label={composer.sending ? t('sending') : t('send')}
            className={`flex h-8 shrink-0 items-center justify-center gap-1 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 ${composer.sending ? 'px-2 text-xs' : 'w-8'}`}
          >
            {composer.sending && <span>{t('sending')}</span>}
            <ArrowUp className="size-4" aria-hidden />
          </button>
        </div>
        {composer.error && (
          <p id={errorId} role="alert" className="error small mx-1 mt-1 mb-0">
            {composer.error}
          </p>
        )}
      </form>
    </div>
  );
}

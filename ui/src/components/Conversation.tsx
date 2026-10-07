import { useEffect, useRef } from 'react';
import { ArrowUp } from 'lucide-react';
import { canSend, isTextEntry, type ApprovalDecision, type ChatEntry, type Composer } from '../model/chat';
import type { DudleSpec } from '../model/dudle';
import { useI18n } from '../lib/i18n';
import { Dudle } from './Dudle';
import { AgentAside, MessageBody, ToolApprovalCard, ToolCard } from './Entries';

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
  /**
   * Answers an approval request. Without it (no backend yet) approval
   * cards show their buttons disabled.
   */
  onResolve?: (entryId: string, decision: ApprovalDecision) => void;
  /** The companion cannot take messages (it left, or its sign-in lapsed). */
  disabled?: boolean;
}

/**
 * Messages between this principal and one soul, newest at the bottom,
 * with a composer, plus the soul's tool calls, approval requests and
 * asides (#122). Bodies are untrusted text: rendered as a safe Markdown
 * subset made of React elements only (no HTML, links not followed, #117),
 * with whitespace kept by CSS.
 */
export function Conversation({ name, entries, composer, onDraft, onSend, dudle, paused = false, onResolve, disabled = false }: ConversationProps) {
  const { t, lang } = useI18n();
  const list = useRef<HTMLOListElement>(null);
  const last = entries.at(-1)?.id;
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [last]);

  const latest = entries.at(-1);
  // Screen readers hear the soul's newest message as it arrives.
  const announce = latest && isTextEntry(latest) && latest.direction === 'in' ? `${name}: ${latest.body}` : '';

  const ready = !disabled && canSend(composer);
  // As the design: hour and minute in the app's language.
  const clock = new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' });
  const errorId = 'chat-error';
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="sr-only" aria-live="polite" aria-atomic="true">{announce}</div>
      {entries.length === 0 ? (
        <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
          <div className="mx-auto mt-16 flex max-w-sm flex-col items-center gap-3 text-center">
            {dudle && <Dudle spec={dudle} diameter={64} paused={paused} />}
            <p className="m-0 text-sm text-muted-foreground">{t('emptyChat', { name })}</p>
          </div>
        </div>
      ) : (
        <ol
          className="m-0 flex flex-1 list-none flex-col gap-4 overflow-y-auto px-4 py-6 md:px-8"
          ref={list}
          aria-label={t('conversationWith', { name })}
        >
          {entries.map((entry) => {
            if (entry.kind === 'tool_call') return <li key={entry.id} className="ml-10"><ToolCard e={entry} /></li>;
            if (entry.kind === 'approval_request') {
              return <li key={entry.id} className="ml-10"><ToolApprovalCard e={entry} name={name} onResolve={onResolve} /></li>;
            }
            if (entry.kind === 'aside') return <li key={entry.id}><AgentAside e={entry} /></li>;
            const mine = entry.direction === 'out';
            return (
              <li key={entry.id} className={`flex items-end gap-2 ${mine ? 'justify-end' : ''}`}>
                {!mine && dudle && <Dudle spec={dudle} diameter={30} paused={paused} />}
                {/* As the design: the owner's words in a gold bubble, the soul's as plain text under its name. */}
                <div className={mine
                  ? 'max-w-[70ch] rounded-lg rounded-br-sm bg-primary px-3 py-2 text-primary-foreground'
                  : 'max-w-[70ch] text-foreground'}>
                  <span className={`mb-0.5 block text-xs font-semibold ${mine ? 'sr-only' : 'text-muted-foreground'}`}>
                    {mine ? t('you') : name}
                  </span>
                  <MessageBody body={entry.body} className="chat-body selectable text-sm leading-relaxed [overflow-wrap:anywhere]" />
                  <time className={`mt-0.5 block text-[10px] ${mine ? 'text-primary-foreground' : 'text-muted-foreground'}`} dateTime={new Date(entry.at).toISOString()}>
                    {clock.format(new Date(entry.at))}
                  </time>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <form
        className="border-t border-border p-3 md:px-8"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) onSend();
        }}
      >
        <div className="flex items-end gap-2 rounded-lg border border-input bg-card p-2 focus-within:ring-2 focus-within:ring-ring">
          <textarea
            className="max-h-32 min-h-9 flex-1 resize-none border-0 bg-transparent px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={t('composerLabel', { name })}
            aria-describedby={composer.error ? errorId : undefined}
            placeholder={t('composerPlaceholder', { name })}
            title={t('sendHint')}
            rows={1}
            disabled={disabled}
            value={composer.draft}
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={(e) => {
              // As the design: Enter sends and Shift+Enter is a newline;
              // Cmd/Ctrl+Enter still sends. Never mid-IME composition.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (ready) onSend();
              }
            }}
          />
          <button
            type="submit"
            disabled={!ready}
            aria-label={composer.sending ? t('sending') : t('send')}
            className={`flex h-9 shrink-0 items-center justify-center gap-1 rounded-md bg-primary text-primary-foreground shadow hover:bg-primary/90 disabled:opacity-50 ${composer.sending ? 'px-2 text-xs' : 'w-9'}`}
          >
            {composer.sending && <span>{t('sending')}</span>}
            <ArrowUp className="size-4" aria-hidden />
          </button>
        </div>
        {composer.error && (
          <p id={errorId} role="alert" className="mx-1 mt-1 mb-0 text-xs text-destructive">
            {composer.error}
          </p>
        )}
      </form>
    </div>
  );
}

// The chat's non-text entries (Lovable `src/components/gb/Entries.tsx`):
// tool cards, approval cards and asides between agents, plus the Markdown
// renderer for message bodies (#117). Thin views over model/chat.ts and
// model/markdown.ts; the design's shadcn Collapsible and Button are plain
// elements here with the same classes and ARIA.
import { useId, useState, type ReactNode } from 'react';
import { Check, ChevronRight, FileEdit, FileText, Globe, Loader2, ShieldAlert, Terminal, X } from 'lucide-react';
import type { ApprovalDecision, ApprovalEntry, AsideEntry, ToolCallEntry } from '../model/chat';
import { parseMarkdown, type Block, type Inline } from '../model/markdown';
import { useI18n } from '../lib/i18n';

const ICON: Record<string, typeof Terminal> = { terminal: Terminal, edit_file: FileEdit, browser: Globe, read_file: FileText };

export function ToolCard({ e }: { e: ToolCallEntry }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const Icon = ICON[e.tool] ?? Terminal;
  const tone = e.status === 'success' ? 'text-success' : e.status === 'failed' ? 'text-destructive' : 'text-primary';
  const label = `${t('toolLabel', { tool: e.tool })} — ${t(`tool.${e.status}`)}`;
  const header = (
    <>
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="font-semibold text-foreground">{e.tool}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{e.args}</span>
      <span className={`flex items-center gap-1 ${tone}`}>
        {e.status === 'running'
          ? <Loader2 className="size-3 animate-spin" aria-hidden />
          : e.status === 'success' ? <Check className="size-3" aria-hidden /> : <X className="size-3" aria-hidden />}
        {t(`tool.${e.status}`)}
      </span>
      {e.output && <ChevronRight className={`size-3.5 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden />}
    </>
  );
  const headerClass = 'flex w-full items-center gap-2 px-3 py-2 text-left';
  return (
    <div className="max-w-xl rounded-md border border-border bg-card font-mono text-xs">
      {e.output ? (
        <button type="button" className={`${headerClass} rounded-md bg-transparent font-mono text-xs`} aria-label={label}
          aria-expanded={open} aria-controls={contentId} onClick={() => setOpen((o) => !o)}>
          {header}
        </button>
      ) : (
        <div className={headerClass} role="group" aria-label={label}>{header}</div>
      )}
      {e.output && open && (
        <div id={contentId} className="border-t border-border px-3 py-2">
          <p className="selectable m-0 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{e.output}</p>
          {e.diff && (
            <pre className="selectable mt-2 mb-0 overflow-x-auto rounded bg-background p-2 leading-relaxed">
              {e.diff.split('\n').map((l, i) => (
                <div key={i} className={l.startsWith('+') ? 'text-success' : l.startsWith('-') ? 'text-destructive' : ''}>{l}</div>
              ))}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

const BUTTON = 'inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-medium';

export function ToolApprovalCard({ e, name, onResolve, allowSession = false }: {
  e: ApprovalEntry;
  name: string;
  onResolve?: (entryId: string, decision: ApprovalDecision) => void;
  /** Approve for session needs a daemon scope that does not exist yet. */
  allowSession?: boolean;
}) {
  const { t } = useI18n();
  const pending = e.status === 'pending';
  // Without a handler (no backend) the buttons show but cannot act.
  const later = t('approval.unavailable');
  const unavailable = onResolve ? undefined : later;
  const ready = Boolean(onResolve) && !e.deciding;
  const resolve = (decision: ApprovalDecision) => onResolve?.(e.id, decision);
  return (
    <div
      role={pending ? 'alert' : undefined}
      aria-busy={e.deciding ? true : undefined}
      className={`max-w-xl rounded-md border-2 p-3 ${pending ? 'border-warning bg-warning/10' : 'border-border bg-card opacity-80'}`}
    >
      <div className="flex items-start gap-2">
        <ShieldAlert className={`mt-0.5 size-4 shrink-0 ${pending ? 'text-warning' : 'text-muted-foreground'}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="m-0 text-sm font-semibold text-foreground">{t('approvalTitle', { name, tool: e.tool })}</p>
          <code className="selectable mt-1 block truncate rounded bg-background px-2 py-1 font-mono text-xs text-foreground" title={e.args}>{e.args}</code>
          <p className="m-0 mt-1 text-xs text-muted-foreground">{t(`risk.${e.risk}`)}</p>
        </div>
      </div>
      {pending ? (
        <>
          <div className="mt-3 flex flex-wrap gap-2" title={unavailable}>
            <button type="button" disabled={!ready} title={unavailable} onClick={() => resolve('approved')}
              className={`${BUTTON} bg-primary text-primary-foreground shadow hover:bg-primary/90`}>
              {t('approve')}
            </button>
            <button type="button" disabled={!ready || !allowSession} title={allowSession ? unavailable : later}
              onClick={() => resolve('approved_session')}
              className={`${BUTTON} bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80`}>
              {t('approveSession')}
            </button>
            <button type="button" disabled={!ready} title={unavailable} onClick={() => resolve('denied')}
              className={`${BUTTON} bg-transparent text-destructive hover:bg-accent`}>
              {t('deny')}
            </button>
          </div>
          {e.deciding && <p role="status" className="m-0 mt-2 text-xs text-muted-foreground">{t('approval.deciding')}</p>}
          {!e.deciding && e.error && <p className="m-0 mt-2 text-xs text-destructive">{t('approval.failed', { message: e.error })}</p>}
        </>
      ) : (
        <p className={`m-0 mt-2 text-xs font-medium ${e.status === 'denied' ? 'text-destructive' : 'text-success'}`}>
          {t(`approval.${e.status as ApprovalDecision}`)}
        </p>
      )}
    </div>
  );
}

export function AgentAside({ e }: { e: AsideEntry }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  const contentId = useId();
  return (
    <div className="ml-8 max-w-lg rounded-r-md border-l-2 border-info/60 bg-info/5 py-1 pr-2 pl-3">
      <button type="button" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen((o) => !o)}
        className="flex min-h-7 w-full items-center gap-1.5 rounded bg-transparent p-0 text-left text-xs text-info">
        <ChevronRight className={`size-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden />
        <span className="font-mono font-semibold">{t('asideLabel', { from: e.from, to: e.to })}</span>
        <span className="text-muted-foreground">· {t('asideHint')}</span>
        {e.team && <span className="ml-auto rounded-full border border-info/40 px-1.5 font-mono text-[11px]">{t('aside.team', { team: e.team })}</span>}
      </button>
      {open && (
        <div id={contentId} className="space-y-1 py-1 text-xs">
          <p className="selectable m-0 whitespace-pre-wrap italic text-muted-foreground [overflow-wrap:anywhere]">
            <span className="font-mono text-foreground not-italic">{e.from}:</span> {e.body}
          </p>
          {e.reply && (
            <p className="selectable m-0 whitespace-pre-wrap italic text-muted-foreground [overflow-wrap:anywhere]">
              <span className="font-mono text-foreground not-italic">{e.to}:</span> {e.reply}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Markdown bodies (#117) -----------------------------------------------

function inlines(nodes: readonly Inline[]): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.type) {
      case 'text':
        return node.text;
      case 'code':
        return <code key={i} className="rounded bg-muted px-1 py-px font-mono text-[0.9em]">{node.text}</code>;
      case 'strong':
        return <strong key={i} className="font-semibold">{inlines(node.children)}</strong>;
      case 'em':
        return <em key={i}>{inlines(node.children)}</em>;
      case 'link': {
        // Not a live link: the text, then the address to copy.
        const text = inlines(node.children);
        const same = node.children.length === 1 && node.children[0].type === 'text' && node.children[0].text === node.href;
        return (
          <span key={i} className="chat-link">
            <span className="underline decoration-dotted underline-offset-2">{text}</span>
            {!same && <span className="font-mono text-[0.9em]"> ({node.href})</span>}
          </span>
        );
      }
    }
  });
}

function block(node: Block, i: number): ReactNode {
  switch (node.type) {
    case 'paragraph':
      return <p key={i} className="m-0 whitespace-pre-wrap">{inlines(node.children)}</p>;
    case 'heading':
      return <p key={i} className="m-0 font-semibold">{inlines(node.children)}</p>;
    case 'quote':
      return <blockquote key={i} className="m-0 whitespace-pre-wrap border-l-2 border-border pl-2 opacity-90">{inlines(node.children)}</blockquote>;
    case 'code':
      return <pre key={i} className="m-0 overflow-x-auto rounded bg-muted p-2 font-mono text-xs leading-relaxed">{node.text}</pre>;
    case 'list': {
      const items = node.items.map((item, j) => <li key={j} className="whitespace-pre-wrap">{inlines(item)}</li>);
      return node.ordered
        ? <ol key={i} start={node.start} className="m-0 list-decimal space-y-0.5 pl-5">{items}</ol>
        : <ul key={i} className="m-0 list-disc space-y-0.5 pl-5">{items}</ul>;
    }
  }
}

/**
 * A message body as safe Markdown: React elements only, never HTML, and
 * links shown as text. `className` goes on the wrapper.
 */
export function MessageBody({ body, className = '' }: { body: string; className?: string }) {
  return <div className={`space-y-2 ${className}`}>{parseMarkdown(body).map(block)}</div>;
}

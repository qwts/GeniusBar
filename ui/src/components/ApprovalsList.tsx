import { useI18n } from '../lib/i18n';
import type { MenuApproval } from '../model/approvals';
import type { CensusRow } from '../model/census';
import { SoulDudle } from './FleetList';

const FOCUS = 'outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * The menu header's counts, as Lovable's GeniusBarItem: "N waiting on you"
 * in warning and "· M working" in mono, zeros included.
 */
export function ApprovalCounts({ waiting, working }: { waiting: number; working: number }) {
  const { t } = useI18n();
  return (
    <p className="m-0 flex items-center gap-1 font-mono text-[11px]">
      <span className="text-warning">{t('bar.approvals', { count: waiting })}</span>
      <span className="text-muted-foreground">· {t('bar.working', { count: working })}</span>
    </p>
  );
}

/**
 * The menu's "Waiting for your approval" section (Lovable GeniusBarItem,
 * #85): one card per pending proposal, oldest first, with the companion,
 * its tool, the command, and Approve / Deny. The name opens that
 * companion's chat. While nothing waits the heading stays, over "Nothing
 * waiting for you", and the section is no longer an alert.
 */
export function ApprovalsList({ items, paused, onDecide, onOpen }: {
  items: readonly MenuApproval[];
  paused: boolean;
  /** Without it (no agent-bot) the buttons show but cannot act. */
  onDecide?: (proposalId: string, decision: 'approve' | 'deny') => void;
  onOpen: (soul: CensusRow) => void;
}) {
  const { t } = useI18n();
  const later = onDecide ? undefined : t('approval.unavailable');
  const heading = <h3 className="m-0 px-3 pt-2 pb-1 font-mono text-[10px] font-normal tracking-wider text-muted-foreground uppercase">{t('approvals.title')}</h3>;
  if (items.length === 0) {
    return (
      <section aria-label={t('approvals.title')} className="shrink-0 border-b border-border">
        {heading}
        <p className="m-0 px-3 pb-2 text-xs text-muted-foreground">{t('approvals.empty')}</p>
      </section>
    );
  }
  return (
    <section role="alert" aria-label={t('approvals.title')} className="shrink-0 border-b border-border">
      {heading}
      <ul className="m-0 max-h-48 list-none space-y-1 overflow-y-auto px-2 pt-0 pb-2">
        {items.map((item) => {
          const ready = Boolean(onDecide) && !item.deciding;
          const who = (
            <>
              {item.soul && <SoulDudle soul={item.soul} size={16} paused={paused} state="awaiting" />}
              <span className="font-semibold">{item.name}</span>
              <span className="text-muted-foreground">· {item.tool}</span>
            </>
          );
          return (
            <li key={item.proposalId} aria-busy={item.deciding ? true : undefined}
              className="rounded-md border border-warning/50 bg-warning/10 p-2">
              {item.soul ? (
                <button type="button" onClick={() => item.soul && onOpen(item.soul)} aria-label={t('approvals.open', { name: item.name })}
                  className={`flex w-full items-center gap-1.5 rounded bg-transparent p-0 text-left text-xs text-foreground ${FOCUS}`}>
                  {who}
                </button>
              ) : (
                <p className="m-0 flex items-center gap-1.5 text-xs">{who}</p>
              )}
              <code className="selectable mt-1 block truncate font-mono text-[11px] text-foreground" title={item.command}>{item.command}</code>
              <div className="mt-1.5 flex gap-1.5" title={later}>
                <button type="button" disabled={!ready} title={later} onClick={() => onDecide?.(item.proposalId, 'approve')}
                  aria-label={t('approvals.approveLabel', { tool: item.tool, name: item.name })}
                  className={`min-h-7 rounded border-0 bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 ${FOCUS}`}>
                  {t('approve')}
                </button>
                <button type="button" disabled={!ready} title={later} onClick={() => onDecide?.(item.proposalId, 'deny')}
                  aria-label={t('approvals.denyLabel', { tool: item.tool, name: item.name })}
                  className={`min-h-7 rounded border border-destructive/50 bg-transparent px-3 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50 ${FOCUS}`}>
                  {t('deny')}
                </button>
              </div>
              {item.deciding && <p role="status" className="m-0 mt-1.5 text-xs text-muted-foreground">{t('approval.deciding')}</p>}
              {!item.deciding && item.error && <p className="m-0 mt-1.5 text-xs text-destructive">{t('approval.failed', { message: item.error })}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

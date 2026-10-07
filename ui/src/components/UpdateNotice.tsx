import { Check, Download, TriangleAlert } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { updateNotice, type UpdateStatus } from '../model/updates';
import { textLink } from './ui';

/**
 * The popup's update line (#34): the same states the tray item shows. After
 * the owner's own Check for Updates…, an up-to-date answer says so (the
 * design's `setup.upToDate` toast); automatic checks stay silent.
 */
export function UpdateNotice({ status, onAction, checked = false }: {
  status: UpdateStatus; onAction: () => void;
  /** The owner asked for this check: say when there is nothing new. */
  checked?: boolean;
}) {
  const { t } = useI18n();
  const notice = updateNotice(status);
  if (!notice && checked && status.state === 'up-to-date') {
    return (
      <p className="m-0 flex items-center gap-2 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground" role="status" aria-label={t('update.label')}>
        <Check className="size-3.5 shrink-0 text-success" aria-hidden />{t('setup.upToDate')}
      </p>
    );
  }
  if (!notice) return null;
  const Icon = notice.isError ? TriangleAlert : Download;
  return (
    <div className="flex items-center gap-2 border-b border-border bg-primary/10 px-3 py-1.5 text-[11px]"
      role={notice.isError ? 'alert' : 'status'} aria-label={t('update.label')}>
      <Icon className={`size-3.5 shrink-0 ${notice.isError ? 'text-destructive' : 'text-primary'}`} aria-hidden />
      <span className={`min-w-0 flex-1 ${notice.isError ? 'text-destructive' : 'text-foreground'}`}>{notice.text}</span>
      {notice.action && (
        <button type="button" className={`${textLink} shrink-0 text-[11px]`} onClick={onAction}>
          {notice.action}
        </button>
      )}
    </div>
  );
}

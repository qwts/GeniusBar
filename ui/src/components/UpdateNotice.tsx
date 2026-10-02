import { updateNotice, type UpdateStatus } from '../model/updates';

/** The popup's update line (#34): the same states the tray item shows. */
export function UpdateNotice({ status, onAction }: { status: UpdateStatus; onAction: () => void }) {
  const notice = updateNotice(status);
  if (!notice) return null;
  return (
    <div className="update" role={notice.isError ? 'alert' : 'status'} aria-label="Update">
      <span className={notice.isError ? 'error small' : 'small'}>{notice.text}</span>
      {notice.action && (
        <button type="button" className="link" onClick={onAction}>
          {notice.action}
        </button>
      )}
    </div>
  );
}

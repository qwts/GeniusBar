import { useState } from 'react';
import { useI18n } from '../lib/i18n';

type Phase = 'idle' | 'confirming' | 'removing' | 'removed';

/**
 * The explicit "Remove services" action (#9): asks once, then unloads and
 * deletes GeniusBar's broker and daemon login services. Pairings and chat
 * history stay; running setup again brings the services back.
 */
export function RemoveServices({ onRemove }: { onRemove: () => Promise<void> }) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);

  if (phase === 'idle' || phase === 'removed') {
    return (
      <>
        {phase === 'removed' && <span className="muted small" role="status">{t('remove.done')}</span>}
        <button type="button" className="link" onClick={() => { setError(null); setPhase('confirming'); }}>
          {t('remove.action')}
        </button>
      </>
    );
  }
  return (
    <div className="confirm" role="group" aria-label={t('remove.label')}>
      <p className="small">{t('remove.confirm')}</p>
      {error && <p className="error small" role="alert">{error}</p>}
      <div className="detail-actions">
        <button type="button" disabled={phase === 'removing'} onClick={() => setPhase('idle')}>{t('cancel')}</button>
        <button
          type="button"
          disabled={phase === 'removing'}
          onClick={async () => {
            setPhase('removing');
            try {
              await onRemove();
              setPhase('removed');
            } catch (e) {
              const message = (e as { message?: unknown })?.message;
              setError(typeof message === 'string' && message ? message : t('remove.failed'));
              setPhase('confirming');
            }
          }}
        >
          {phase === 'removing' ? t('remove.running') : t('remove.go')}
        </button>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { useI18n } from '../lib/i18n';
import { actions, destructiveButton, errorLine, mutedLine, secondaryButton, textLink } from './ui';

type Phase = 'idle' | 'confirming' | 'removing' | 'removed';

/**
 * The explicit "Remove services" action (#9): asks once, then unloads and
 * deletes GeniusBar's broker and daemon login services. Pairings and chat
 * history stay; running setup again brings the services back.
 */
export function RemoveServices({ onRemove, startConfirming = false, onClose }: {
  onRemove: () => Promise<void>;
  /** Opened from a menu: starts at the question, and reports Cancel and success. */
  startConfirming?: boolean;
  onClose?: () => void;
}) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>(startConfirming ? 'confirming' : 'idle');
  const [error, setError] = useState<string | null>(null);

  if (phase === 'idle' || phase === 'removed') {
    return (
      <>
        {phase === 'removed' && <span className={mutedLine} role="status">{t('remove.done')}</span>}
        <button type="button" className={textLink} onClick={() => { setError(null); setPhase('confirming'); }}>
          {t('remove.action')}
        </button>
      </>
    );
  }
  return (
    <div className="grid w-full gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs" role="group" aria-label={t('remove.label')}>
      <p className="m-0 text-xs text-foreground">{t('remove.confirm')}</p>
      {error && <p className={errorLine} role="alert">{error}</p>}
      <div className={actions}>
        <button type="button" className={secondaryButton} disabled={phase === 'removing'} onClick={() => { setPhase('idle'); onClose?.(); }}>{t('cancel')}</button>
        <button
          type="button"
          className={destructiveButton}
          disabled={phase === 'removing'}
          onClick={async () => {
            setPhase('removing');
            try {
              await onRemove();
              if (onClose) { onClose(); return; }
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

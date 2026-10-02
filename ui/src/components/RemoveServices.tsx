import { useState } from 'react';

type Phase = 'idle' | 'confirming' | 'removing' | 'removed';

/**
 * The explicit "Remove services" action (#9): asks once, then unloads and
 * deletes GeniusBar's broker and daemon login services. Pairings and chat
 * history stay; running setup again brings the services back.
 */
export function RemoveServices({ onRemove }: { onRemove: () => Promise<void> }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);

  if (phase === 'idle' || phase === 'removed') {
    return (
      <>
        {phase === 'removed' && <span className="muted small" role="status">Services removed.</span>}
        <button type="button" className="link" onClick={() => { setError(null); setPhase('confirming'); }}>
          Remove services…
        </button>
      </>
    );
  }
  return (
    <div className="confirm" role="group" aria-label="Remove services">
      <p className="small">
        Stop and remove GeniusBar’s broker and daemon login services? Pairings are kept; run setup to add them back.
      </p>
      {error && <p className="error small" role="alert">{error}</p>}
      <div className="detail-actions">
        <button type="button" disabled={phase === 'removing'} onClick={() => setPhase('idle')}>Cancel</button>
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
              setError(typeof message === 'string' && message ? message : 'Could not remove the services.');
              setPhase('confirming');
            }
          }}
        >
          {phase === 'removing' ? 'Removing…' : 'Remove'}
        </button>
      </div>
    </div>
  );
}

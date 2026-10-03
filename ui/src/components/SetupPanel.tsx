import { Check, Circle, Loader2 } from 'lucide-react';
import { SETUP_STEPS, type SetupState } from '../model/setup';

const MARK = { pending: Circle, running: Loader2, done: Check } as const;

/** First-run setup, shown in place of the fleet until GeniusBar is paired. */
export function SetupPanel({ setup, onSetup }: { setup: SetupState; onSetup: () => void }) {
  return (
    <section className="setup" aria-label="Setup">
      <p>Let’s connect GeniusBar to your account.</p>
      <ol aria-live="polite">
        {SETUP_STEPS.map(({ step, label }) => {
          const Mark = MARK[setup.steps[step]];
          return (
            <li key={step} className={setup.steps[step]}>
              <Mark className={`size-4 ${setup.steps[step] === 'running' ? 'motion-safe:animate-spin' : ''}`} aria-hidden /> {label}
            </li>
          );
        })}
      </ol>
      {setup.error && <p className="error small" role="alert">{setup.error}</p>}
      <button type="button" onClick={onSetup} disabled={setup.running}>
        {setup.running ? 'Setting up…' : setup.error ? 'Try again' : 'Set up'}
      </button>
    </section>
  );
}

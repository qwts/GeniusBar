import { SETUP_STEPS, type SetupState } from '../model/setup';

const MARK = { pending: '○', running: '…', done: '✓' } as const;

/** First-run setup, shown in place of the roster until GeniusBar is paired. */
export function SetupPanel({ setup, onSetup }: { setup: SetupState; onSetup: () => void }) {
  return (
    <section className="setup" aria-label="Setup">
      <p>GeniusBar needs to connect to agent-comms on this Mac.</p>
      <ol>
        {SETUP_STEPS.map(({ step, label }) => (
          <li key={step} className={setup.steps[step]}>
            <span aria-hidden="true">{MARK[setup.steps[step]]}</span> {label}
          </li>
        ))}
      </ol>
      {setup.error && <p className="error small" role="alert">{setup.error}</p>}
      <button type="button" onClick={onSetup} disabled={setup.running}>
        {setup.running ? 'Setting up…' : setup.error ? 'Try again' : 'Set up'}
      </button>
    </section>
  );
}

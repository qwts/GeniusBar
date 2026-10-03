import { describeExisting, SETUP_STEPS, type ExistingServices, type SetupState } from '../model/setup';

const MARK = { pending: '○', running: '…', done: '✓' } as const;

/**
 * First-run setup, shown in place of the roster until GeniusBar is paired.
 * When another install's broker or daemon has a plist (Homebrew's), setup
 * says so and offers to move them over, or to keep them as they are (#41).
 */
export function SetupPanel({ setup, onSetup, existing }: {
  setup: SetupState;
  onSetup: (migrate?: boolean) => void;
  existing?: ExistingServices | null;
}) {
  const found = describeExisting(existing);
  return (
    <section className="setup" aria-label="Setup">
      <p>Let’s connect GeniusBar to your account.</p>
      <ol>
        {SETUP_STEPS.map(({ step, label }) => (
          <li key={step} className={setup.steps[step]}>
            <span aria-hidden="true">{MARK[setup.steps[step]]}</span> {label}
          </li>
        ))}
      </ol>
      {found && !setup.running && (
        <p className="small" role="note">
          {found} is already installed. GeniusBar can take over its services, keeping your agents, messages and
          pairings. Stopped services are moved without trying to stop them again. If that fails, previously
          running services are started again. Or keep the existing services and continue setup.
        </p>
      )}
      {setup.error && <p className="error small" role="alert">{setup.error}</p>}
      {found ? (
        <div className="detail-actions">
          <button type="button" onClick={() => onSetup(false)} disabled={setup.running}>Keep them</button>
          <button type="button" onClick={() => onSetup(true)} disabled={setup.running}>
            {setup.running ? 'Setting up…' : 'Move to GeniusBar'}
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => onSetup()} disabled={setup.running}>
          {setup.running ? 'Setting up…' : setup.error ? 'Try again' : 'Set up'}
        </button>
      )}
    </section>
  );
}

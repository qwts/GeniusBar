import { useId, useState } from 'react';
import { displayName, type CensusRow } from '../model/census';
import { canLaunch, type LaunchState } from '../model/launch';
import type { LaunchApi } from '../useLaunch';

interface LaunchFormProps {
  launcher: LaunchApi;
  /** Accounts and harnesses seen in the census, offered as suggestions. */
  accounts: readonly string[];
  harnesses: readonly string[];
  /** Launch this existing soul; without it, the form launches a package. */
  soul?: CensusRow;
}

export function LaunchStatus({ state }: { state: LaunchState }) {
  switch (state.phase) {
    case 'idle':
      return null;
    case 'requesting':
      return <p className="muted small" role="status">Requesting launch…</p>;
    case 'pending':
      return (
        <p className="muted small" role="status">
          Waiting for the daemon to report <span className="selectable">({state.requestId})</span>.
          {state.note && <span className="block">{state.note}</span>}
        </p>
      );
    case 'launched':
      return (
        <p className="small" role="status">
          Launched{state.agentId && <> as <span className="selectable">{state.agentId}</span></>}.
        </p>
      );
    case 'failed':
      return (
        <p className="error small" role="alert">
          Launch failed: {state.detail ?? 'the daemon reported no details.'}
        </p>
      );
    case 'error':
      return <p className="error small" role="alert">{state.text}</p>;
  }
}

/**
 * Launch form for an existing soul or a soul package. One launch at a time;
 * the result stays on screen and is never retried by the app.
 */
export function LaunchForm({ launcher, accounts, harnesses, soul }: LaunchFormProps) {
  const [account, setAccount] = useState(soul?.account ?? (accounts.length === 1 ? accounts[0] : ''));
  const [packagePath, setPackagePath] = useState('');
  const [harness, setHarness] = useState(soul?.harness ?? '');
  const [name, setName] = useState('');
  // The launcher is shared: show its result only in the form that started it.
  const [started, setStarted] = useState(false);
  const ids = useId();
  const ready = canLaunch(launcher.state);
  const what = soul ? displayName(soul) : 'a soul package';

  return (
    <form
      className="launch"
      aria-label={`Launch ${what}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setStarted(true);
        void launcher.launch({
          account,
          target: soul ? { soul: soul.agentId } : { package: packagePath },
          harness,
          name,
        });
      }}
    >
      <datalist id={`${ids}-accounts`}>{accounts.map((a) => <option key={a} value={a} />)}</datalist>
      <datalist id={`${ids}-harnesses`}>{harnesses.map((h) => <option key={h} value={h} />)}</datalist>
      <label>
        <span>Account</span>
        <input value={account} readOnly={Boolean(soul)} list={`${ids}-accounts`} onChange={(e) => setAccount(e.target.value)} />
      </label>
      {!soul && (
        <label>
          <span>Package</span>
          <input value={packagePath} placeholder="Path in that account" onChange={(e) => setPackagePath(e.target.value)} />
        </label>
      )}
      <label>
        <span>Harness</span>
        <input value={harness} list={`${ids}-harnesses`} onChange={(e) => setHarness(e.target.value)} />
      </label>
      <label>
        <span>Name</span>
        <input value={name} placeholder="Optional" onChange={(e) => setName(e.target.value)} />
      </label>
      {started ? <LaunchStatus state={launcher.state} />
        : !ready && <p className="muted small">Another launch is still waiting for its result.</p>}
      <div className="detail-actions">
        <button type="submit" disabled={!ready}>Launch</button>
      </div>
    </form>
  );
}

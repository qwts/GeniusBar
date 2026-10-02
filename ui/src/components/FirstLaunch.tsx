import { useId, useState } from 'react';
import { canLaunch } from '../model/launch';
import type { LaunchApi } from '../useLaunch';
import { LaunchStatus } from './LaunchForm';

/** The starter soul the app ships, from the shell's `starter_soul`. */
export interface Starter {
  package: string;
  account: string;
  name: string;
  /** The soul's preference order; the first is its default. */
  harnesses: readonly string[];
}

/**
 * The empty roster's one-click start (R4): launches the bundled starter
 * soul with its default harness, which the owner may change first.
 */
export function FirstLaunch({ starter, launcher }: { starter: Starter; launcher: LaunchApi }) {
  const [harness, setHarness] = useState(starter.harnesses[0] ?? '');
  const [started, setStarted] = useState(false);
  const ids = useId();
  const ready = canLaunch(launcher.state) && harness.trim() !== '';
  return (
    <form
      className="first-launch"
      aria-label="Launch your first soul"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setStarted(true);
        void launcher.launch({ account: starter.account, target: { package: starter.package }, harness, name: starter.name });
      }}
    >
      <p>No souls yet. Start with {starter.name}, a friendly first soul you can chat with.</p>
      <datalist id={`${ids}-harnesses`}>{starter.harnesses.map((h) => <option key={h} value={h} />)}</datalist>
      <label>
        <span>Harness</span>
        <input value={harness} list={`${ids}-harnesses`} onChange={(e) => setHarness(e.target.value)} />
      </label>
      {started && <LaunchStatus state={launcher.state} />}
      <div className="detail-actions">
        <button type="submit" disabled={!ready}>Launch your first soul</button>
      </div>
    </form>
  );
}

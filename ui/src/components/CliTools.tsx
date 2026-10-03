import { useState } from 'react';

export type ToolState = 'absent' | 'installed' | 'stale' | 'other';
export interface ToolsStatus {
  dir: string;
  tools: { name: string; state: ToolState; target?: string }[];
  /** Whether a new terminal finds `dir`, and the profile GeniusBar added it to. */
  path?: { onPath: boolean; profile: string | null };
}
export interface CliToolsApi {
  status: () => Promise<ToolsStatus>;
  install: (replace: string[]) => Promise<ToolsStatus>;
  uninstall: () => Promise<ToolsStatus>;
}

const errorText = (e: unknown, fallback: string) => {
  const message = (e as { message?: unknown })?.message;
  return typeof message === 'string' && message ? message : fallback;
};

/**
 * "Command-line tools" (#41): puts the bundled agent-bot and agent-comms on
 * PATH, like VS Code's `code` command, so an agent GeniusBar did not start
 * can join without Homebrew. Another copy already there is shown and only
 * replaced after the user says so; Uninstall puts it back.
 */
export function CliTools({ api }: { api: CliToolsApi }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ToolsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<ToolsStatus>, fallback: string) => {
    setBusy(true);
    setError(null);
    try { setStatus(await action()); } catch (e) { setError(errorText(e, fallback)); } finally { setBusy(false); }
  };

  if (!open) {
    return (
      <button type="button" className="link" onClick={() => { setOpen(true); void run(api.status, 'Could not check the command-line tools.'); }}>
        Command-line tools…
      </button>
    );
  }
  const others = status?.tools.filter((tool) => tool.state === 'other') ?? [];
  const ours = status?.tools.some((tool) => tool.state === 'installed' || tool.state === 'stale') ?? false;
  const complete = status?.tools.every((tool) => tool.state === 'installed') ?? false;
  return (
    <div className="confirm" role="group" aria-label="Command-line tools">
      <p className="small">
        Put <code>agent-bot</code> and <code>agent-comms</code> on your PATH so agents you start yourself can join.
        {status && <> They go in <code>{status.dir}</code>.</>}
      </p>
      {status?.path?.profile && (
        <p className="small">Added to your PATH in <code>{status.path.profile}</code>. Open a new terminal to use them.</p>
      )}
      {status?.path && !status.path.onPath && status.tools.some((tool) => tool.state === 'installed') && (
        <p className="small">Add <code>{status.dir}</code> to your PATH so a terminal finds them.</p>
      )}
      {status && (
        <ul className="small">
          {status.tools.map((tool) => (
            <li key={tool.name}>
              <code>{tool.name}</code>{' '}
              {tool.state === 'installed' && 'installed from GeniusBar'}
              {tool.state === 'stale' && 'installed from an older copy of GeniusBar'}
              {tool.state === 'absent' && 'not installed'}
              {tool.state === 'other' && <>already there: <code>{tool.target}</code></>}
            </li>
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <p className="small">
          Installing replaces {others.map((tool) => tool.name).join(' and ')}. The current one is set aside, and Uninstall puts it back.
        </p>
      )}
      {error && <p className="error small" role="alert">{error}</p>}
      <div className="detail-actions">
        <button type="button" disabled={busy} onClick={() => setOpen(false)}>Close</button>
        {ours && (
          <button type="button" disabled={busy} onClick={() => void run(api.uninstall, 'Could not uninstall the command-line tools.')}>
            Uninstall
          </button>
        )}
        {status && !complete && (
          <button type="button" disabled={busy}
            onClick={() => void run(() => api.install(others.map((tool) => tool.name)), 'Could not install the command-line tools.')}>
            {busy ? 'Installing…' : others.length ? 'Replace and install' : 'Install'}
          </button>
        )}
      </div>
    </div>
  );
}

import { credentialNote, healthHeader, type ConnectionSnapshot } from '../model/status';

/** Broker health above the roster, with the credential state beneath it. */
export function HealthHeader({ connection }: { connection: ConnectionSnapshot }) {
  const header = healthHeader(connection);
  const note = credentialNote(connection);
  return (
    <header className="health">
      <h1>GeniusBar</h1>
      <div role="status" aria-label={header.label}>
        <p className="health-title">
          <span className={`dot dot-${header.tone}`} aria-hidden="true" />
          {header.title}
        </p>
        {header.detail && <p className="small">{header.detail}</p>}
      </div>
      {note && <p className="note">{note}</p>}
    </header>
  );
}

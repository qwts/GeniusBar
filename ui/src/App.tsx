// The popup's root. Census, Dudles and chat arrive with the Node bridge
// (#7) and the R1 port (#8); until then the header reports that the
// bridge is not connected.
export function App() {
  return (
    <main className="popup">
      <header className="health">
        <h1>GeniusBar</h1>
        <p role="status">Not connected to agent-comms yet.</p>
      </header>
      <section className="roster" aria-label="Souls" />
    </main>
  );
}

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { useCensus } from './useCensus';
import { useChat } from './useChat';
import { useSetup } from './useSetup';
import './styles.css';

// The live app: census and connection come from the bridge.
function Live() {
  const { census, connection, refresh } = useCensus();
  const { setup, runSetup } = useSetup(() => { void refresh?.(); });
  const chat = useChat();
  return <App census={census} connection={connection} onRefresh={refresh} setup={setup} onSetup={() => { void runSetup(); }} chat={chat} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Live />
  </StrictMode>,
);

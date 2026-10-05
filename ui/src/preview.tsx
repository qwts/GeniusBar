// Dev-only preview (`npm run dev`, then /preview.html?mode=tray|window,
// plus &select=<agent id> to open a companion):
// the app on the fixed fixtures, without Tauri. Not part of the build.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App, type AppMode } from './App';
import type { CensusRow } from './model/census';
import { emptyChat, emptyComposer, mergeIncoming } from './model/chat';
import { inboxMessage, sampleCensus, sampleConnection } from './model/fixtures';
import type { ChatApi } from './useChat';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import './styles.css';

const row = (agentId: string, name: string, harness: string, parent: string | null, presence: CensusRow['presence'] = 'joined'): CensusRow =>
  ({ account: 'user', agentId, name, harness, parent, presence, unacked: 0, lastWake: null });

const census: CensusRow[] = [
  ...sampleCensus,
  row('agent_s', 'scout', 'claude', 'agent_p'),
  row('agent_q', 'quill', 'codex', 'agent_s'),
  row('agent_n', 'nova', 'claude', null),
  row('agent_b', 'beacon', 'codex', 'agent_n'),
  row('agent_e', 'ember', 'claude', 'agent_n', 'watching'),
];

const { state } = mergeIncoming(emptyChat, [
  inboxMessage('msg_1', 1, 'Morning! I finished the census refactor.\nWant me to open a PR?', { account: 'user', agentId: 'agent_p' }),
  inboxMessage('msg_2', 2, 'scout found two flaky tests; quill is on them.', { account: 'user', agentId: 'agent_p' }),
  inboxMessage('msg_3', 3, 'hello from agent_c', { account: 'user', agentId: 'agent_c' }),
]);

function Preview() {
  const params = new URLSearchParams(location.search);
  const mode = (params.get('mode') === 'window' ? 'window' : 'tray') as AppMode;
  const [composers, setComposers] = useState<ChatApi['composers']>({});
  const chat: ChatApi = {
    chat: state,
    composers,
    open: () => {},
    setDraft: (key, draft) => setComposers((c) => ({ ...c, [key]: { ...(c[key] ?? emptyComposer), draft } })),
    send: async () => {},
  };
  const app = <App mode={mode} select={params.get('select')} census={census} connection={{ ...sampleConnection, lastRefresh: new Date() }} chat={chat}
    onRefresh={() => {}} onRemoveServices={async () => {}} updates={{ status: { state: 'idle', version: null }, act: () => {} }}
    launcher={{ state: { phase: 'idle' }, launch: async () => {}, reset: () => {} }} />;
  // The tray popup is a fixed 384×560 window (tauri.conf.json).
  return mode === 'tray' ? <div style={{ width: 384, height: 560, margin: 16, outline: '1px solid #444' }}>{app}</div> : app;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Preview /></StrictMode>);

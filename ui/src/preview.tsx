// Dev-only preview (`npm run dev`, then /preview.html?mode=tray|window,
// plus &select=<agent id> to open a companion (its Audit log tab shows
// sampleAudit; its Details show samplePopulation and sampleColdWake, and
// &select=agent_s shows the expired sign-in banner; &select=agent_p shows
// luna on Auto-Pilot from sampleModes, its banner and the mode switch, and
// luna's Model row from sampleModels; its Launch… form has the Model field), or
// &open=<path> to open a package as Finder would):
// the app on the fixed fixtures, without Tauri. Not part of the build.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App, type AppMode } from './App';
import { AuditSourceContext, type AuditSource } from './components/AuditLog';
import { SoulSourceContext, type SoulSource } from './components/SoulNotices';
import type { CensusRow } from './model/census';
import { emptyChat, emptyComposer, mergeIncoming, type ChatState } from './model/chat';
import { inboxMessage, sampleApprovals, sampleAudit, sampleCensus, sampleColdWake, sampleConnection, sampleModels, sampleModes, samplePopulation, sampleSessionEntries } from './model/fixtures';
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

const { state: inbox } = mergeIncoming(emptyChat, [
  inboxMessage('msg_1', 1, 'Morning! I finished the census refactor.\nWant me to open a PR?', { account: 'user', agentId: 'agent_p' }),
  inboxMessage('msg_2', 2, 'scout found two flaky tests; quill is on them.', { account: 'user', agentId: 'agent_p' }),
  inboxMessage('msg_3', 3, 'hello from agent_c', { account: 'user', agentId: 'agent_c' }),
]);

// luna's chat also shows every entry kind (#122) without a broker.
const lunaKey = 'user/agent_p';
const luna = inbox.conversations[lunaKey];
const state: ChatState = {
  conversations: { ...inbox.conversations, [lunaKey]: { ...luna, entries: [...luna.entries, ...sampleSessionEntries] } },
  ids: new Set([...inbox.ids, ...sampleSessionEntries.map((e) => e.id)]),
};

// The Audit log tab (#122) reads the fixture rather than agent-bot.
const audit: AuditSource = async (agentId) => sampleAudit.filter((r) => agentId === null || r.agentId === agentId);

// Details rows and the sign-in banner (#122) read fixtures; changes land
// locally, as agent-bot would apply them once the owner approves.
const population = { ...samplePopulation };
const wakes = { ...sampleColdWake };
const modes = { ...sampleModes };
const models = { ...sampleModels };
const soulSource: SoulSource = {
  population: async (agentId) => population[agentId] ?? null,
  coldWake: async (agentId) => wakes[agentId] ?? null,
  setColdWake: async (agentId, on) => (wakes[agentId] = { on, lane: on ? 'acp' : null }),
  signedIn: async (_harness, agentId) => (agentId in population ? true : null),
  signIn: async (_harness, agentId) => {
    const record = population[agentId];
    if (record) population[agentId] = { ...record, harnessAuth: null };
    return true;
  },
  mode: async (agentId) => modes[agentId] ?? null,
  setMode: async (agentId, mode) => (modes[agentId] = mode),
  model: async (agentId) => models[agentId] ?? null,
  setModel: async (agentId, model) => (models[agentId] = { ...(models[agentId] ?? { available: null, listedAt: null }), model }),
};

function Preview() {
  const params = new URLSearchParams(location.search);
  const mode = (params.get('mode') === 'window' ? 'window' : 'tray') as AppMode;
  const [composers, setComposers] = useState<ChatApi['composers']>({});
  const [chatState, setChatState] = useState(state);
  // The menu's approval list (#85): two pending proposals, decided locally.
  const [records, setRecords] = useState(sampleApprovals);
  const chat: ChatApi = {
    chat: chatState,
    composers,
    open: () => {},
    setDraft: (key, draft) => setComposers((c) => ({ ...c, [key]: { ...(c[key] ?? emptyComposer), draft } })),
    send: async () => {},
    // Answers approvals locally, as agent-bot would once the owner confirms.
    resolve: async (key, entryId, decision) => setChatState((s) => {
      const c = s.conversations[key];
      if (!c) return s;
      const entries = c.entries.map((e) => (e.id === entryId && e.kind === 'approval_request' ? { ...e, status: decision } : e));
      return { ...s, conversations: { ...s.conversations, [key]: { ...c, entries } } };
    }),
    approvals: { records, local: new Map() },
    decide: async (proposalId) => setRecords((r) => r.filter((p) => p.proposalId !== proposalId)),
  };
  const opened = params.get('open');
  const app = <App mode={mode} select={params.get('select')} openedPackage={opened ? { id: 1, path: opened, checking: false, error: null } : undefined} census={census} connection={{ ...sampleConnection, lastRefresh: new Date() }} chat={chat}
    onRefresh={() => {}} onRemoveServices={async () => {}} updates={{ status: { state: 'idle', version: null }, act: () => {} }}
    launcher={{ state: { phase: 'idle' }, launch: async () => {}, reset: () => {} }} />;
  // The tray popup is a fixed 384×560 window (tauri.conf.json).
  return mode === 'tray' ? <div style={{ width: 384, height: 560, margin: 16, outline: '1px solid #444' }}>{app}</div> : app;
}

createRoot(document.getElementById('root')!).render(<StrictMode><AuditSourceContext.Provider value={audit}><SoulSourceContext.Provider value={soulSource}><Preview /></SoulSourceContext.Provider></AuditSourceContext.Provider></StrictMode>);

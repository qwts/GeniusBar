import { useEffect, useMemo, useState } from 'react';
import { HealthHeader } from './components/HealthHeader';
import { SetupPanel } from './components/SetupPanel';
import { SoulDetail } from './components/SoulDetail';
import { SoulRow } from './components/SoulRow';
import { conversationOf, emptyComposer, unreadOf } from './model/chat';
import { allSouls, buildSoulForest, findSoul, soulKey, type CensusRow } from './model/census';
import { needsSetup, type SetupState } from './model/setup';
import { disconnected, emptyRosterText, footerStatus, type ConnectionSnapshot } from './model/status';
import type { ChatApi } from './useChat';

interface AppProps {
  /** Census rows from the principal client; absent until the bridge (#7). */
  census?: readonly CensusRow[];
  connection?: ConnectionSnapshot;
  onRefresh?: () => void;
  /** Static renders (snapshots, probes): Dudles stay still, eyes open. */
  isStatic?: boolean;
  /** First-run setup; offered only when given and the connection needs it. */
  setup?: SetupState;
  onSetup?: () => void;
  /** Chat with souls (#17); without it the detail has no conversation. */
  chat?: ChatApi;
}

// Dudles stop blinking while the popup is hidden, as R1's did while the
// menu was closed.
function usePageHidden(): boolean {
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return hidden;
}

// Stable default so the forest memo does not rebuild on every render.
const NO_CENSUS: readonly CensusRow[] = [];

// The popup's root: health header, the census nested under parents, and
// the read-only detail for a selected soul.
export function App({ census = NO_CENSUS, connection = disconnected, onRefresh, isStatic = false, setup, onSetup, chat }: AppProps) {
  const forest = useMemo(() => buildSoulForest(census), [census]);
  const roster = useMemo(() => allSouls(forest), [forest]);
  // Selection holds the roster key and resolves against each census, so
  // the detail shows fresh values and closes if the soul disappears.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = selectedKey === null ? null : findSoul(forest, selectedKey);
  const paused = usePageHidden() || isStatic;
  // The open conversation is marked read, now and as messages arrive.
  const openKey = selected ? soulKey(selected) : null;
  const openChat = chat?.open;
  useEffect(() => {
    if (!openChat) return;
    openChat(openKey);
    return () => openChat(null);
  }, [openChat, openKey]);
  const unread = chat ? (soul: CensusRow) => unreadOf(chat.chat, soulKey(soul)) : undefined;
  const empty = emptyRosterText(connection);
  const footer = footerStatus(connection);
  const showSetup = Boolean(setup && onSetup && (setup.running || needsSetup(connection)));

  return (
    <main className="popup">
      <HealthHeader connection={connection} />
      {/* The setup panel replaces the roster, which has nothing true to say yet. */}
      {showSetup && setup && onSetup ? (
        <SetupPanel setup={setup} onSetup={onSetup} />
      ) : (
        <section className="roster" aria-label="Souls">
          {forest.length === 0
            ? empty && <p className="muted empty">{empty}</p>
            : forest.map((node) => (
                <SoulRow
                  key={soulKey(node.soul)}
                  node={node}
                  depth={0}
                  paused={paused}
                  unreadOf={unread}
                  onSelect={(soul) => setSelectedKey(soulKey(soul))}
                />
              ))}
        </section>
      )}
      {selected && (
        <SoulDetail
          soul={selected}
          roster={roster}
          paused={paused}
          chat={chat && openKey !== null ? {
            entries: conversationOf(chat.chat, openKey).entries,
            composer: chat.composers[openKey] ?? emptyComposer,
            onDraft: (draft) => chat.setDraft(openKey, draft),
            onSend: () => { void chat.send(openKey); },
          } : undefined}
          onDone={() => setSelectedKey(null)}
        />
      )}
      {(footer || onRefresh) && (
        <footer className="status">
          {footer && <span className={footer.isError ? 'error small' : 'muted small'}>{footer.text}</span>}
          {onRefresh && (
            <button type="button" className="link" onClick={onRefresh}>
              Refresh
            </button>
          )}
        </footer>
      )}
    </main>
  );
}

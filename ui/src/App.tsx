import { useEffect, useMemo, useState } from 'react';
import { FirstLaunch, type DevTools, type HarnessAuth, type Starter } from './components/FirstLaunch';
import { HealthHeader } from './components/HealthHeader';
import { LaunchForm } from './components/LaunchForm';
import { RemoveServices } from './components/RemoveServices';
import { SetupPanel } from './components/SetupPanel';
import { SoulDetail } from './components/SoulDetail';
import { SoulRow } from './components/SoulRow';
import { conversationOf, emptyComposer, unreadOf } from './model/chat';
import { allSouls, buildSoulForest, findSoul, soulKey, type CensusRow } from './model/census';
import { needsSetup, type SetupState } from './model/setup';
import { disconnected, emptyRosterText, footerStatus, type ConnectionSnapshot } from './model/status';
import type { ChatApi } from './useChat';
import type { LaunchApi } from './useLaunch';

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
  /** Launching souls and packages (#18); without it there is no Launch. */
  launcher?: LaunchApi;
  /** Removes GeniusBar's login services (#9); without it there is no action. */
  onRemoveServices?: () => Promise<void>;
  /** The bundled starter soul (R4), offered while the roster is empty. */
  starter?: Starter;
  /** Harness sign-in after the starter launches (ADR-0276). */
  harnessAuth?: HarnessAuth;
  /** Apple's command line tools, which the starter needs first (R4). */
  devTools?: DevTools;
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
export function App({ census = NO_CENSUS, connection = disconnected, onRefresh, isStatic = false, setup, onSetup, chat, launcher, onRemoveServices, starter, harnessAuth, devTools }: AppProps) {
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
  const [launchingPackage, setLaunchingPackage] = useState(false);
  // The first launch stays open from the click until closed, so its result
  // and sign-in remain after the new soul fills the roster.
  const [starterOpen, setStarterOpen] = useState(false);
  const canOfferStarter = Boolean(starter && launcher && connection.bridgeConnected && !connection.brokerUnreachable && !showSetup);
  const showStarter = canOfferStarter && (starterOpen || forest.length === 0);
  const launch = useMemo(() => launcher && {
    launcher,
    accounts: [...new Set(roster.map((s) => s.account))].sort(),
    harnesses: [...new Set(roster.flatMap((s) => (s.harness ? [s.harness] : [])))].sort(),
  }, [launcher, roster]);

  return (
    <main className="popup">
      <HealthHeader connection={connection} />
      {showStarter && starter && launcher && (
        <section className="detail" aria-label="Your first soul">
          <FirstLaunch starter={starter} launcher={launcher} auth={harnessAuth} devTools={devTools} onStart={() => setStarterOpen(true)} />
          {starterOpen && launcher.state.phase !== 'requesting' && launcher.state.phase !== 'pending' && (
            <div className="detail-actions">
              <button type="button" onClick={() => setStarterOpen(false)}>Close</button>
            </div>
          )}
        </section>
      )}
      {/* The setup panel replaces the roster, which has nothing true to say yet. */}
      {showSetup && setup && onSetup ? (
        <SetupPanel setup={setup} onSetup={onSetup} />
      ) : (
        <section className="roster" aria-label="Souls">
          {forest.length === 0
            ? !showStarter && empty && <p className="muted empty">{empty}</p>
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
          launch={launch}
          onDone={() => setSelectedKey(null)}
        />
      )}
      {launch && launchingPackage && !showSetup && (
        <section className="detail" aria-label="Launch a soul package">
          <h2>Launch a soul package</h2>
          <LaunchForm {...launch} />
          <div className="detail-actions">
            <button type="button" onClick={() => setLaunchingPackage(false)}>
              Close
            </button>
          </div>
        </section>
      )}
      {(footer || onRefresh || onRemoveServices || (launch && !showSetup)) && (
        <footer className="status">
          {footer && <span className={footer.isError ? 'error small' : 'muted small'}>{footer.text}</span>}
          {launch && !showSetup && !launchingPackage && (
            <button type="button" className="link" onClick={() => { setSelectedKey(null); setLaunchingPackage(true); }}>
              Launch package…
            </button>
          )}
          {onRemoveServices && !setup?.running && <RemoveServices onRemove={onRemoveServices} />}
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

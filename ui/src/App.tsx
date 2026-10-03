import { useEffect, useMemo, useState } from 'react';
import { FirstLaunch, type DevTools, type HarnessAuth, type Starter } from './components/FirstLaunch';
import { HealthHeader } from './components/HealthHeader';
import { LaunchForm } from './components/LaunchForm';
import { CliTools, type CliToolsApi } from './components/CliTools';
import { RemoveServices } from './components/RemoveServices';
import { SetupPanel } from './components/SetupPanel';
import { SoulDetail } from './components/SoulDetail';
import { SoulRow } from './components/SoulRow';
import { UpdateNotice } from './components/UpdateNotice';
import { conversationOf, emptyComposer, unreadOf } from './model/chat';
import { allSouls, buildSoulForest, findSoul, soulKey, type CensusRow } from './model/census';
import { needsSetup, type ExistingServices, type SetupState } from './model/setup';
import { disconnected, emptyRosterText, footerStatus, type ConnectionSnapshot } from './model/status';
import { updateNotice } from './model/updates';
import type { ChatApi } from './useChat';
import type { LaunchApi } from './useLaunch';
import type { UpdateApi } from './useUpdates';

interface AppProps {
  /** Census rows from the principal client; absent until the bridge (#7). */
  census?: readonly CensusRow[];
  connection?: ConnectionSnapshot;
  onRefresh?: () => void;
  /** Static renders (snapshots, probes): Dudles stay still, eyes open. */
  isStatic?: boolean;
  /** First-run setup; offered only when given and the connection needs it. */
  setup?: SetupState;
  onSetup?: (migrate?: boolean) => void;
  /** Another install's broker and daemon, which setup offers to move over (#41). */
  existingServices?: ExistingServices | null;
  /** Installs agent-bot and agent-comms on PATH (#41). */
  cliTools?: CliToolsApi;
  /** Chat with souls (#17); without it the detail has no conversation. */
  chat?: ChatApi;
  /** Launching souls and packages (#18); without it there is no Launch. */
  launcher?: LaunchApi;
  /** A `.soul` opened in Finder, validated by the Rust shell. */
  openedPackage?: { id: number; path: string; checking: boolean; error: string | null };
  /** Removes GeniusBar's login services (#9); without it there is no action. */
  onRemoveServices?: () => Promise<void>;
  /** The bundled starter soul (R4), offered while the roster is empty. */
  starter?: Starter;
  /** Harness sign-in after the starter launches (ADR-0276). */
  harnessAuth?: HarnessAuth;
  /** Apple's command line tools, which the starter needs first (R4). */
  devTools?: DevTools;
  /** Update status and action (#34); without it the popup stays quiet. */
  updates?: UpdateApi;
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
export function App({ census = NO_CENSUS, connection = disconnected, onRefresh, isStatic = false, setup, onSetup, chat, launcher, openedPackage, onRemoveServices, starter, harnessAuth, devTools, updates, existingServices, cliTools }: AppProps) {
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
  // A Finder-opened package fills the form until it is closed; after that a
  // manual launch starts empty rather than reusing its path and error.
  const [dismissedPackage, setDismissedPackage] = useState<number | null>(null);
  const activePackage = openedPackage && openedPackage.id !== dismissedPackage ? openedPackage : undefined;
  useEffect(() => {
    if (openedPackage) {
      setSelectedKey(null);
      setLaunchingPackage(true);
    }
  }, [openedPackage?.id]);
  // The first launch stays open from the click until closed, so its result
  // and sign-in remain after the new soul fills the roster.
  const [starterOpen, setStarterOpen] = useState(false);
  const canOfferStarter = Boolean(starter && launcher && connection.bridgeConnected && !connection.brokerUnreachable && !showSetup);
  // The footer offers a check when the update line has nothing to say, so
  // the panel carries the whole update flow when there is no tray (#34).
  const canCheckUpdates = Boolean(updates && !updateNotice(updates.status) && updates.status.state !== 'disabled');
  const showStarter = canOfferStarter && (starterOpen || forest.length === 0);
  const launch = useMemo(() => launcher && {
    launcher,
    accounts: [...new Set(roster.map((s) => s.account))].sort(),
    harnesses: [...new Set(roster.flatMap((s) => (s.harness ? [s.harness] : [])))].sort(),
  }, [launcher, roster]);

  return (
    <main className="popup">
      <HealthHeader connection={connection} />
      {updates && <UpdateNotice status={updates.status} onAction={updates.act} />}
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
        <SetupPanel setup={setup} onSetup={onSetup} existing={existingServices} />
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
          <LaunchForm key={activePackage?.id ?? 'manual'} {...launch}
            initialPackagePath={activePackage?.path}
            checkingPackage={activePackage?.checking}
            packageError={activePackage?.error} />
          <div className="detail-actions">
            <button type="button" onClick={() => {
              setLaunchingPackage(false);
              if (openedPackage) setDismissedPackage(openedPackage.id);
            }}>
              Close
            </button>
          </div>
        </section>
      )}
      {(footer || onRefresh || onRemoveServices || cliTools || (launch && !showSetup) || canCheckUpdates) && (
        <footer className="status">
          {footer && <span className={footer.isError ? 'error small' : 'muted small'}>{footer.text}</span>}
          {canCheckUpdates && (
            <button type="button" className="link" onClick={() => updates?.act()}>
              Check for Updates…
            </button>
          )}
          {launch && !showSetup && !launchingPackage && (
            <button type="button" className="link" onClick={() => { setSelectedKey(null); setLaunchingPackage(true); }}>
              Launch package…
            </button>
          )}
          {cliTools && <CliTools api={cliTools} />}
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

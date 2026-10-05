import { useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { FooterMenu } from './components/FooterMenu';
import { CompanionSession, InfoButton } from './components/CompanionSession';
import { CompanionWindow, Desktop } from './components/Desktop';
import { FirstLaunch, type DevTools, type HarnessAuth, type Starter } from './components/FirstLaunch';
import { FleetList, type Hiding } from './components/FleetList';
import { HealthHeader } from './components/HealthHeader';
import { LaunchForm } from './components/LaunchForm';
import { MenuBar } from './components/MenuBar';
import { CliTools, type CliToolsApi } from './components/CliTools';
import { RemoveServices } from './components/RemoveServices';
import { SetupPanel } from './components/SetupPanel';
import { UpdateNotice } from './components/UpdateNotice';
import { I18nProvider, LANGS, useI18n, type Lang } from './lib/i18n';
import { conversationOf, emptyComposer, unreadOf } from './model/chat';
import { allSouls, buildSoulForest, findSoul, soulKey, type CensusRow } from './model/census';
import { needsSetup, type ExistingServices, type SetupState } from './model/setup';
import { disconnected, emptyRosterText, footerStatus, healthHeader, type ConnectionSnapshot } from './model/status';
import { updateNotice } from './model/updates';
import { layoutActions, useLayout } from './state/layout';
import { usePreferences } from './state/preferences';
import { DefaultHarness } from './components/DefaultHarness';
import type { ChatApi } from './useChat';
import type { LaunchApi } from './useLaunch';
import type { UpdateApi } from './useUpdates';

/** The tray's popup, or `--window`'s desktop; the shell picks (app_mode). */
export type AppMode = 'tray' | 'window';

interface AppProps {
  mode?: AppMode;
  /** Census rows from the principal client; absent until the bridge (#7). */
  census?: readonly CensusRow[];
  connection?: ConnectionSnapshot;
  onRefresh?: () => void;
  /** Static renders (snapshots, probes): Dudles stay still, eyes open. */
  isStatic?: boolean;
  /** Opens this soul's detail (a roster key), for `--snapshot-detail`. */
  select?: string | null;
  /** First-run setup; offered only when given and the connection needs it. */
  setup?: SetupState;
  onSetup?: (migrate?: boolean) => void;
  existingServices?: ExistingServices | null;
  cliTools?: CliToolsApi;
  /** Chat with souls (#17); without it the session has no conversation. */
  chat?: ChatApi;
  /** Launching souls and packages (#18); without it there is no Launch. */
  launcher?: LaunchApi;
  /**
   * A `.soul` opened in Finder, validated by the Rust shell. `agentId` names
   * the installed soul it is (agent-bot `soul locate`, #80): that companion
   * opens instead of a new launch.
   */
  openedPackage?: { id: number; path: string; checking: boolean; error: string | null; agentId?: string };
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

export function App(props: AppProps) {
  return (
    <I18nProvider>
      <Shell {...props} />
    </I18nProvider>
  );
}

const footerIcon = 'rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground';

function LanguageSelect() {
  const { lang, setLang, t } = useI18n();
  return (
    <select aria-label={t('language')} value={lang} onChange={(e) => setLang(e.target.value as Lang)}
      className="h-6 w-[76px] rounded border border-input bg-transparent px-1.5 text-[11px] text-foreground">
      {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
    </select>
  );
}

// The GeniusBar menu (the tray popup's content, and the toolbar popover in
// window mode) and, from it, one companion's session.
function Shell({ mode = 'tray', census = NO_CENSUS, connection = disconnected, onRefresh, isStatic = false, select = null, setup, onSetup, chat, launcher, openedPackage, onRemoveServices, starter, harnessAuth, devTools, updates, existingServices, cliTools }: AppProps) {
  const { t } = useI18n();
  const forest = useMemo(() => buildSoulForest(census), [census]);
  const roster = useMemo(() => allSouls(forest), [forest]);
  // Selection holds the roster key and resolves against each census, so
  // the session shows fresh values and closes if the soul disappears.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [metricsRefresh, setMetricsRefresh] = useState(0);
  const selected = selectedKey === null ? null : findSoul(forest, selectedKey);
  useEffect(() => { if (select !== null) setSelectedKey(select); }, [select]);
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
  // Window mode's menu is a popover; it opens itself when it has news.
  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState<'cli' | 'remove' | null>(null);
  // An installed soul opened from Finder is that companion, never a new
  // launch (#80); one not in the roster yet keeps the form, and the daemon
  // relaunches it rather than spawning another.
  const openedSoul = openedPackage?.agentId ? findSoul(forest, openedPackage.agentId) : null;
  useEffect(() => {
    if (!openedPackage) return;
    if (openedSoul) {
      setLaunchingPackage(false);
      setDismissedPackage(openedPackage.id);
      setSelectedKey(soulKey(openedSoul));
      setMenuOpen(false);
      return;
    }
    setSelectedKey(null);
    setLaunchingPackage(true);
    setMenuOpen(true);
  }, [openedPackage?.id, openedSoul && soulKey(openedSoul)]);
  // The first launch stays open from the click until closed, so its result
  // and sign-in remain after the new soul fills the roster.
  const [starterOpen, setStarterOpen] = useState(false);
  const canOfferStarter = Boolean(starter && launcher && connection.bridgeConnected && !connection.brokerUnreachable && !showSetup);
  // The footer offers a check when the update line has nothing to say, so
  // the panel carries the whole update flow when there is no tray (#34).
  const canCheckUpdates = Boolean(updates && !updateNotice(updates.status) && updates.status.state !== 'disabled');
  const showStarter = canOfferStarter && (starterOpen || forest.length === 0);
  const canLaunchPackage = Boolean(launcher && !showSetup && !launchingPackage);
  const launchPackage = () => { setSelectedKey(null); setLaunchingPackage(true); };
  useEffect(() => { if (showSetup || showStarter) setMenuOpen(true); }, [showSetup, showStarter]);
  const { defaultHarness } = usePreferences();
  const launch = useMemo(() => launcher && {
    launcher,
    accounts: [...new Set(roster.map((s) => s.account))].sort(),
    harnesses: [...new Set(roster.flatMap((s) => (s.harness ? [s.harness] : [])))].sort(),
    defaultHarness,
  }, [launcher, roster, defaultHarness]);
  const layout = useLayout();

  const open = (soul: CensusRow) => {
    setSelectedKey(soulKey(soul));
    setMenuOpen(false);
  };

  const session = selected && (
    <CompanionSession
      soul={selected}
      forest={forest}
      roster={roster}
      paused={paused}
      metricsRefresh={metricsRefresh}
      chat={chat && openKey !== null ? {
        entries: conversationOf(chat.chat, openKey).entries,
        composer: chat.composers[openKey] ?? emptyComposer,
        onDraft: (draft) => chat.setDraft(openKey, draft),
        onSend: () => { void chat.send(openKey); },
      } : undefined}
      launch={launch}
      onOpen={open}
      onClose={() => setSelectedKey(null)}
      showBack={mode === 'tray'}
    />
  );

  const menu = (hiding?: Hiding) => (
    <>
      <HealthHeader connection={connection} />
      {updates && <UpdateNotice status={updates.status} onAction={updates.act} />}
      {showStarter && starter && launcher && (
        <section className="panel" aria-label={t('firstCompanion')}>
          <FirstLaunch starter={starter} launcher={launcher} auth={harnessAuth} devTools={devTools} onStart={() => setStarterOpen(true)} />
          {starterOpen && launcher.state.phase !== 'requesting' && launcher.state.phase !== 'pending' && (
            <div className="detail-actions">
              <button type="button" onClick={() => setStarterOpen(false)}>{t('close')}</button>
            </div>
          )}
        </section>
      )}
      {/* The setup panel replaces the fleet, which has nothing true to say yet. */}
      {showSetup && setup && onSetup ? (
        <SetupPanel setup={setup} onSetup={onSetup} existing={existingServices} />
      ) : (
        <FleetList forest={forest} paused={paused} unreadOf={unread} onOpen={open} hiding={hiding}
          empty={!showStarter && empty && <p className="muted empty">{empty}</p>} />
      )}
      {launch && !showSetup && <DefaultHarness harnesses={launch.harnesses} />}
      {launch && launchingPackage && !showSetup && (
        <section className="panel border-t" aria-label={t('launchPackageTitle')}>
          <h2>{t('launchPackageTitle')}</h2>
          <LaunchForm key={activePackage?.id ?? 'manual'} {...launch}
            initialPackagePath={activePackage?.path}
            checkingPackage={activePackage?.checking}
            packageError={activePackage?.error} />
          <div className="detail-actions mt-2">
            <button type="button" onClick={() => {
              setLaunchingPackage(false);
              if (openedPackage) setDismissedPackage(openedPackage.id);
            }}>
              {t('close')}
            </button>
          </div>
        </section>
      )}
      {/* The design's footer icon row; the rest sits in the ⋯ menu (Lovable audit §4, §7). */}
      <footer className="border-t border-border">
        <div className="flex items-center gap-1.5 p-2 text-xs">
          <LanguageSelect />
          {footer && <span className={`min-w-0 truncate ${footer.isError ? 'error small' : 'muted small'}`}>{footer.text}</span>}
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            {canLaunchPackage && (
              <button type="button" className={footerIcon} aria-label={t('launchPackage')} title={t('launchPackage')} onClick={launchPackage}>
                <Plus className="size-3.5" aria-hidden />
              </button>
            )}
            {(canCheckUpdates || canLaunchPackage || cliTools || onRemoveServices || onRefresh) && (
              <FooterMenu items={[
                canCheckUpdates && { label: t('checkUpdates'), run: () => updates?.act() },
                canLaunchPackage && { label: t('launchPackage'), run: launchPackage },
                cliTools && { label: t('cli.action'), run: () => setPanel('cli') },
                (onRefresh || (onRemoveServices && !setup?.running)) && 'separator',
                onRefresh && { label: t('refresh'), run: () => { setMetricsRefresh((value) => value + 1); onRefresh(); } },
                onRemoveServices && !setup?.running && { label: t('remove.action'), run: () => setPanel('remove'), destructive: true },
              ]} />
            )}
          </span>
        </div>
        {panel === 'cli' && cliTools && (
          <div className="border-t border-border px-3 py-2"><CliTools api={cliTools} startOpen onClose={() => setPanel(null)} /></div>
        )}
        {panel === 'remove' && onRemoveServices && (
          <div className="border-t border-border px-3 py-2"><RemoveServices onRemove={onRemoveServices} startConfirming onClose={() => setPanel(null)} /></div>
        )}
      </footer>
    </>
  );

  if (mode === 'tray') {
    // An open session keeps the update line above it, as the panel did before R6.
    return (
      <main className="gb flex h-full flex-col bg-popover">
        {session ? <>{updates && <UpdateNotice status={updates.status} onAction={updates.act} />}{session}</> : menu()}
      </main>
    );
  }

  const header = healthHeader(connection);
  // The menu is a popover, so its update line and an error footer also show
  // beside the GeniusBar button while it is closed.
  const update = updates ? updateNotice(updates.status) : null;
  const attention = update ? { text: update.text, isError: update.isError }
    : footer?.isError ? { text: footer.text, isError: true }
    : null;
  const unreadTotal = unread ? roster.reduce((sum, soul) => sum + unread(soul), 0) : 0;
  const notice = showSetup ? t('setupHint')
    : forest.length === 0 ? (showStarter ? t('setupHint') : empty ?? header.title)
    : null;
  return (
    <div className="gb flex h-full flex-col">
      <MenuBar open={menuOpen} onOpenChange={setMenuOpen} tone={header.tone} title={header.title}
        attention={attention} onReset={layoutActions.reset} unread={unreadTotal} forest={forest} paused={paused} onJump={open}>
        {menu({ hidden: layout.hidden, onToggle: layoutActions.setHidden, onToggleTeam: layoutActions.setTeamHidden, onShowAll: layoutActions.showAll })}
      </MenuBar>
      <Desktop forest={forest} layout={layout} paused={paused} unreadOf={unread} selectedKey={openKey} onOpen={open}
        notice={notice} onLaunch={launch && !showSetup ? () => { setSelectedKey(null); setLaunchingPackage(true); setMenuOpen(true); } : undefined}>
        {selected && session && (
          <CompanionWindow soul={selected} paused={paused} onClose={() => setSelectedKey(null)} actions={<InfoButton soul={selected} />}>{session}</CompanionWindow>
        )}
      </Desktop>
    </div>
  );
}

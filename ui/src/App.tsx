import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Volume2, VolumeX } from 'lucide-react';
import { ApprovalCounts, ApprovalsList } from './components/ApprovalsList';
import { ArchiveDialog, ArchivedNotice, liveArchiver, type Archiver } from './components/ArchiveDialog';
import { inApp, listSoulTemplates, liveComputerUse, popupVisible, soulStopSupported, stopSoul, type ComputerUseSwitch, type RemovedSoul } from './bridge';
import { FooterMenu } from './components/FooterMenu';
import { CompanionSession, ComputerUseContext, InfoButton, type SessionTab } from './components/CompanionSession';
import { CompanionWindow, Desktop } from './components/Desktop';
import { FloatingDudle, type Stopper } from './components/FloatingDudle';
import { FirstLaunch, type DevTools, type HarnessAuth, type Starter } from './components/FirstLaunch';
import { FleetList, type Hiding } from './components/FleetList';
import { HealthHeader } from './components/HealthHeader';
import { LaunchForm } from './components/LaunchForm';
import { LaunchModal } from './components/LaunchModal';
import { MenuBar } from './components/MenuBar';
import { CliTools, type CliToolsApi } from './components/CliTools';
import { RemoveServices } from './components/RemoveServices';
import { SetupPanel } from './components/SetupPanel';
import { UpdateNotice } from './components/UpdateNotice';
import { I18nProvider, LANGS, useI18n, type Lang } from './lib/i18n';
import { menuApprovals, workingCount } from './model/approvals';
import { canLaunch } from './model/launch';
import { conversationOf, emptyComposer, unreadOf } from './model/chat';
import { allSouls, buildSoulForest, displayName, findSoul, soulKey, type CensusRow } from './model/census';
import { computerUserName, floatingLead, floatingState } from './model/floating';
import type { SoulBadges } from './model/refresh';
import { useBadges } from './useBadges';
import { needsSetup, type ExistingServices, type SetupState } from './model/setup';
import { disconnected, emptyRosterText, footerStatus, healthHeader, type ConnectionSnapshot } from './model/status';
import { updateNotice } from './model/updates';
import { layoutActions, useLayout } from './state/layout';
import { usePreferences } from './state/preferences';
import { DefaultHarness } from './components/DefaultHarness';
import { defaultSandboxSource, SandboxProvider, useSandbox, type SandboxSource } from './components/Sandbox';
import { SandboxCard } from './components/SandboxCard';
import { SandboxChip } from './components/SandboxChip';
import { defaultIdentityAppsSource, IdentityAppsProvider, type IdentityAppsSource } from './components/IdentityApps';
import { IdentityAppsCard } from './components/IdentityAppsCard';
import type { ChatApi } from './useChat';
import type { LaunchApi } from './useLaunch';
import type { UpdateApi } from './useUpdates';
import { livePauser, usePause, type Pauser } from './usePause';
import type { TemplateLister } from './useSoulTemplates';
import { liveProfileSource, ProfileSourceContext, type ProfileSource } from './useSoulProfile';
import { useChimes, useSound } from './useSound';

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
  openedPackage?: {
    id: number; path: string; checking: boolean; error: string | null; agentId?: string;
    /** What the package's soul.json says, for prefilling the form (#120). */
    name?: string; preferredHarnesses?: string[]; description?: string;
    /** A copy of this companion's folder (#110): launched under a new name, it forks. */
    copyOf?: { name: string | null; agentId: string };
  };
  /** Opens the companion desktop window (#69); the popup's ⋯ menu offers it when given. */
  onOpenDesktop?: () => void;
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
  /** Desktop avatar badges (#122); the app reads agent-bot when absent. */
  badges?: SoulBadges;
  /** Shows the floating Dudle's button (off, as in the Lovable export); preview only for now. */
  floatingButton?: boolean;
  /** Archiving souls (#94); the app uses agent-bot when absent. */
  archiver?: Archiver;
  /** The computer-use Stop (agent-bot `soul stop`); the app uses agent-bot when absent. */
  stopper?: Stopper;
  /** Pause all / Resume (agent-bot `soul pause`); the app uses agent-bot when absent. */
  pauser?: Pauser;
  /** The quick menu's "Toggle computer use" (agent-bot `soul computer-use`); the app uses agent-bot when absent. */
  computerUseSwitch?: ComputerUseSwitch;
  /** The launch form's soul templates (agent-bot `soul templates`, #65); the app uses agent-bot when absent. */
  templateLister?: TemplateLister;
  /** The Customize dialog's profiles (agent-bot `soul profile`, #64); the app uses agent-bot when absent. */
  profileSource?: ProfileSource;
  /** Whether the popup is showing, for the desktop window's chimes (#122); the app asks the shell when absent. */
  popupShowing?: () => Promise<boolean>;
  /** Sandboxing (agent-bot `sandbox`, #66); the app uses agent-bot when absent, null hides it. */
  sandboxSource?: SandboxSource | null;
  /** GitHub identities (agent-bot `identity apps`, #67); the app uses agent-bot when absent, null hides them. */
  identityAppsSource?: IdentityAppsSource | null;
}

const liveStopper: Stopper = { supported: () => soulStopSupported(), stop: (agentId) => stopSoul(agentId) };

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
  // The Details rows' computer-use switch (#122); the quick menu's comes as a prop in Shell.
  const computerUse = props.computerUseSwitch ?? (inApp() && !props.isStatic ? liveComputerUse : null);
  const profiles = props.profileSource ?? (inApp() && !props.isStatic ? liveProfileSource : null);
  const sandbox = props.sandboxSource === undefined ? defaultSandboxSource(props.isStatic) : props.sandboxSource;
  const identities = props.identityAppsSource === undefined ? defaultIdentityAppsSource(props.isStatic) : props.identityAppsSource;
  return (
    <I18nProvider>
      <ComputerUseContext.Provider value={computerUse}>
        <ProfileSourceContext.Provider value={profiles}>
          <SandboxProvider source={sandbox}>
            <IdentityAppsProvider source={identities}>
              <Shell {...props} />
            </IdentityAppsProvider>
          </SandboxProvider>
        </ProfileSourceContext.Provider>
      </ComputerUseContext.Provider>
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
function Shell({ mode = 'tray', census = NO_CENSUS, connection = disconnected, onRefresh, isStatic = false, select = null, setup, onSetup, chat, launcher, openedPackage, onOpenDesktop, onRemoveServices, starter, harnessAuth, devTools, updates, existingServices, cliTools, badges, floatingButton = false, archiver, stopper, pauser, computerUseSwitch, templateLister, popupShowing }: AppProps) {
  const { t } = useI18n();
  const sandbox = useSandbox();
  const forest = useMemo(() => buildSoulForest(census), [census]);
  const roster = useMemo(() => allSouls(forest), [forest]);
  // Selection holds the roster key and resolves against each census, so
  // the session shows fresh values and closes if the soul disappears.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [metricsRefresh, setMetricsRefresh] = useState(0);
  const selected = selectedKey === null ? null : findSoul(forest, selectedKey);
  useEffect(() => { if (select !== null) setSelectedKey(select); }, [select]);
  const pageHidden = usePageHidden();
  const paused = pageHidden || isStatic;
  // The open conversation is marked read, now and as messages arrive.
  const openKey = selected ? soulKey(selected) : null;
  const openChat = chat?.open;
  useEffect(() => {
    if (!openChat) return;
    openChat(openKey);
    return () => openChat(null);
  }, [openChat, openKey]);
  const unread = chat ? (soul: CensusRow) => unreadOf(chat.chat, soulKey(soul)) : undefined;
  // Every companion's pending proposals, from useChat's poll (#85).
  const chatApprovals = chat?.approvals;
  const waiting = useMemo(() => chatApprovals ? menuApprovals(chatApprovals.records, chatApprovals.local, roster) : [],
    [chatApprovals, roster]);
  const working = useMemo(() => workingCount(roster), [roster]);
  // Who has a proposal waiting, for the desktop's status dots (#122).
  const awaitingIds = useMemo(() => new Set(waiting.map((w) => w.agentId)), [waiting]);
  const { sound, setSound } = useSound();
  const decide = chat?.decide;
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
  // Only the tray popup opens the desktop; the desktop is already open.
  const openDesktop = mode === 'tray' ? onOpenDesktop : undefined;
  const launchPackage = () => { setSelectedKey(null); setLaunchingPackage(true); setMenuOpen(false); };
  useEffect(() => { if (showSetup || showStarter) setMenuOpen(true); }, [showSetup, showStarter]);
  const { defaultHarness } = usePreferences();
  const launch = useMemo(() => launcher && {
    launcher,
    accounts: [...new Set(roster.map((s) => s.account))].sort(),
    harnesses: [...new Set(roster.flatMap((s) => (s.harness ? [s.harness] : [])))].sort(),
    defaultHarness,
    // The census souls' harness model lists feed the Model field (#128).
    roster,
  }, [launcher, roster, defaultHarness]);
  const layout = useLayout();
  // Pause all / Resume (#122): the desktop's menu bar chip and quick action.
  // `fleet` is the companions' pause, not `paused` (the hidden page's).
  const fleet = usePause(mode === 'window' ? pauser ?? (inApp() && !isStatic ? livePauser : undefined) : undefined, !pageHidden);
  const toggleFleet = fleet.offered ? () => { void fleet.toggle(); } : undefined;
  // Archive (#94) and the desktop's comms / computer-use badges (#122).
  const archiveWith = archiver ?? (inApp() && !isStatic ? liveArchiver : undefined);
  const [archiving, setArchiving] = useState<CensusRow | null>(null);
  const [archivedText, setArchivedText] = useState<string | null>(null);
  const clearArchived = useCallback(() => setArchivedText(null), []);
  const badgeIds = useMemo(() => roster.filter((s) => s.presence !== 'left').map((s) => s.agentId), [roster]);
  const liveBadges = useBadges(badgeIds, !badges && mode === 'window' && inApp() && !isStatic);
  const onArchived = (soul: CensusRow, result: RemovedSoul) => {
    const name = displayName(soul);
    layoutActions.setHidden(soulKey(soul), false);
    setArchiving(null);
    if (selectedKey === soulKey(soul)) setSelectedKey(null);
    setArchivedText(result.comms === 'left' ? t('bar.archived', { name })
      : t('bar.archivedPending', { name, reason: result.comms.replace(/^not left: /, '') }));
    onRefresh?.();
  };
  const archiveUi = (
    <>
      {archiving && archiveWith && <ArchiveDialog soul={archiving} archiver={archiveWith} onCancel={() => setArchiving(null)} onArchived={onArchived} />}
      {archivedText && <ArchivedNotice text={archivedText} onDone={clearArchived} />}
    </>
  );

  const open = (soul: CensusRow) => {
    setSelectedKey(soulKey(soul));
    setMenuOpen(false);
  };
  // The floating Dudle's quick menu opens its lead on a given tab; the
  // session remounts so the tab applies even when it is already open.
  const [quick, setQuick] = useState<{ tab: SessionTab; n: number }>({ tab: 'chat', n: 0 });
  const openOn = (soul: CensusRow, tab: SessionTab) => {
    open(soul);
    setQuick((q) => ({ tab, n: q.n + 1 }));
  };
  const prompt = (soul: CensusRow) => {
    openOn(soul, 'chat');
    // After the window focuses its close button on mount.
    setTimeout(() => document.querySelector<HTMLTextAreaElement>('[role="tabpanel"] textarea')?.focus(), 50);
  };

  const session = selected && (
    <CompanionSession
      key={quick.n}
      initialTab={quick.n > 0 ? quick.tab : undefined}
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
        onResolve: chat.resolve && ((entryId, decision) => { void chat.resolve?.(openKey, entryId, decision); }),
      } : undefined}
      launch={launch}
      onOpen={open}
      onClose={() => setSelectedKey(null)}
      showBack={mode === 'tray'}
    />
  );

  const menu = (hiding?: Hiding) => (
    <>
      <HealthHeader connection={connection}><ApprovalCounts waiting={waiting.length} working={working} /></HealthHeader>
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
      <ApprovalsList items={waiting} paused={paused} onOpen={open}
        onDecide={decide && ((proposalId, decision) => { void decide(proposalId, decision); })} />
      {/* The setup panel replaces the fleet, which has nothing true to say yet. */}
      {showSetup && setup && onSetup ? (
        <SetupPanel setup={setup} onSetup={onSetup} existing={existingServices} />
      ) : (
        <FleetList forest={forest} paused={paused} unreadOf={unread} onOpen={open} hiding={hiding} onArchive={archiveWith && setArchiving}
          empty={!showStarter && empty && <p className="muted empty">{empty}</p>} />
      )}
      {launch && !showSetup && <DefaultHarness harnesses={launch.harnesses} />}
      {!showSetup && <SandboxCard />}
      {!showSetup && <IdentityAppsCard roster={roster} />}
      {/* The design's footer icon row; the rest sits in the ⋯ menu (Lovable audit §4, §7). */}
      <footer className="border-t border-border">
        <div className="flex items-center gap-1.5 p-2 text-xs">
          <button type="button" aria-label={t('sound')} aria-pressed={sound} onClick={() => setSound(!sound)} className="rounded p-1 text-muted-foreground hover:text-foreground">
            {sound ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
          </button>
          <LanguageSelect />
          {footer && <span className={`min-w-0 truncate ${footer.isError ? 'error small' : 'muted small'}`}>{footer.text}</span>}
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            {canLaunchPackage && (
              <button type="button" className={footerIcon} aria-label={t('launchPackage')} title={t('launchPackage')} onClick={launchPackage}>
                <Plus className="size-3.5" aria-hidden />
              </button>
            )}
            {(openDesktop || canCheckUpdates || canLaunchPackage || cliTools || onRemoveServices || onRefresh) && (
              <FooterMenu items={[
                openDesktop && { label: t('openDesktop'), run: openDesktop },
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

  const closeLaunch = () => {
    setLaunchingPackage(false);
    if (openedPackage) setDismissedPackage(openedPackage.id);
  };
  // A launch from the dialog closes it and opens the new companion (#116);
  // the session shows once the census lists it, and the next launch starts idle.
  const launched = (agentId: string | null) => {
    closeLaunch();
    launcher?.reset();
    if (agentId) { setSelectedKey(agentId); setMenuOpen(false); }
    onRefresh?.();
  };
  // Hiding the popup never leaves a finished dialog for its next opening.
  const launchPhase = launcher?.state.phase;
  useEffect(() => {
    if (pageHidden && launchingPackage && launchPhase === 'launched') closeLaunch();
  }, [pageHidden, launchingPackage, launchPhase]);
  // The design's launch dialog, over whichever mode is showing (Lovable 20.03.51).
  const launchModal = launch && launchingPackage && !showSetup && (
    <LaunchModal onClose={closeLaunch} busy={!canLaunch(launch.launcher.state)}>
      <LaunchForm key={activePackage?.id ?? 'manual'} {...launch}
        initialPackagePath={activePackage?.path}
        packageName={activePackage?.name}
        preferredHarnesses={activePackage?.preferredHarnesses}
        packageDescription={activePackage?.description}
        copyOf={activePackage?.copyOf}
        checkingPackage={activePackage?.checking}
        packageError={activePackage?.error}
        onCancel={closeLaunch}
        onLaunched={launched}
        listTemplates={templateLister ?? (inApp() && !isStatic ? listSoulTemplates : undefined)} />
    </LaunchModal>
  );

  // Sound cues (#122): "ask" on a new approval, "done" when a turn ends. The
  // desktop window yields to the popup while it shows, so each change chimes once.
  useChimes({ sound, waiting: waiting.length, busy: (badges ?? liveBadges).busy,
    yieldTo: mode === 'window' ? popupShowing ?? (inApp() && !isStatic ? popupVisible : undefined) : undefined });

  if (mode === 'tray') {
    // An open session keeps the update line above it, as the panel did before R6.
    return (
      <main className="gb flex h-full flex-col bg-popover">
        {session ? <>{updates && <UpdateNotice status={updates.status} onAction={updates.act} />}{session}</> : menu()}
        {launchModal}
        {archiveUi}
      </main>
    );
  }

  const header = healthHeader(connection, t);
  // The menu is a popover, so its update line and an error footer also show
  // beside the GeniusBar button while it is closed.
  const update = updates ? updateNotice(updates.status) : null;
  const attention = fleet.failure
    ? { text: t(fleet.failure.action === 'pause' ? 'pauseFailed' : 'resumeFailed', { message: fleet.failure.message }), isError: true }
    : update ? { text: update.text, isError: update.isError }
    : footer?.isError ? { text: footer.text, isError: true }
    : null;
  const shownBadges = badges ?? liveBadges;
  const unreadTotal = unread ? roster.reduce((sum, soul) => sum + unread(soul), 0) : 0;
  const notice = showSetup ? t('setupHint')
    : forest.length === 0 ? (showStarter ? t('setupHint') : empty ?? header.title)
    : null;
  return (
    <div className="gb flex h-full flex-col">
      <MenuBar open={menuOpen} onOpenChange={setMenuOpen} tone={header.tone} title={header.title}
        attention={attention} onReset={layoutActions.reset} unread={unreadTotal} approvals={waiting.length} forest={forest} paused={paused} onJump={open}
        fleetPaused={fleet.paused} onResume={toggleFleet}>
        {menu({ hidden: layout.hidden, onToggle: layoutActions.setHidden, onToggleTeam: layoutActions.setTeamHidden, onShowAll: layoutActions.showAll })}
      </MenuBar>
      <Desktop forest={forest} layout={layout} paused={paused} unreadOf={unread} selectedKey={openKey} onOpen={open}
        badges={shownBadges} onArchive={archiveWith && setArchiving} awaiting={awaitingIds} fleetPaused={fleet.paused}
        notice={notice} onLaunch={launch && !showSetup ? () => { setSelectedKey(null); setLaunchingPackage(true); } : undefined}>
        {selected && session && (
          // The sandbox chip is the design's title-bar pill; while agent-bot
          // resolves this soul it replaces the census's hardened pill.
          <CompanionWindow soul={sandbox.soul(selected.agentId) ? { ...selected, hardened: undefined } : selected}
            paused={paused} onClose={() => setSelectedKey(null)}
            actions={<><SandboxChip soul={selected} /><InfoButton soul={selected} /></>}>{session}</CompanionWindow>
        )}
      </Desktop>
      <FloatingDudle showButton={floatingButton} lead={floatingLead(forest, layout.hidden)} paused={paused}
        state={floatingState({ roster, approvals: waiting.length, busy: shownBadges.busy, computerUse: shownBadges.computerUse })}
        computerUser={computerUserName(roster, shownBadges.computerUse)}
        computerUse={shownBadges.computerUse} stopper={stopper ?? (inApp() && !isStatic ? liveStopper : undefined)}
        fleetPaused={fleet.paused} onTogglePause={toggleFleet}
        computerUseSwitch={computerUseSwitch ?? (inApp() && !isStatic ? liveComputerUse : undefined)}
        onPrompt={prompt} onHistory={(soul) => openOn(soul, 'audit')} />
      {launchModal}
      {archiveUi}
    </div>
  );
}

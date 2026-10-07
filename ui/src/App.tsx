import { useCallback, useEffect, useMemo, useState } from 'react';
import { History, Plus, Volume2, VolumeX, X } from 'lucide-react';
import { ApprovalCounts, ApprovalsList } from './components/ApprovalsList';
import { ArchiveDialog, ArchivedNotice, liveArchiver, type Archiver } from './components/ArchiveDialog';
import { inApp, listSoulTemplates, liveComputerUse, popupVisible, soulStopSupported, stopSoul, type ComputerUseSwitch, type RemovedSoul } from './bridge';
import { FooterMenu } from './components/FooterMenu';
import { CompanionSession, ComputerUseContext, InfoButton, type SessionTab } from './components/CompanionSession';
import { AuditWindow, CompanionWindow, Desktop } from './components/Desktop';
import { FloatingDudle, type Stopper } from './components/FloatingDudle';
import { FirstLaunch, type DevTools, type HarnessAuth, type Starter } from './components/FirstLaunch';
import { FleetList, liveState, type Hiding } from './components/FleetList';
import { HealthHeader, SetupHeader } from './components/HealthHeader';
import { LaunchForm } from './components/LaunchForm';
import { LaunchModal } from './components/LaunchModal';
import { MenuBar } from './components/MenuBar';
import { CliTools, type CliToolsApi } from './components/CliTools';
import { AuditLog } from './components/AuditLog';
import { FleetMode } from './components/FleetMode';
import { Select } from './components/Select';
import { useFleetMode } from './components/SoulNotices';
import { RemoveServices } from './components/RemoveServices';
import { SetupPanel } from './components/SetupPanel';
import { UpdateNotice } from './components/UpdateNotice';
import { actions, secondaryButton } from './components/ui';
import { I18nProvider, LANGS, useI18n, type Lang } from './lib/i18n';
import { menuApprovals, workingCount } from './model/approvals';
import { canLaunch } from './model/launch';
import { conversationOf, emptyComposer, unreadOf } from './model/chat';
import { allSouls, buildSoulForest, displayName, findSoul, soulKey, withHues, withRoles, type CensusRow } from './model/census';
import { computerUserName, floatingLead, floatingState } from './model/floating';
import type { SoulBadges } from './model/refresh';
import { useBadges } from './useBadges';
import { needsSetup, type ExistingServices, type SetupState } from './model/setup';
import { disconnected, emptyRosterText, footerStatus, healthHeader, type ConnectionSnapshot } from './model/status';
import { updateNotice, type UpdateStatus } from './model/updates';
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

/**
 * During setup the update line shows only when it reports a failure or asks
 * for an action (install, restart), so a fix stays reachable while setup is stuck.
 */
function setupUpdateShows(status: UpdateStatus, checked = false): boolean {
  const notice = updateNotice(status);
  return Boolean(notice && (notice.isError || notice.action)) || (checked && status.state === 'up-to-date');
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
// The setup footer's links (Lovable SetupPanel).
const setupLink = 'text-info hover:underline';

function LanguageSelect() {
  const { lang, setLang, t } = useI18n();
  return (
    <Select aria-label={t('language')} value={lang} onChange={(e) => setLang(e.target.value as Lang)}
      wrapperClassName="w-[76px] shrink-0" chevronClassName="right-1" className="h-6 pr-5 pl-1.5 text-[11px]">
      {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
    </Select>
  );
}

// The GeniusBar menu (the tray popup's content, and the toolbar popover in
// window mode) and, from it, one companion's session.
function Shell({ mode = 'tray', census = NO_CENSUS, connection = disconnected, onRefresh, isStatic = false, select = null, setup, onSetup, chat, launcher, openedPackage, onOpenDesktop, onRemoveServices, starter, harnessAuth, devTools, updates, existingServices, cliTools, badges, floatingButton = false, archiver, stopper, pauser, computerUseSwitch, templateLister, popupShowing }: AppProps) {
  const { t, lang } = useI18n();
  const sandbox = useSandbox();
  // The badges' population read also carries the hues souls declare (#64),
  // joined into the census here, before anything draws a Dudle.
  const badgeIds = useMemo(() => [...new Set(census.filter((s) => s.presence !== 'left').map((s) => s.agentId))], [census]);
  const liveBadges = useBadges(badgeIds, !badges && mode === 'window' && inApp() && !isStatic);
  const hues = (badges ?? liveBadges).hues;
  // The same read carries the roles souls declare (agent-bot-identity #535).
  const roles = (badges ?? liveBadges).roles;
  const hued = useMemo(() => withRoles(withHues(census, hues), roles), [census, hues, roles]);
  const forest = useMemo(() => buildSoulForest(hued), [hued]);
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
  // Who is mid-turn (daemon status `busy`), for the working faces.
  const busyIds = (badges ?? liveBadges).busy;
  const { sound, setSound } = useSound();
  const decide = chat?.decide;
  const empty = emptyRosterText(connection, t);
  const footer = footerStatus(connection, t, lang);
  const showSetup = Boolean(setup && onSetup && (setup.running || needsSetup(connection)));
  const [launchingPackage, setLaunchingPackage] = useState(false);
  // A Finder-opened package fills the form until it is closed; after that a
  // manual launch starts empty rather than reusing its path and error.
  const [dismissedPackage, setDismissedPackage] = useState<number | null>(null);
  const activePackage = openedPackage && openedPackage.id !== dismissedPackage ? openedPackage : undefined;
  // Window mode's menu is a popover; it opens itself when it has news.
  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState<'cli' | 'remove' | 'audit' | null>(null);
  // Window mode's Audit log is a desktop window (Lovable route /audit); the
  // tray keeps it as a panel in the popup, which is the whole app there.
  const [auditWindow, setAuditWindow] = useState(false);
  const openAudit = mode === 'window'
    ? () => { setAuditWindow(true); setMenuOpen(false); }
    : () => setPanel(panel === 'audit' ? null : 'audit');
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
  // Check for Updates… by hand: an up-to-date answer says so for a moment.
  const [checkedUpdates, setCheckedUpdates] = useState(false);
  const checkUpdates = () => { setCheckedUpdates(true); updates?.act(); };
  const updateState = updates?.status.state;
  useEffect(() => {
    if (!checkedUpdates || updateState === 'checking' || updateState === 'idle') return;
    const timer = setTimeout(() => setCheckedUpdates(false), updateState === 'up-to-date' ? 4000 : 0);
    return () => clearTimeout(timer);
  }, [checkedUpdates, updateState]);
  const showStarter = canOfferStarter && (starterOpen || forest.length === 0);
  const canLaunchPackage = Boolean(launcher && !showSetup && !launchingPackage);
  // Only the tray popup opens the desktop; the desktop is already open.
  const openDesktop = mode === 'tray' ? onOpenDesktop : undefined;
  // The launch dialog: soul templates first (Starter preselected), then a
  // Custom soul path. The footer + (#97) and the palette open it as "add a
  // companion"; the ⋯ menu keeps it as "Launch soul…" for a package.
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
  // The menu bar's Auto-Pilot banner and amber G (Lovable MenuBar): window mode only.
  const fleetMode = useFleetMode(mode === 'window' ? roster : NO_CENSUS);
  // Pause all / Resume (#122): the desktop's menu bar chip and quick action.
  // `fleet` is the companions' pause, not `paused` (the hidden page's).
  const fleet = usePause(mode === 'window' ? pauser ?? (inApp() && !isStatic ? livePauser : undefined) : undefined, !pageHidden);
  const toggleFleet = fleet.offered ? () => { void fleet.toggle(); } : undefined;
  // Archive (#94) and the desktop's comms / computer-use badges (#122).
  const archiveWith = archiver ?? (inApp() && !isStatic ? liveArchiver : undefined);
  const [archiving, setArchiving] = useState<CensusRow | null>(null);
  const [archivedText, setArchivedText] = useState<string | null>(null);
  const clearArchived = useCallback(() => setArchivedText(null), []);
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
      awaiting={awaitingIds}
      busy={busyIds}
    />
  );

  // The footer: the design's icon row, the rest in the ⋯ menu (Lovable audit
  // §4, §7). During setup the design's links are the whole footer (Check for
  // Updates…, Remove services…, Refresh); the language select and the ⋯ menu's
  // other actions (open the desktop, command-line tools) stay at its end.
  const refresh = onRefresh && (() => { setMetricsRefresh((value) => value + 1); onRefresh(); });
  const iconFooter = (inSetup: boolean) => (
    <footer className={inSetup ? undefined : 'border-t border-border'}>
      {inSetup ? (
        <div className="flex items-center justify-between gap-2 p-3 text-xs">
          {canCheckUpdates && <button type="button" className={setupLink} onClick={checkUpdates}>{t('checkUpdates')}</button>}
          {onRemoveServices && !setup?.running && <button type="button" className={setupLink} onClick={() => setPanel('remove')}>{t('remove.action')}</button>}
          {refresh && <button type="button" className={setupLink} onClick={refresh}>{t('refresh')}</button>}
          <span className="flex shrink-0 items-center gap-0.5">
            <LanguageSelect />
            {(openDesktop || cliTools) && (
              <FooterMenu items={[
                openDesktop && { label: t('openDesktop'), run: openDesktop },
                cliTools && { label: t('cli.action'), run: () => setPanel('cli') },
              ]} />
            )}
          </span>
        </div>
      ) : (
      <div className="flex items-center gap-1.5 p-2 text-xs">
        <FleetMode roster={roster} />
        <button type="button" aria-label={t('sound')} aria-pressed={sound} onClick={() => setSound(!sound)} className="rounded p-1 text-muted-foreground hover:text-foreground">
          {sound ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
        </button>
        <LanguageSelect />
        {/* Freshness sits in the G's title (window) and the health header; only a failure shows here. */}
        {footer?.isError && <span role="alert" className="min-w-0 truncate text-[11px] text-destructive">{footer.text}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <button type="button" className={footerIcon} aria-label={t('auditTitle')} title={t('auditTitle')}
            aria-pressed={mode === 'window' ? auditWindow : panel === 'audit'} onClick={openAudit}>
            <History className="size-3.5" aria-hidden />
          </button>
          {canLaunchPackage && (
            <button type="button" className={footerIcon} aria-label={t('launchCompanion')} title={t('launchCompanion')} onClick={launchPackage}>
              <Plus className="size-3.5" aria-hidden />
            </button>
          )}
          {(openDesktop || canLaunchPackage || cliTools || canCheckUpdates || onRemoveServices || onRefresh) && (
            <FooterMenu items={[
              openDesktop && { label: t('openDesktop'), run: openDesktop },
              canCheckUpdates && { label: t('checkUpdates'), run: checkUpdates },
              canLaunchPackage && { label: t('launchPackage'), run: launchPackage },
              cliTools && { label: t('cli.action'), run: () => setPanel('cli') },
              (refresh || (onRemoveServices && !setup?.running)) && 'separator',
              refresh && { label: t('refresh'), run: refresh },
              onRemoveServices && !setup?.running && { label: t('remove.action'), run: () => setPanel('remove'), destructive: true },
            ]} />
          )}
        </span>
      </div>
      )}
      {/* The design's Audit log page (Lovable route /audit, "All activity"): every companion's records, in the menu. */}
      {panel === 'audit' && mode === 'tray' && (
        <section className="border-t border-border" aria-label={t('auditTitle')}>
          <div className="flex items-center gap-2 px-3 pt-2">
            <h3 className="m-0 flex-1 text-sm font-medium">{t('auditTitle')} <span className="font-normal text-muted-foreground">· {t('allActivity')}</span></h3>
            <button type="button" className={footerIcon} aria-label={t('close')} onClick={() => setPanel(null)}><X className="size-3.5" aria-hidden /></button>
          </div>
          <div className="max-h-72 overflow-y-auto"><AuditLog agentId={null} roster={roster} /></div>
        </section>
      )}
      {panel === 'cli' && cliTools && (
        <div className="border-t border-border px-3 py-2"><CliTools api={cliTools} startOpen onClose={() => setPanel(null)} /></div>
      )}
      {panel === 'remove' && onRemoveServices && (
        <div className="border-t border-border px-3 py-2"><RemoveServices onRemove={onRemoveServices} startConfirming onClose={() => setPanel(null)} /></div>
      )}
    </footer>
  );

  // First-run setup takes over the popover (Lovable SetupPanel): a header,
  // the steps, then the footer with the design's links. Approvals, the fleet
  // and the cards wait until setup is done.
  const setupMenu = setup && onSetup && (
    <>
      <SetupHeader connection={connection} running={setup.running} error={footer?.isError ? footer.text : null} />
      <SetupPanel setup={setup} onSetup={onSetup} existing={existingServices} />
      {updates && setupUpdateShows(updates.status, checkedUpdates) && <UpdateNotice status={updates.status} onAction={updates.act} checked={checkedUpdates} />}
      {iconFooter(true)}
    </>
  );

  const menu = (hiding?: Hiding) => showSetup && setupMenu ? setupMenu : (
    <>
      <HealthHeader connection={connection}><ApprovalCounts waiting={waiting.length} working={working} /></HealthHeader>
      {updates && <UpdateNotice status={updates.status} onAction={updates.act} checked={checkedUpdates} />}
      {showStarter && starter && launcher && (
        // The menu's card look (as the sandbox and default-harness cards); no Lovable screen.
        <section className="grid gap-2 border-b border-border p-3 text-xs" aria-label={t('firstCompanion')}>
          <FirstLaunch starter={starter} launcher={launcher} auth={harnessAuth} devTools={devTools} onStart={() => setStarterOpen(true)} />
          {starterOpen && launcher.state.phase !== 'requesting' && launcher.state.phase !== 'pending' && (
            <div className={actions}>
              <button type="button" className={secondaryButton} onClick={() => setStarterOpen(false)}>{t('close')}</button>
            </div>
          )}
        </section>
      )}
      <ApprovalsList items={waiting} paused={paused} onOpen={open}
        onDecide={decide && ((proposalId, decision) => { void decide(proposalId, decision); })} />
      <FleetList forest={forest} paused={paused} unreadOf={unread} onOpen={open} hiding={hiding} onArchive={archiveWith && setArchiving}
        awaiting={awaitingIds} busy={(badges ?? liveBadges).busy}
        empty={!showStarter && empty && <p className="m-0 px-3 py-2 text-sm text-muted-foreground">{empty}</p>} />
      {launch && <DefaultHarness harnesses={launch.harnesses} />}
      <SandboxCard />
      <IdentityAppsCard roster={roster} />
      {iconFooter(false)}
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
      <main className="gb flex h-full flex-col overflow-y-auto bg-popover">
        {session ? <>{updates && <UpdateNotice status={updates.status} onAction={updates.act} />}{session}</> : menu()}
        {launchModal}
        {archiveUi}
      </main>
    );
  }

  const header = healthHeader(connection, t, lang);
  // The menu is a popover, so its update line and an error footer also show
  // beside the GeniusBar button while it is closed.
  const update = updates ? updateNotice(updates.status) : null;
  const attention = fleet.failure
    ? { text: t(fleet.failure.action === 'pause' ? 'pauseFailed' : 'resumeFailed', { message: fleet.failure.message }), isError: true }
    : fleetMode.error ? { text: t('mode.failed', { message: fleetMode.error }), isError: true }
    : update ? { text: update.text, isError: update.isError }
    : footer?.isError ? { text: footer.text, isError: true }
    : null;
  const shownBadges = badges ?? liveBadges;
  const autopilot = fleetMode.mode === 'autopilot';
  const unreadTotal = unread ? roster.reduce((sum, soul) => sum + unread(soul), 0) : 0;
  const notice = showSetup ? t('setupHint')
    : forest.length === 0 ? (showStarter ? t('setupHint') : empty ?? header.title)
    : null;
  return (
    <div className="gb flex h-full flex-col">
      <MenuBar open={menuOpen} onOpenChange={setMenuOpen} tone={header.tone} title={footer && !footer.isError ? `${header.title} · ${footer.text}` : header.title}
        attention={attention} onReset={layoutActions.reset} unread={unreadTotal} approvals={waiting.length} working={working} forest={forest} paused={paused} onJump={open}
        autopilot={autopilot} onAutopilotOff={() => { void fleetMode.change('safe'); }}
        onAudit={openAudit}
        fleetPaused={fleet.paused} onResume={toggleFleet}
        onLaunch={canLaunchPackage ? launchPackage : undefined} hiddenCount={layout.hidden.length} onShowAll={layoutActions.showAll}
        onHome={() => { setSelectedKey(null); setAuditWindow(false); setMenuOpen(false); }}>
        {menu({ hidden: layout.hidden, onToggle: layoutActions.setHidden, onToggleTeam: layoutActions.setTeamHidden, onShowAll: layoutActions.showAll })}
      </MenuBar>
      <Desktop forest={forest} layout={layout} paused={paused} unreadOf={unread} selectedKey={openKey} onOpen={open}
        badges={shownBadges} onArchive={archiveWith && setArchiving} awaiting={awaitingIds} fleetPaused={fleet.paused}
        notice={notice} onLaunch={launch && !showSetup ? () => { setSelectedKey(null); setLaunchingPackage(true); } : undefined}>
        {selected && session && (
          // The sandbox chip is the design's title-bar pill; while agent-bot
          // resolves this soul it replaces the census's hardened pill.
          <CompanionWindow soul={sandbox.soul(selected.agentId) ? { ...selected, hardened: undefined } : selected}
            paused={paused} onClose={() => setSelectedKey(null)} state={liveState(selected, awaitingIds, busyIds)}
            actions={<><SandboxChip soul={selected} /><InfoButton soul={selected} /></>}>{session}</CompanionWindow>
        )}
        {auditWindow && <AuditWindow roster={roster} onClose={() => setAuditWindow(false)} />}
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

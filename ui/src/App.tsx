import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { LayoutGrid } from 'lucide-react';
import { CompanionSession } from './components/CompanionSession';
import { CompanionWindow, Desktop } from './components/Desktop';
import { FirstLaunch, type DevTools, type HarnessAuth, type Starter } from './components/FirstLaunch';
import { FleetList, type Hiding } from './components/FleetList';
import { HealthHeader } from './components/HealthHeader';
import { LaunchForm } from './components/LaunchForm';
import { CliTools, type CliToolsApi } from './components/CliTools';
import { RemoveServices } from './components/RemoveServices';
import { SetupPanel } from './components/SetupPanel';
import { UpdateNotice } from './components/UpdateNotice';
import { I18nProvider, LANGS, useI18n, type Lang } from './lib/i18n';
import { conversationOf, emptyComposer, unreadOf } from './model/chat';
import { allSouls, buildSoulForest, displayName, findSoul, soulKey, type CensusRow } from './model/census';
import { needsSetup, type ExistingServices, type SetupState } from './model/setup';
import { disconnected, emptyRosterText, footerStatus, healthHeader, type ConnectionSnapshot } from './model/status';
import { updateNotice } from './model/updates';
import { layoutActions, useLayout } from './state/layout';
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
  /** First-run setup; offered only when given and the connection needs it. */
  setup?: SetupState;
  onSetup?: (migrate?: boolean) => void;
  existingServices?: ExistingServices | null;
  cliTools?: CliToolsApi;
  /** Chat with souls (#17); without it the session has no conversation. */
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

export function App(props: AppProps) {
  return (
    <I18nProvider>
      <Shell {...props} />
    </I18nProvider>
  );
}

function LanguageSelect() {
  const { lang, setLang, t } = useI18n();
  return (
    <select aria-label={t('language')} value={lang} onChange={(e) => setLang(e.target.value as Lang)}
      className="h-6 rounded border border-input bg-muted px-1 text-[11px] text-muted-foreground">
      {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
    </select>
  );
}

// The GeniusBar menu (the tray popup's content, and the toolbar popover in
// window mode) and, from it, one companion's session.
function Shell({ mode = 'tray', census = NO_CENSUS, connection = disconnected, onRefresh, isStatic = false, setup, onSetup, chat, launcher, openedPackage, onRemoveServices, starter, harnessAuth, devTools, updates, existingServices, cliTools }: AppProps) {
  const { t } = useI18n();
  const forest = useMemo(() => buildSoulForest(census), [census]);
  const roster = useMemo(() => allSouls(forest), [forest]);
  // Selection holds the roster key and resolves against each census, so
  // the session shows fresh values and closes if the soul disappears.
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
  // Window mode's menu is a popover; it opens itself when it has news.
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (openedPackage) {
      setSelectedKey(null);
      setLaunchingPackage(true);
      setMenuOpen(true);
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
  useEffect(() => { if (showSetup || showStarter) setMenuOpen(true); }, [showSetup, showStarter]);
  const launch = useMemo(() => launcher && {
    launcher,
    accounts: [...new Set(roster.map((s) => s.account))].sort(),
    harnesses: [...new Set(roster.flatMap((s) => (s.harness ? [s.harness] : [])))].sort(),
  }, [launcher, roster]);
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
      <HealthHeader connection={connection}><LanguageSelect /></HealthHeader>
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
      {(footer || onRefresh || onRemoveServices || cliTools || (launch && !showSetup) || canCheckUpdates) && (
        <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3.5 py-2">
          {footer && <span className={`mr-auto ${footer.isError ? 'error small' : 'muted small'}`}>{footer.text}</span>}
          {canCheckUpdates && (
            <button type="button" className="link" onClick={() => updates?.act()}>{t('checkUpdates')}</button>
          )}
          {launch && !showSetup && !launchingPackage && (
            <button type="button" className="link" onClick={() => { setSelectedKey(null); setLaunchingPackage(true); }}>
              {t('launchPackage')}
            </button>
          )}
          {cliTools && <CliTools api={cliTools} />}
          {onRemoveServices && !setup?.running && <RemoveServices onRemove={onRemoveServices} />}
          {onRefresh && <button type="button" className="link" onClick={onRefresh}>{t('refresh')}</button>}
        </footer>
      )}
    </>
  );

  if (mode === 'tray') {
    return <main className="gb flex h-full flex-col bg-popover">{session || menu()}</main>;
  }

  const header = healthHeader(connection);
  const notice = showSetup ? t('setupHint')
    : forest.length === 0 ? (showStarter ? t('setupHint') : empty ?? header.title)
    : null;
  return (
    <div className="gb flex h-full flex-col">
      <Toolbar open={menuOpen} onOpenChange={setMenuOpen} tone={header.tone} title={header.title}
        onReset={layoutActions.reset}>
        {menu({ hidden: layout.hidden, onToggle: layoutActions.setHidden, onShowAll: layoutActions.showAll })}
      </Toolbar>
      <Desktop forest={forest} layout={layout} paused={paused} unreadOf={unread} selectedKey={openKey} onOpen={open}
        notice={notice}>
        {selected && session && (
          <CompanionWindow title={displayName(selected)} onClose={() => setSelectedKey(null)}>{session}</CompanionWindow>
        )}
      </Desktop>
    </div>
  );
}

/**
 * Window mode's slim toolbar: the GeniusBar item, whose menu drops down as
 * a popover, plus the desktop's own controls. Escape or a click outside
 * closes the menu.
 */
function Toolbar({ open, onOpenChange, tone, title, onReset, children }: {
  open: boolean; onOpenChange: (open: boolean) => void; tone: string; title: string; onReset: () => void; children: ReactNode;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) onOpenChange(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open, onOpenChange]);
  return (
    <div className="relative z-40 flex h-9 shrink-0 items-center gap-2 border-b border-border bg-sidebar px-2">
      <div ref={root} onKeyDown={(e) => { if (e.key === 'Escape') onOpenChange(false); }}>
        <button
          type="button"
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={t('bar.menu')}
          title={title}
          onClick={() => onOpenChange(!open)}
          className={`flex h-7 items-center gap-1.5 rounded px-1.5 hover:bg-accent ${open ? 'bg-accent' : ''}`}
        >
          <span className="grid size-4.5 place-items-center rounded-[4px] bg-foreground text-[10px] font-bold text-background" aria-hidden>G</span>
          <span className="text-xs font-semibold">GeniusBar</span>
          <span className={`dot dot-${tone}`} aria-hidden />
        </button>
        {open && (
          <div role="dialog" aria-label={t('bar.menu')}
            className="absolute top-full left-2 mt-1 flex max-h-[calc(100vh-3rem)] w-[22rem] flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-2xl">
            {children}
          </div>
        )}
      </div>
      <button type="button" onClick={onReset} title={t('menu.resetLayout')} aria-label={t('menu.resetLayout')}
        className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
        <LayoutGrid className="size-4" aria-hidden />
      </button>
    </div>
  );
}

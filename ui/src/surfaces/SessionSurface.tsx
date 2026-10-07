import { useEffect, useMemo, useRef, useState } from 'react';
import { ArchiveDialog, type Archiver } from '../components/ArchiveDialog';
import { CompanionSession, InfoButton, type SessionTab } from '../components/CompanionSession';
import { CompanionWindow } from '../components/Desktop';
import type { Stopper } from '../components/FloatingDudle';
import { liveState } from '../components/FleetList';
import { useSandbox } from '../components/Sandbox';
import { SandboxChip } from '../components/SandboxChip';
import { useI18n } from '../lib/i18n';
import { displayName, findSoul, soulKey, type CensusRow } from '../model/census';
import { conversationOf, emptyComposer } from '../model/chat';
import { layoutActions } from '../state/layout';
import { usePreferences } from '../state/preferences';
import type { LaunchApi } from '../useLaunch';
import { closeWindow, usePageHidden, useSurfaceFleet, useWindowTitle, type SurfaceData } from './common';
import { SurfaceOpenerContext, type OpenSurface } from './opener';

/**
 * One companion's session as its own native window (#223), Lovable's
 * CompanionWindow at /companions/$id: the desktop window's chrome without
 * its close dot (the traffic lights are the window's), then the session.
 * `tab` opens it on that tab; `action=archive` opens with the Archive
 * confirmation showing. Escape or a finished archive closes the window.
 */
export function SessionSurface({ soul: key, tab, action, census, loaded, chat, badges, win, isStatic = false, open, launcher, archiver, stopper }: SurfaceData & {
  soul: string | null;
  tab: SessionTab | null;
  action: 'archive' | null;
  open: OpenSurface | null;
  launcher?: LaunchApi;
  archiver?: Archiver;
  /** Halts this soul while it drives the screen (#122): the header's Stop. */
  stopper?: Stopper;
}) {
  const { t } = useI18n();
  const sandbox = useSandbox();
  const { forest, roster, awaiting, busy } = useSurfaceFleet({ census, chat, badges });
  const soul = key ? findSoul(forest, key) : null;
  const openKey = soul ? soulKey(soul) : null;
  const paused = usePageHidden() || isStatic;
  const [archiving, setArchiving] = useState(action === 'archive');
  useWindowTitle(soul ? t('surface.title', { name: displayName(soul) }) : null, win);
  // The conversation on screen is marked read, here and in every window.
  const openChat = chat?.open;
  useEffect(() => {
    if (!openChat) return;
    openChat(openKey);
    return () => openChat(null);
  }, [openChat, openKey]);
  const { defaultHarness } = usePreferences();
  const launch = useMemo(() => launcher && {
    launcher,
    accounts: [...new Set(roster.map((s) => s.account))].sort(),
    harnesses: [...new Set(roster.flatMap((s) => (s.harness ? [s.harness] : [])))].sort(),
    defaultHarness,
    roster,
  }, [launcher, roster, defaultHarness]);
  // Escape reaches both the session and the window's chrome; close once.
  const closing = useRef(false);
  const close = () => {
    if (closing.current) return;
    closing.current = true;
    closeWindow(win);
    // Outside the app nothing closes, so a later Escape may try again.
    if (!win) closing.current = false;
  };
  // The delegation tree's companions open in their own windows too.
  const openOther = (other: CensusRow) => { open?.({ surface: 'session', soul: soulKey(other) }).catch(() => {}); };

  if (!soul || openKey === null) {
    return (
      <main className="gb flex h-full flex-col bg-card">
        <div data-tauri-drag-region="" className="min-h-10 border-b border-border bg-sidebar" />
        {loaded && <p className="m-0 p-6 text-sm text-muted-foreground">{t('surface.gone')}</p>}
      </main>
    );
  }
  const state = liveState(soul, awaiting, busy);
  return (
    <SurfaceOpenerContext.Provider value={open}>
      <main className="gb h-full">
        {/* The sandbox chip is the design's title-bar pill; while agent-bot resolves this soul it replaces the census's hardened pill. */}
        <CompanionWindow native soul={sandbox.soul(soul.agentId) ? { ...soul, hardened: undefined } : soul} paused={paused}
          onClose={close} state={state}
          actions={<><SandboxChip soul={soul} /><InfoButton soul={soul} state={state} /></>}>
          <CompanionSession
            initialTab={tab ?? undefined}
            soul={soul}
            forest={forest}
            roster={roster}
            paused={paused}
            chat={chat ? {
              entries: conversationOf(chat.chat, openKey).entries,
              composer: chat.composers[openKey] ?? emptyComposer,
              onDraft: (draft) => chat.setDraft(openKey, draft),
              onSend: () => { void chat.send(openKey); },
              onResolve: chat.resolve && ((entryId, decision) => { void chat.resolve?.(openKey, entryId, decision); }),
            } : undefined}
            launch={launch}
            onOpen={openOther}
            onClose={close}
            awaiting={awaiting}
            busy={busy}
            computerUse={badges?.computerUse}
            stopper={stopper}
          />
        </CompanionWindow>
        {archiving && archiver && (
          <ArchiveDialog soul={soul} archiver={archiver} onCancel={() => setArchiving(false)}
            onArchived={() => { layoutActions.setHidden(openKey, false); close(); }} />
        )}
      </main>
    </SurfaceOpenerContext.Provider>
  );
}

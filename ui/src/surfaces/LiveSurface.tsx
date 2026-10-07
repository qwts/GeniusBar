// A native surface's web view (#223), with the live hooks it needs. The
// census, the badges and the inbox come from what the popup stored (the
// hooks share them through storage), with only a session window polling
// the inbox, so N team cards are not N pollers.
import { useCallback, useMemo } from 'react';
import { AppProviders } from '../App';
import { currentWindow, inApp, listSoulTemplates, openSurface, populationList, soulStopSupported, stopSoul } from '../bridge';
import { liveArchiver } from '../components/ArchiveDialog';
import type { Stopper } from '../components/FloatingDudle';
import { DropCue } from '../components/DropCue';
import type { SurfaceQuery } from '../model/surface';
import { useBadges } from '../useBadges';
import { useCensus } from '../useCensus';
import { useChat } from '../useChat';
import { useLaunch } from '../useLaunch';
import { checkSoulPackage, routeDroppedPackage, useSoulDrop, type DropListener } from '../soulPackage';
import { AuditSurface } from './AuditSurface';
import { CustomizeSurface } from './CustomizeSurface';
import { LaunchSurface } from './LaunchSurface';
import { HaltSurface, PerimeterSurface } from './PerimeterSurface';
import type { OpenSurface } from './opener';
import { SessionSurface } from './SessionSurface';
import { TeamSurface } from './TeamSurface';

const liveOpen: OpenSurface = (request) => openSurface(request);
const liveStopper: Stopper = { supported: () => soulStopSupported(), stop: (agentId) => stopSoul(agentId) };

const ignoreDrop = () => {};
const liveCheck = (path: string) => checkSoulPackage(path);

export function LiveSurface({ query, snapshot = false, listenDrops }: {
  query: SurfaceQuery; snapshot?: boolean;
  /** Tests' fake for Tauri's drag-and-drop events. */
  listenDrops?: DropListener;
}) {
  const live = inApp() && !snapshot;
  const { surface, soul, tab, action } = query;
  const { census, connection } = useCensus(live, populationList, { share: 'follow' });
  const chat = useChat({ enabled: live && surface === 'session', roster: census });
  // Hues, roles and status faces for the surfaces that draw Dudles.
  const ids = useMemo(() => [...new Set(census.filter((s) => s.presence !== 'left').map((s) => s.agentId))], [census]);
  const badges = useBadges(ids, live && (surface === 'team' || surface === 'session' || surface === 'customize' || surface === 'halt'),
    undefined, { share: 'follow' });
  const launcher = useLaunch();
  const win = useMemo(() => currentWindow(), []);
  const data = { census, loaded: !live || connection.lastRefresh !== null, chat, badges, win, isStatic: snapshot };
  const open = live ? liveOpen : null;
  // A `.soul` dropped on any native window opens the launch window with it (#98).
  const drop = useCallback((path: string) => {
    if (open) void routeDroppedPackage(path, { open, show: ignoreDrop });
  }, [open]);
  const dropping = useSoulDrop(open ? drop : null, listenDrops);
  return (
    <AppProviders isStatic={snapshot}>
      {surface === 'team' && <TeamSurface {...data} soul={soul} open={open} dropping={dropping} />}
      {surface === 'session' && <SessionSurface {...data} soul={soul} tab={tab} action={action} open={open}
        launcher={launcher} archiver={live ? liveArchiver : undefined} stopper={live ? liveStopper : undefined} />}
      {surface === 'audit' && <AuditSurface {...data} soul={soul} />}
      {surface === 'customize' && <CustomizeSurface {...data} soul={soul} />}
      {surface === 'perimeter' && <PerimeterSurface isStatic={snapshot} />}
      {surface === 'halt' && <HaltSurface census={census} badges={badges} stopper={live ? liveStopper : undefined} />}
      {surface === 'launch' && <LaunchSurface {...data} launcher={launcher} open={open} listTemplates={live ? listSoulTemplates : undefined}
        packagePath={query.package} checkPackage={live ? liveCheck : undefined} />}
      {dropping && surface !== 'team' && <div className="gb"><DropCue fill /></div>}
    </AppProviders>
  );
}

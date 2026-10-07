// A native surface's web view (#223), with the live hooks it needs. Each
// window reads the census and badges itself; only a session window polls
// the inbox, and the others show what the popup stored (useChat shares it
// through storage), so N team cards are not N inbox pollers.
import { useCallback, useMemo } from 'react';
import { AppProviders } from '../App';
import { currentWindow, inApp, listSoulTemplates, openSurface } from '../bridge';
import { liveArchiver } from '../components/ArchiveDialog';
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
import type { OpenSurface } from './opener';
import { SessionSurface } from './SessionSurface';
import { TeamSurface } from './TeamSurface';

const liveOpen: OpenSurface = (request) => openSurface(request);

const ignoreDrop = () => {};
const liveCheck = (path: string) => checkSoulPackage(path);

export function LiveSurface({ query, snapshot = false, listenDrops }: {
  query: SurfaceQuery; snapshot?: boolean;
  /** Tests' fake for Tauri's drag-and-drop events. */
  listenDrops?: DropListener;
}) {
  const live = inApp() && !snapshot;
  const { surface, soul, tab, action } = query;
  const { census, connection } = useCensus(live);
  const chat = useChat({ enabled: live && surface === 'session', roster: census });
  // Hues, roles and status faces for the surfaces that draw Dudles.
  const ids = useMemo(() => [...new Set(census.filter((s) => s.presence !== 'left').map((s) => s.agentId))], [census]);
  const badges = useBadges(ids, live && (surface === 'team' || surface === 'session' || surface === 'customize'));
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
        launcher={launcher} archiver={live ? liveArchiver : undefined} />}
      {surface === 'audit' && <AuditSurface {...data} soul={soul} />}
      {surface === 'customize' && <CustomizeSurface {...data} soul={soul} />}
      {surface === 'launch' && <LaunchSurface {...data} launcher={launcher} open={open} listTemplates={live ? listSoulTemplates : undefined}
        packagePath={query.package} checkPackage={live ? liveCheck : undefined} />}
      {dropping && surface !== 'team' && <div className="gb"><DropCue fill /></div>}
    </AppProviders>
  );
}

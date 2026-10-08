import type { AboutInfo, AboutRunning } from '../bridge';
import type { Translate } from '../lib/i18n';

/** The About dialog's links (#290), opened through the shell's allow-listed opener. */
export const RELEASE_NOTES_URL = 'https://github.com/qwts/GeniusBar/releases';
export const REPORT_PROBLEM_URL = 'https://github.com/qwts/GeniusBar/issues/new/choose';

/** The engines the bundle carries, as `components.json` names them. */
export const ABOUT_COMPONENTS = ['agent-bot', 'agent-comms'] as const;
export type AboutComponent = typeof ABOUT_COMPONENTS[number];

export interface ComponentVersions {
  name: AboutComponent;
  /** The bundled copy's version, with its pinned commit when known; null when the shell could not read it. */
  bundled: string | null;
  /** What the live engine answered; null when it is not connected. */
  running: string | null;
}

export interface AboutVersions {
  app: { name: string; version: string | null; build: string | null };
  components: ComponentVersions[];
  os: { name: string | null; version: string | null };
}

/** The bundled label: the version, with the pinned commit when known (`0.10.49 (a5e7e7b3de48)`). */
export function bundledLabel(pin: { version: string | null; ref: string | null } | undefined): string | null {
  if (!pin?.version) return null;
  return pin.ref ? `${pin.version} (${pin.ref})` : pin.version;
}

/**
 * Joins what the shell read from the bundle (`about_info`), what the
 * engines answered (`about_running`) and whether the broker is reachable
 * now. A running version shows only for a connected engine: agent-bot's
 * while its daemon answers, agent-comms's while the broker is reachable;
 * anything else stays null, which the page shows as "Unknown / not
 * connected". Nothing is invented for a value the shell did not give.
 */
export function aboutVersions(info: AboutInfo | null, running: AboutRunning | null, brokerReachable: boolean): AboutVersions {
  return {
    app: { name: info?.app.name ?? 'GeniusBar', version: info?.app.version ?? null, build: info?.app.build ?? null },
    components: ABOUT_COMPONENTS.map((name) => ({
      name,
      bundled: bundledLabel(info?.bundled[name]),
      running: name === 'agent-bot'
        ? (running?.['agent-bot'].running ? running['agent-bot'].version : null)
        : (brokerReachable ? running?.['agent-comms'].version ?? null : null),
    })),
    os: { name: info?.os.name ?? null, version: info?.os.version ?? null },
  };
}

/**
 * The copyable summary: the app, build, component and OS lines only. No
 * path, soul identifier, credential or message ever joins it; `pending`
 * stands in for a running version still being read.
 */
export function aboutSummary(versions: AboutVersions, t: Translate, pending: string | null = null): string {
  const unknown = t('about.unknown');
  const os = versions.os.name ? [versions.os.name, versions.os.version].filter(Boolean).join(' ') : unknown;
  return [
    versions.app.name,
    `${t('about.version')}: ${versions.app.version ?? unknown}`,
    `${t('about.build')}: ${versions.app.build ?? unknown}`,
    ...versions.components.flatMap((component) => [
      `${component.name} · ${t('about.bundled')}: ${component.bundled ?? unknown}`,
      `${component.name} · ${t('about.running')}: ${component.running ?? pending ?? unknown}`,
    ]),
    `${t('about.system')}: ${os}`,
  ].join('\n');
}

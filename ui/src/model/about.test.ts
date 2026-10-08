import { describe, expect, it } from 'vitest';
import type { AboutInfo, AboutRunning } from '../bridge';
import { translate } from '../lib/i18n';
import { aboutSummary, aboutVersions, bundledLabel, RELEASE_NOTES_URL, REPORT_PROBLEM_URL } from './about';

const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars);

const info: AboutInfo = {
  app: { name: 'GeniusBar', version: '0.1.58', build: '0.1.58' },
  bundled: { 'agent-bot': { version: '0.10.49', ref: 'a5e7e7b3de48' }, 'agent-comms': { version: '0.3.14', ref: null } },
  os: { name: 'macOS', version: '26.0' },
};
const running: AboutRunning = { 'agent-bot': { running: true, version: '0.10.49' }, 'agent-comms': { version: '0.3.14' } };

describe('about versions (#290)', () => {
  it('labels a bundled engine by version and pinned commit, when known', () => {
    expect(bundledLabel({ version: '0.10.49', ref: 'a5e7e7b3de48' })).toBe('0.10.49 (a5e7e7b3de48)');
    expect(bundledLabel({ version: '0.3.14', ref: null })).toBe('0.3.14');
    expect(bundledLabel({ version: null, ref: 'a5e7e7b3de48' })).toBeNull();
    expect(bundledLabel(undefined)).toBeNull();
  });

  it('shows a running version only for a connected engine', () => {
    const connected = aboutVersions(info, running, true);
    expect(connected.app).toEqual({ name: 'GeniusBar', version: '0.1.58', build: '0.1.58' });
    expect(connected.components).toEqual([
      { name: 'agent-bot', bundled: '0.10.49 (a5e7e7b3de48)', running: '0.10.49' },
      { name: 'agent-comms', bundled: '0.3.14', running: '0.3.14' },
    ]);
    // The daemon down: agent-bot's answer is not a running version; the broker unreachable: nor is agent-comms's.
    const down = aboutVersions(info, { ...running, 'agent-bot': { running: false, version: '0.10.49' } }, false);
    expect(down.components.map((c) => c.running)).toEqual([null, null]);
    // A newer engine than the bundle stays distinct, never collapsed into the bundled value.
    const newer = aboutVersions(info, { ...running, 'agent-comms': { version: '0.3.15' } }, true);
    expect(newer.components[1]).toEqual({ name: 'agent-comms', bundled: '0.3.14', running: '0.3.15' });
  });

  it('invents nothing when the shell could not say', () => {
    const none = aboutVersions(null, null, true);
    expect(none.app).toEqual({ name: 'GeniusBar', version: null, build: null });
    expect(none.components).toEqual([
      { name: 'agent-bot', bundled: null, running: null },
      { name: 'agent-comms', bundled: null, running: null },
    ]);
    expect(none.os).toEqual({ name: null, version: null });
  });

  it('writes the summary from the allow-listed lines only', () => {
    expect(aboutSummary(aboutVersions(info, running, true), t)).toBe([
      'GeniusBar',
      'Version: 0.1.58',
      'Build: 0.1.58',
      'agent-bot · Bundled version: 0.10.49 (a5e7e7b3de48)',
      'agent-bot · Running version: 0.10.49',
      'agent-comms · Bundled version: 0.3.14',
      'agent-comms · Running version: 0.3.14',
      'System: macOS 26.0',
    ].join('\n'));
    const unknown = aboutSummary(aboutVersions(null, null, false), t);
    expect(unknown.split('\n')).toHaveLength(8);
    expect(unknown).toContain('Version: Unknown / not connected');
    expect(unknown).toContain('System: Unknown / not connected');
    // While the engines are still answering, the summary says so rather than "not connected".
    expect(aboutSummary(aboutVersions(info, null, true), t, 'Checking…')).toContain('agent-bot · Running version: Checking…');
    expect(aboutSummary(aboutVersions(info, null, true), t, 'Checking…')).toContain('agent-bot · Bundled version: 0.10.49');
  });

  it('speaks the catalog language in the summary', () => {
    const es = aboutSummary(aboutVersions(info, running, true), (key, vars) => translate('es', key, vars));
    expect(es).toContain('Versión: 0.1.58');
    expect(es).toContain('agent-comms · Versión en ejecución: 0.3.14');
    expect(es).toContain('Sistema: macOS 26.0');
  });

  it('links to the release notes and the problem report on GitHub', () => {
    expect(RELEASE_NOTES_URL).toBe('https://github.com/qwts/GeniusBar/releases');
    expect(REPORT_PROBLEM_URL).toBe('https://github.com/qwts/GeniusBar/issues/new/choose');
  });
});

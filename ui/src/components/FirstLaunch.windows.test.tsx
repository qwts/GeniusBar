// The Windows first launch (#46). The macOS expectations stay in
// FirstLaunch.test.tsx, unchanged: the Mac flow is byte-identical.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LaunchApi } from '../useLaunch';
import { en } from '../locales/en';
import { es } from '../locales/es';
import { REPORT_PROBLEM_URL } from '../model/about';
import { sampleHosts } from '../model/fixtures';
import { unknownHost, type HostCapabilities } from '../model/host';
import { FirstLaunch, type Starter } from './FirstLaunch';

const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
// What `starter_soul` says on a PC whose bundled git did not answer.
const noGit: Starter = { package: 'C:\\Program Files\\GeniusBar\\souls\\starter.soul', account: 'friend', name: 'Genius', harnesses: ['claude'], devTools: false, devToolsInstalling: false };
const ready: Starter = { ...noGit, devTools: true };
const devTools = { install: vi.fn(async () => {}), recheck: vi.fn() };

/** Wording that belongs to the Mac flow and must never reach a Windows PC. */
const MAC_TERMS = [/xcode/i, /homebrew/i, /\/Applications/, /standard macOS account/i, /\bmacOS\b/, /\bApple\b/, /Terminal\b/];
const expectNoMacTerms = (text: string, label: string) => {
  for (const term of MAC_TERMS) expect(text, `${label}: ${term}`).not.toMatch(term);
};

afterEach(cleanup);

describe('FirstLaunch on Windows (#46)', () => {
  it('lists the bundled tools as the host reports them, with Retry and Get help on each row that is not ready', () => {
    const help = { url: REPORT_PROBLEM_URL, open: vi.fn(async () => {}) };
    render(<FirstLaunch starter={noGit} launcher={launcher} devTools={devTools} host={sampleHosts.windowsMixed} onRecheckHost={() => {}} help={help} />);
    expect(screen.getByText('Let’s get GeniusBar ready on this PC.')).toBeTruthy();
    const rows = screen.getByRole('list', { name: 'Let’s get GeniusBar ready on this PC.' });
    expect(rows.querySelectorAll('li').length).toBe(3);
    expect(screen.getByText('Git (bundled) — Ready')).toBeTruthy();
    expect(screen.getByText('Node.js (bundled) — Missing')).toBeTruthy();
    expect(screen.getByText("GeniusBar command-line tools — Couldn't start")).toBeTruthy();
    expect(screen.getByText("Node.js (bundled) wasn't found in this install. Reinstall GeniusBar, then Retry.")).toBeTruthy();
    expect(screen.getByText("GeniusBar command-line tools didn't start: access denied (example host message)")).toBeTruthy();
    // The ready row has no buttons; each other row has the pair.
    expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBe(2);
    expect(screen.getAllByRole('button', { name: 'Get help' }).length).toBe(2);
    expect(rows.querySelector('li')?.querySelector('button')).toBeNull();
    expect(screen.getByRole('note').textContent).toBe("Development build — not signed. Automatic updates aren't available.");
    // Nothing from the Mac flow: no installer, no Continue, no start yet.
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Start with Genius' })).toBeNull();
    expect(devTools.install).not.toHaveBeenCalled();
  });

  it('says Starting… while the probe runs, with nothing to click yet', () => {
    render(<FirstLaunch starter={noGit} launcher={launcher} host={sampleHosts.windowsChecking} onRecheckHost={() => {}} />);
    expect(screen.getAllByText(/— Starting…$/).length).toBe(3);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Retry probes again and focuses the first row still not ready', () => {
    const onRecheckHost = vi.fn();
    const { rerender } = render(<FirstLaunch starter={noGit} launcher={launcher} host={sampleHosts.windowsMissing} onRecheckHost={onRecheckHost} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRecheckHost).toHaveBeenCalledOnce();
    rerender(<FirstLaunch starter={noGit} launcher={launcher} host={sampleHosts.windowsChecking} onRecheckHost={onRecheckHost} />);
    expect(screen.getAllByText(/— Starting…$/).length).toBe(3);
    rerender(<FirstLaunch starter={noGit} launcher={launcher} host={sampleHosts.windowsFailed} onRecheckHost={onRecheckHost} />);
    const focused = document.activeElement;
    expect(focused?.tagName).toBe('LI');
    expect(focused?.textContent).toContain("GeniusBar command-line tools — Couldn't start");
    // Failed rows keep their recovery path.
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.getByText("GeniusBar command-line tools didn't start: agent-bot: access denied (example host message)")).toBeTruthy();
  });

  it('Get help opens the page About’s “Report a problem” opens, and says when the browser would not', async () => {
    const open = vi.fn(async (url: string) => { if (url !== REPORT_PROBLEM_URL) throw new Error('wrong page'); });
    const { rerender } = render(<FirstLaunch starter={noGit} launcher={launcher} host={sampleHosts.windowsMissing} help={{ url: REPORT_PROBLEM_URL, open }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Get help' }));
    expect(open).toHaveBeenCalledWith('https://github.com/qwts/GeniusBar/issues/new/choose');
    const failing = vi.fn(async () => { throw new Error('no browser'); });
    rerender(<FirstLaunch starter={noGit} launcher={launcher} host={sampleHosts.windowsMissing} help={{ url: REPORT_PROBLEM_URL, open: failing }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Get help' }));
    expect(await screen.findByText('Could not open the browser: no browser')).toBeTruthy();
  });

  it('continues into the usual start once every tool is ready, noting a development build only when the host says so', () => {
    const { rerender } = render(<FirstLaunch starter={ready} launcher={launcher} host={sampleHosts.windows} />);
    expect(screen.getByRole('button', { name: 'Start with Genius' })).toBeTruthy();
    expect(screen.getByRole('note').textContent).toBe("Development build — not signed. Automatic updates aren't available.");
    expect(screen.queryByText('Let’s get GeniusBar ready on this PC.')).toBeNull();
    const signed: HostCapabilities = { ...sampleHosts.windows, build: { signed: true, updater: true } };
    rerender(<FirstLaunch starter={ready} launcher={launcher} host={signed} />);
    expect(screen.getByRole('button', { name: 'Start with Genius' })).toBeTruthy();
    expect(screen.queryByRole('note')).toBeNull();
    // Signed, but without the updater: still a build that cannot update.
    rerender(<FirstLaunch starter={ready} launcher={launcher} host={{ ...signed, build: { signed: true, updater: false } }} />);
    expect(screen.getByRole('note')).toBeTruthy();
  });

  it('never shows macOS wording on Windows, in any state or language', () => {
    for (const [name, host] of Object.entries(sampleHosts)) {
      if (host.platform !== 'windows') continue;
      const { container, unmount } = render(<FirstLaunch starter={host === sampleHosts.windows ? ready : noGit} launcher={launcher} devTools={devTools} host={host} onRecheckHost={() => {}} help={{ url: REPORT_PROBLEM_URL, open: async () => {} }} />);
      expectNoMacTerms(container.textContent ?? '', name);
      expect(container.querySelector('code')).toBeNull();
      unmount();
    }
    for (const catalog of [en, es]) {
      for (const [key, text] of Object.entries(catalog)) if (key.startsWith('host.')) expectNoMacTerms(text, key);
    }
  });

  it('keeps the Mac flow for a Mac, and for a host the shell could not describe', () => {
    const { rerender } = render(<FirstLaunch starter={noGit} launcher={launcher} devTools={devTools} host={sampleHosts.macos} />);
    expect(screen.getByText('GeniusBar needs Apple’s free command-line tools (for git). This takes a few minutes, once.')).toBeTruthy();
    expect(screen.queryByText('Let’s get GeniusBar ready on this PC.')).toBeNull();
    expect(screen.queryByRole('note')).toBeNull();
    rerender(<FirstLaunch starter={noGit} launcher={launcher} devTools={devTools} host={unknownHost} />);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
    rerender(<FirstLaunch starter={ready} launcher={launcher} devTools={devTools} host={sampleHosts.macos} />);
    expect(screen.getByRole('button', { name: 'Start with Genius' })).toBeTruthy();
    expect(screen.queryByRole('note')).toBeNull();
  });
});

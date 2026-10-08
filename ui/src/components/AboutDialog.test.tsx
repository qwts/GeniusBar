import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { BridgeError, type AboutInfo, type AboutRunning } from '../bridge';
import { sampleCensus, sampleConnection } from '../model/fixtures';
import { idleSetup } from '../model/setup';
import { disconnected } from '../model/status';
import { layoutActions } from '../state/layout';
import { preferenceActions } from '../state/preferences';
import type { LaunchApi } from '../useLaunch';
import { focusReturnOf, type AboutSource } from './AboutDialog';
import { FirstLaunch, type Starter } from './FirstLaunch';

afterEach(() => { cleanup(); globalThis.localStorage?.clear(); layoutActions.forget(); preferenceActions.forget(); });

const info: AboutInfo = {
  app: { name: 'GeniusBar', version: '0.1.58', build: '0.1.58' },
  bundled: { 'agent-bot': { version: '0.10.49', ref: 'a5e7e7b3de48' }, 'agent-comms': { version: '0.3.14', ref: '429729652a37' } },
  os: { name: 'macOS', version: '26.0' },
};
const running: AboutRunning = { 'agent-bot': { running: true, version: '0.10.49' }, 'agent-comms': { version: '0.3.14' } };

/** A fake shell: what `about_info` and `about_running` answer, and an opener that remembers its URLs. */
function sourceOf(data: { info?: AboutInfo | null; running?: AboutRunning | null } = {}, open: AboutSource['open'] = async () => {}): AboutSource {
  return {
    info: vi.fn(async () => (data.info === undefined ? info : data.info)),
    running: vi.fn(async () => (data.running === undefined ? running : data.running)),
    open: vi.fn(open),
  };
}

const more = () => screen.getByRole('button', { name: 'More' });
function openAbout() {
  fireEvent.click(more());
  fireEvent.click(screen.getByRole('menuitem', { name: 'About GeniusBar…' }));
  return screen.getByRole('dialog', { name: 'About GeniusBar' });
}
const summaryOf = (dialog: HTMLElement) => within(dialog).getByRole('textbox', { name: 'Version info (selectable text)' }) as HTMLTextAreaElement;

function clipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(writeText) }, configurable: true });
  return navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
}

describe('About GeniusBar (#290)', () => {
  it('opens from the footer ⋯ after Check for Updates…, with the shell’s versions and the components collapsed', async () => {
    const source = sourceOf();
    render(<App census={sampleCensus} connection={sampleConnection} isStatic about={source} onRefresh={vi.fn()} updates={{ status: { state: 'idle', version: null }, act: vi.fn() }} />);
    fireEvent.click(more());
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Check for Updates…', 'About GeniusBar…', 'Refresh']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'About GeniusBar…' }));
    const dialog = screen.getByRole('dialog', { name: 'About GeniusBar' });
    expect(document.activeElement).toBe(dialog);
    await waitFor(() => expect(within(dialog).getAllByText('0.1.58')).toHaveLength(2));
    expect(within(dialog).getByText('Version')).toBeTruthy();
    expect(within(dialog).getByText('Build')).toBeTruthy();
    expect(within(dialog).queryByText(/example|preview/i)).toBeNull();
    const details = dialog.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(within(details).getByText('Component details')).toBeTruthy();
    const bot = within(details).getByRole('region', { name: 'agent-bot' });
    await waitFor(() => expect(within(bot).getByText('0.10.49')).toBeTruthy());
    expect(within(bot).getByText('0.10.49 (a5e7e7b3de48)')).toBeTruthy();
    const comms = within(details).getByRole('region', { name: 'agent-comms' });
    expect(within(comms).getByText('0.3.14 (429729652a37)')).toBeTruthy();
    expect(within(comms).getByText('0.3.14')).toBeTruthy();
    expect(summaryOf(dialog).readOnly).toBe(true);
    expect(summaryOf(dialog).value.split('\n')).toEqual([
      'GeniusBar', 'Version: 0.1.58', 'Build: 0.1.58',
      'agent-bot · Bundled version: 0.10.49 (a5e7e7b3de48)', 'agent-bot · Running version: 0.10.49',
      'agent-comms · Bundled version: 0.3.14 (429729652a37)', 'agent-comms · Running version: 0.3.14',
      'System: macOS 26.0',
    ]);
    expect(source.info).toHaveBeenCalledOnce();
    expect(source.running).toHaveBeenCalledOnce();
  });

  it('says Unknown / not connected for what it cannot read, and invents no version', async () => {
    const source = sourceOf({ info: null, running: { 'agent-bot': { running: false, version: null }, 'agent-comms': { version: '0.3.14' } } });
    render(<App census={sampleCensus} connection={{ ...sampleConnection, brokerUnreachable: true }} isStatic about={source} />);
    const dialog = openAbout();
    await waitFor(() => expect(summaryOf(dialog).value).not.toContain('Checking…'));
    expect(within(dialog).getAllByText('Unknown / not connected').length).toBeGreaterThanOrEqual(2);
    const lines = summaryOf(dialog).value.split('\n');
    expect(lines).toHaveLength(8);
    expect(lines[1]).toBe('Version: Unknown / not connected');
    // The broker is unreachable, so agent-comms's answer is not a running version either.
    expect(lines).toContain('agent-comms · Running version: Unknown / not connected');
    expect(lines).toContain('agent-bot · Running version: Unknown / not connected');
    expect(summaryOf(dialog).value).not.toMatch(/\/Users|\/Applications|agent_|token|key/i);
  });

  it('copies the summary and says so only once the clipboard took it', async () => {
    const writeText = clipboard(async () => {});
    render(<App census={sampleCensus} connection={sampleConnection} isStatic about={sourceOf()} />);
    const dialog = openAbout();
    await waitFor(() => expect(summaryOf(dialog).value).toContain('agent-comms · Running version: 0.3.14'));
    const status = within(dialog).getByRole('status');
    expect(status.textContent).toBe('');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy version info' }));
    await waitFor(() => expect(status.textContent).toBe('Version info copied.'));
    expect(writeText).toHaveBeenCalledWith(summaryOf(dialog).value);
    expect(writeText.mock.calls[0][0]).toContain('Version: 0.1.58');
  });

  it('on a refused clipboard, says it could not copy and leaves the text selected', async () => {
    clipboard(async () => { throw new Error('denied'); });
    Object.defineProperty(document, 'execCommand', { value: vi.fn(() => false), configurable: true });
    render(<App census={sampleCensus} connection={sampleConnection} isStatic about={sourceOf()} />);
    const dialog = openAbout();
    await waitFor(() => expect(summaryOf(dialog).value).toContain('agent-comms · Running version: 0.3.14'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy version info' }));
    const status = within(dialog).getByRole('status');
    await waitFor(() => expect(status.textContent).toBe('Could not copy. Select the version text and copy it manually.'));
    const summary = summaryOf(dialog);
    expect(document.activeElement).toBe(summary);
    expect([summary.selectionStart, summary.selectionEnd]).toEqual([0, summary.value.length]);
    // Select text does the same by hand.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    const again = openAbout();
    fireEvent.click(within(again).getByRole('button', { name: 'Select text' }));
    expect(document.activeElement).toBe(summaryOf(again));
  });

  it('closes with Escape, Close or the backdrop, and hands focus back to the ⋯', () => {
    render(<App census={sampleCensus} connection={sampleConnection} isStatic about={sourceOf()} />);
    let dialog = openAbout();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'About GeniusBar' })).toBeNull();
    expect(document.activeElement).toBe(more());
    dialog = openAbout();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'About GeniusBar' })).toBeNull();
    expect(document.activeElement).toBe(more());
    dialog = openAbout();
    const backdrop = dialog.parentElement!;
    fireEvent.pointerDown(backdrop, { target: backdrop });
    fireEvent.click(backdrop);
    expect(screen.queryByRole('dialog', { name: 'About GeniusBar' })).toBeNull();
    // The fleet behind it is untouched: no view opened, no update check ran.
    expect(screen.getByRole('region', { name: 'Fleet' })).toBeTruthy();
  });

  it('opens the release notes and the problem report through the shell’s opener, and shows a refusal', async () => {
    const urls: string[] = [];
    const source = sourceOf({}, async (url) => {
      urls.push(url);
      if (url.includes('issues')) throw new BridgeError('identity-app-open-failed', 'the browser could not be opened');
    });
    render(<App census={sampleCensus} connection={sampleConnection} isStatic about={source} />);
    const dialog = openAbout();
    const links = within(dialog).getByRole('navigation', { name: 'Help' });
    fireEvent.click(within(links).getByRole('button', { name: 'Release notes' }));
    expect(urls).toEqual(['https://github.com/qwts/GeniusBar/releases']);
    expect(within(dialog).queryByRole('alert')).toBeNull();
    fireEvent.click(within(links).getByRole('button', { name: 'Report a problem' }));
    expect(urls[1]).toBe('https://github.com/qwts/GeniusBar/issues/new/choose');
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Could not open the browser: the browser could not be opened');
    expect(within(links).queryByRole('button', { name: /guide/i })).toBeNull();
    expect(dialog.querySelector('a[href]')).toBeNull();
  });

  it('is reachable before setup, from the setup screen’s link and its ⋯, and focus returns to the link', async () => {
    const source = sourceOf({ running: null });
    const unpaired = { ...disconnected, bridgeConnected: true, unpaired: true };
    render(<App connection={unpaired} setup={idleSetup} onSetup={() => {}} onRefresh={vi.fn()} about={source} />);
    const link = screen.getByRole('button', { name: 'About GeniusBar' });
    link.focus();
    fireEvent.click(link);
    const dialog = screen.getByRole('dialog', { name: 'About GeniusBar' });
    await waitFor(() => expect(within(dialog).getAllByText('0.1.58')).toHaveLength(2));
    expect(within(dialog).getByText('0.10.49 (a5e7e7b3de48)')).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(document.activeElement).toBe(link);
    expect(screen.getByRole('button', { name: 'Set up' })).toBeTruthy();
    fireEvent.click(more());
    expect(screen.getByRole('menuitem', { name: 'About GeniusBar…' })).toBeTruthy();
  });

  it('is in the window mode menu too, and gone when the app passes null', () => {
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic about={sourceOf()} />);
    fireEvent.click(screen.getByRole('button', { name: 'GeniusBar menu' }));
    const menu = screen.getByRole('dialog', { name: 'GeniusBar menu' });
    fireEvent.click(within(menu).getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'About GeniusBar…' }));
    expect(screen.getByRole('dialog', { name: 'About GeniusBar' })).toBeTruthy();
    cleanup();
    render(<App census={sampleCensus} connection={sampleConnection} isStatic about={null} onRefresh={vi.fn()} />);
    fireEvent.click(more());
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Refresh']);
  });

  it('speaks Spanish with the rest of the app', async () => {
    render(<App census={sampleCensus} connection={sampleConnection} isStatic about={sourceOf()} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Language' }), { target: { value: 'es' } });
    fireEvent.click(screen.getByRole('button', { name: 'Más' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Acerca de GeniusBar…' }));
    const dialog = screen.getByRole('dialog', { name: 'Acerca de GeniusBar' });
    const summary = within(dialog).getByRole('textbox', { name: 'Información de versión (texto seleccionable)' }) as HTMLTextAreaElement;
    await waitFor(() => expect(summary.value).toContain('agent-comms · Versión en ejecución: 0.3.14'));
    expect(within(dialog).getByRole('button', { name: 'Copiar información de versión' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Cerrar' })).toBeTruthy();
  });

  it('offers About from the first launch', () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    const starter: Starter = { package: '/App/souls/starter.soul', account: 'friend', name: 'Starter', harnesses: ['claude'], devTools: true };
    const onAbout = vi.fn();
    render(<FirstLaunch starter={starter} launcher={launcher} onAbout={onAbout} />);
    fireEvent.click(screen.getByRole('button', { name: 'About GeniusBar' }));
    expect(onAbout).toHaveBeenCalledOnce();
  });

  it('returns focus to the ⋯ for a menu item, else to the opener itself', () => {
    document.body.innerHTML = '<div><button id="t" aria-haspopup="menu">⋯</button><div role="menu"><button id="i">About</button></div></div><button id="b">link</button>';
    expect(focusReturnOf(document.getElementById('i'))).toBe(document.getElementById('t'));
    expect(focusReturnOf(document.getElementById('b'))).toBe(document.getElementById('b'));
    expect(focusReturnOf(null)).toBeNull();
    document.body.innerHTML = '';
  });
});

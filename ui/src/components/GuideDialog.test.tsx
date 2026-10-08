import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { BridgeError } from '../bridge';
import { GUIDE, GUIDE_META, orderChapters, type GuideChapter } from '../model/guide';
import { emptyComposer } from '../model/chat';
import { sampleCensus, sampleConnection } from '../model/fixtures';
import { idleSetup } from '../model/setup';
import { disconnected } from '../model/status';
import { layoutActions } from '../state/layout';
import { preferenceActions } from '../state/preferences';
import type { LaunchApi } from '../useLaunch';
import type { AboutSource } from './AboutDialog';
import { CompanionSession } from './CompanionSession';
import { FirstLaunch, type Starter } from './FirstLaunch';
import { GeniusNotice, GuideDialog } from './GuideDialog';

afterEach(() => { cleanup(); globalThis.localStorage?.clear(); layoutActions.forget(); preferenceActions.forget(); });

const text = (id: string, title: string, keywords: string, body: string) =>
  `---\nid: ${id}\ntitle: ${title}\nkeywords: [${keywords}]\nsources:\n  - label: GeniusBar #94 — soul retirement\n    url: https://github.com/qwts/GeniusBar/issues/94\n---\n${body}`;
const chapters: GuideChapter[] = orderChapters({
  '/g/01-start.md': text('start', 'Getting started', 'setup', 'observed: Choose **Set up** below.\n'),
  '/g/02-archive.md': text('archive', 'Archive versus deletion', 'remove, retire', 'observed: The folder moves to `.archive`.\n\ndesign: A team scope (#283).\n\n## Technical details\n- `agent-bot soul remove <agentId>`\n'),
  '/g/03-cli.md': text('cli', 'Command-line tools', 'terminal', 'observed: Wrappers go on your PATH.\n'),
}, null);
const meta = { draft: '2026-10-07', appVersion: '0.1.60', components: { 'agent-bot': '0.10.51', 'agent-comms': '0.3.14' }, chapters: [] };
const dialog = () => screen.getByRole('dialog', { name: 'App guide' });
const more = () => screen.getByRole('button', { name: 'More' });

describe('GuideDialog (#287)', () => {
  it('names the draft and the app version, lists the chapters and shows the first with its provenance', () => {
    render(<GuideDialog onClose={() => {}} chapters={chapters} meta={meta} />);
    const d = dialog();
    expect(document.activeElement).toBe(d);
    expect(within(d).getByText('Guide draft 2026-10-07 · GeniusBar 0.1.60')).toBeTruthy();
    expect(within(d).queryByText(/Design preview|proposed location/)).toBeNull();
    const nav = within(d).getByRole('navigation', { name: 'Chapters' });
    const items = within(nav).getAllByRole('button');
    expect(items.map((b) => b.textContent)).toEqual(['1.Getting started', '2.Archive versus deletion', '3.Command-line tools']);
    expect(items[0]?.getAttribute('aria-current')).toBe('page');
    expect(within(d).getByRole('heading', { level: 3, name: 'Getting started' })).toBeTruthy();
    expect(within(d).getByText('Observed in the app').className).toContain('text-success');
    expect(within(d).getByText('Set up').tagName).toBe('STRONG');
    expect(within(d).getByText('3 chapters found').className).toContain('sr-only');
    expect(within(d).getByText('Guide updates replace only the documentation inside Genius’s soul; memories, history and your changes are kept.')).toBeTruthy();
  });

  it('searches live, counts the results for screen readers, and selects a chapter with its details and sources', async () => {
    const opened: string[] = [];
    render(<GuideDialog onClose={() => {}} chapters={chapters} meta={meta} open={async (url) => { opened.push(url); }} />);
    const d = dialog();
    fireEvent.change(within(d).getByRole('searchbox', { name: 'Search the guide' }), { target: { value: 'ARCHIVE retire' } });
    expect(within(d).getByText('1 chapter found')).toBeTruthy();
    const nav = within(d).getByRole('navigation', { name: 'Chapters' });
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['2.Archive versus deletion']);
    // The sole result is shown without a click; its design paragraph is marked as such.
    expect(within(d).getByRole('heading', { level: 3, name: 'Archive versus deletion' })).toBeTruthy();
    expect(within(d).getByText('Design / proposed').className).toContain('text-info');
    const details = within(d).getByText('Technical details').closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText('agent-bot soul remove <agentId>').tagName).toBe('CODE');
    fireEvent.click(within(d).getByRole('button', { name: 'GeniusBar #94 — soul retirement' }));
    await waitFor(() => expect(opened).toEqual(['https://github.com/qwts/GeniusBar/issues/94']));
    expect(d.querySelector('a[href]')).toBeNull();
    fireEvent.change(within(d).getByRole('searchbox', { name: 'Search the guide' }), { target: { value: 'nothing here' } });
    expect(within(d).getByText('No chapters match.')).toBeTruthy();
    expect(within(d).getByText('0 chapters found')).toBeTruthy();
    expect(within(d).queryByRole('heading', { level: 3 })).toBeNull();
  });

  it('shows a refusal to open a source, and closes on Escape, the backdrop and Close', async () => {
    const onClose = vi.fn();
    render(<GuideDialog onClose={onClose} chapters={chapters} meta={meta} open={async () => { throw new BridgeError('identity-app-open-failed', 'no browser'); }} />);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'GeniusBar #94 — soul retirement' }));
    expect((await within(dialog()).findByRole('alert')).textContent).toBe('Could not open the browser: no browser');
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }));
    const backdrop = dialog().parentElement as HTMLElement;
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('says when the index was not built, and that the chapters are English when the chrome is not', () => {
    render(<GuideDialog onClose={() => {}} chapters={chapters} meta={null} />);
    expect(within(dialog()).getByText(/guide index is missing/)).toBeTruthy();
  });

  it('bundles the soul’s guide by default: the shipped chapters answer archive, parent and update questions', () => {
    render(<GuideDialog onClose={() => {}} />);
    const d = dialog();
    expect(within(d).getByText(`Guide draft ${GUIDE_META?.draft} · GeniusBar ${GUIDE_META?.appVersion}`)).toBeTruthy();
    const nav = within(d).getByRole('navigation', { name: 'Chapters' });
    expect(within(nav).getAllByRole('button')).toHaveLength(GUIDE.length);
    for (const [query, title] of [['archive', 'Archive versus deletion'], ['parent', 'Harness, model, provider and parent'], ['check for updates', 'Updates, services and About']]) {
      fireEvent.change(within(d).getByRole('searchbox'), { target: { value: query } });
      expect(within(nav).getAllByRole('button').some((b) => b.textContent?.includes(title)), query).toBe(true);
    }
  });
});

describe('GeniusNotice (#287)', () => {
  it('names the companion and the draft, and opens the guide', () => {
    const onOpen = vi.fn();
    render(<GeniusNotice name="Genius" onOpen={onOpen} meta={meta} />);
    expect(screen.getByRole('note').textContent).toContain('Genius is your guide to GeniusBar (guide draft 2026-10-07). Ask anything, or browse the guide.');
    fireEvent.click(screen.getByRole('button', { name: 'Open App guide' }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('leads Genius’s chat and no one else’s, opening the guide in the session and returning focus', () => {
    const chat = { entries: [], composer: emptyComposer, onDraft: () => {}, onSend: () => {} };
    const genius = { ...sampleCensus[0]!, name: 'Genius' };
    const { unmount } = render(<CompanionSession soul={genius} forest={[]} roster={[genius]} chat={chat} onOpen={() => {}} onClose={() => {}} />);
    const open = screen.getByRole('button', { name: 'Open App guide' });
    open.focus();
    fireEvent.click(open);
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'App guide' })).toBeNull();
    expect(document.activeElement).toBe(open);
    unmount();
    render(<CompanionSession soul={sampleCensus[0]!} forest={[]} roster={sampleCensus} chat={chat} onOpen={() => {}} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Open App guide' })).toBeNull();
  });
});

describe('App guide entry points (#287)', () => {
  const about: AboutSource = { info: async () => null, running: async () => null, open: async () => {} };

  it('opens from the footer ⋯ in the popup and returns focus to the ⋯', () => {
    render(<App census={sampleCensus} connection={sampleConnection} isStatic about={about} onRefresh={vi.fn()} />);
    fireEvent.click(more());
    fireEvent.click(screen.getByRole('menuitem', { name: 'App guide' }));
    expect(dialog()).toBeTruthy();
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'App guide' })).toBeNull();
    expect(document.activeElement).toBe(more());
  });

  it('opens from the window mode menu too', () => {
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic about={about} />);
    fireEvent.click(screen.getByRole('button', { name: 'GeniusBar menu' }));
    const menu = screen.getByRole('dialog', { name: 'GeniusBar menu' });
    fireEvent.click(within(menu).getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'App guide' }));
    expect(dialog()).toBeTruthy();
  });

  it('is linked from the setup screen and its ⋯ before setup is done', () => {
    const unpaired = { ...disconnected, bridgeConnected: true, unpaired: true };
    render(<App connection={unpaired} setup={idleSetup} onSetup={() => {}} onRefresh={vi.fn()} about={about} />);
    const link = screen.getByRole('button', { name: 'Open App guide' });
    link.focus();
    fireEvent.click(link);
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(document.activeElement).toBe(link);
    fireEvent.click(more());
    expect(screen.getByRole('menuitem', { name: 'App guide' })).toBeTruthy();
  });

  it('first launch says "Meet Genius, your guide" with the guide a click away, and launches as Genius', () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    const starter: Starter = { package: '/App/souls/starter.soul', account: 'friend', name: 'Genius', harnesses: ['claude'], devTools: true };
    render(<App census={[]} connection={sampleConnection} launcher={launcher} starter={starter} isStatic about={about} />);
    expect(screen.getByText('No companions yet. Meet Genius, your guide: a friendly first companion you can chat with and ask about GeniusBar.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open App guide' }));
    expect(dialog()).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start with Genius' }));
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ name: 'Genius', target: { package: '/App/souls/starter.soul' } }));
  });

  it('the first-launch form offers no guide link without an opener', () => {
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    const starter: Starter = { package: '/App/souls/starter.soul', account: 'friend', name: 'Genius', harnesses: ['claude'], devTools: true };
    render(<FirstLaunch starter={starter} launcher={launcher} />);
    expect(screen.queryByRole('button', { name: 'Open App guide' })).toBeNull();
  });

  it('About links to the guide: About closes, the guide opens, and focus returns to the ⋯ once the guide closes', async () => {
    render(<App census={sampleCensus} connection={sampleConnection} isStatic about={about} onRefresh={vi.fn()} />);
    fireEvent.click(more());
    fireEvent.click(screen.getByRole('menuitem', { name: 'About GeniusBar…' }));
    const aboutDialog = screen.getByRole('dialog', { name: 'About GeniusBar' });
    const links = within(aboutDialog).getByRole('navigation', { name: 'Help' });
    expect(within(links).getAllByRole('button').map((b) => b.textContent)).toEqual(['Release notes', 'Report a problem', 'App guide']);
    fireEvent.click(within(links).getByRole('button', { name: 'App guide' }));
    expect(screen.queryByRole('dialog', { name: 'About GeniusBar' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(dialog()));
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'App guide' })).toBeNull();
    expect(document.activeElement).toBe(more());
  });

  it('speaks Spanish for its chrome and says the chapters are English', () => {
    render(<App census={sampleCensus} connection={sampleConnection} isStatic about={about} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Language' }), { target: { value: 'es' } });
    fireEvent.click(screen.getByRole('button', { name: 'Más' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Guía de la app' }));
    const d = screen.getByRole('dialog', { name: 'Guía de la app' });
    expect(within(d).getByText(/Borrador de la guía .* · Los capítulos están en inglés/)).toBeTruthy();
    expect(within(d).getByRole('searchbox', { name: 'Buscar en la guía' })).toBeTruthy();
    expect(within(d).getAllByText('Observado en la app').length).toBeGreaterThan(0);
  });
});

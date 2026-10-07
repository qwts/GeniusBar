import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SurfaceRequest, SurfaceWindow } from '../bridge';
import type { Archiver } from '../components/ArchiveDialog';
import { sampleCensus, sampleProfile } from '../model/fixtures';
import { LAYOUT_KEY, layoutActions } from '../state/layout';
import type { PackageCheck } from '../soulPackage';
import type { LaunchApi } from '../useLaunch';
import { ProfileSourceContext, type ProfileSource } from '../useSoulProfile';
import { AuditSurface } from './AuditSurface';
import { CustomizeSurface } from './CustomizeSurface';
import { LaunchSurface } from './LaunchSurface';
import { HaltSurface, PerimeterSurface } from './PerimeterSurface';
import { SessionSurface } from './SessionSurface';
import { MOVE_SAVE_MS, TeamSurface, windowSizeFor } from './TeamSurface';

beforeEach(() => { localStorage.clear(); layoutActions.forget(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); document.title = ''; });

function fakeWindow() {
  let moved: (() => void) | null = null;
  const win: SurfaceWindow = {
    close: vi.fn(async () => {}),
    hide: vi.fn(async () => {}),
    setSize: vi.fn(async () => {}),
    position: vi.fn(async () => ({ x: 120.4, y: 80 })),
    onMoved: vi.fn(async (handler: () => void) => { moved = handler; return () => { moved = null; }; }),
    setTitle: vi.fn(async () => {}),
  };
  return { win, move: () => moved?.() };
}

function fakeOpen() {
  const opened: SurfaceRequest[] = [];
  const open = vi.fn(async (request: SurfaceRequest) => { opened.push(request); });
  return { opened, open };
}

const data = { census: sampleCensus, loaded: true };
const profiles: ProfileSource = { profile: async () => sampleProfile, file: async () => { throw new Error('none'); } };

describe('TeamSurface (#223)', () => {
  it('draws the lead\'s team card on a transparent page, its title a drag region', () => {
    const { win } = fakeWindow();
    render(<TeamSurface {...data} soul="user/agent_p" win={win} open={null} />);
    const card = screen.getByRole('region', { name: 'luna' });
    expect(document.documentElement.classList.contains('gb-transparent')).toBe(true);
    expect(card.className).toContain('relative');
    expect(card.className).not.toContain('absolute');
    expect(card.querySelector('[data-tauri-drag-region]')).not.toBeNull();
    expect(screen.getByRole('button', { name: /^agent_c,/ })).toBeTruthy();
    cleanup();
    expect(document.documentElement.classList.contains('gb-transparent')).toBe(false);
  });

  it('draws nothing for a team the census does not list', () => {
    const { container } = render(<TeamSurface {...data} soul="user/nobody" win={null} open={null} />);
    expect(container.textContent).toBe('');
  });

  it('opens sessions, archive and Customize in their own windows', async () => {
    const { opened, open } = fakeOpen();
    render(
      <ProfileSourceContext.Provider value={profiles}>
        <TeamSurface {...data} soul="user/agent_p" win={null} open={open} />
      </ProfileSourceContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /^agent_c,/ }));
    fireEvent.contextMenu(screen.getByRole('button', { name: /^agent_c,/ }), { clientX: 5, clientY: 5 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove…' }));
    fireEvent.contextMenu(screen.getByRole('button', { name: /^luna,/ }), { clientX: 5, clientY: 5 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Customize…' }));
    await waitFor(() => expect(opened).toEqual([
      { surface: 'session', soul: 'user/agent_c' },
      { surface: 'session', soul: 'user/agent_c', action: 'archive' },
      { surface: 'customize', soul: 'user/agent_p' },
    ]));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('collapses and hides through the shared layout', () => {
    render(<TeamSurface {...data} soul="user/agent_p" win={null} open={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse team' }));
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!).collapsed).toEqual(['user/agent_p']);
    expect(screen.queryByRole('button', { name: /^agent_c,/ })).toBeNull();
  });

  it('sizes its window to the card, and keeps the card\'s size for the coordinator', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return (this.getAttribute('role') === 'menu' ? new DOMRect(150, 40, 160, 200) : new DOMRect(0, 0, 300, 175.5));
    });
    const { win } = fakeWindow();
    render(<TeamSurface {...data} soul="user/agent_p" win={win} open={null} />);
    await waitFor(() => expect(win.setSize).toHaveBeenCalledWith(300, 176));
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!).size).toEqual({ 'user/agent_p': { width: 300, height: 176 } });
    // A menu hanging past the card grows the window, not the card's size.
    fireEvent.contextMenu(screen.getByRole('button', { name: /^agent_c,/ }), { clientX: 5, clientY: 5 });
    await waitFor(() => expect(win.setSize).toHaveBeenLastCalledWith(310, 240));
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!).size['user/agent_p']).toEqual({ width: 300, height: 176 });
  });

  it('saves where a drag left the window, once', async () => {
    vi.useFakeTimers();
    const move = vi.spyOn(layoutActions, 'place');
    const { win, move: drag } = fakeWindow();
    render(<TeamSurface {...data} soul="user/agent_p" win={win} open={null} />);
    await act(async () => { await Promise.resolve(); });
    drag();
    drag();
    await act(async () => { vi.advanceTimersByTime(MOVE_SAVE_MS); });
    expect(move).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!).screen).toEqual({ 'user/agent_p': { x: 120, y: 80 } });
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!).pos).toEqual({});
    // The coordinator placing it there again is no change.
    drag();
    await act(async () => { vi.advanceTimersByTime(MOVE_SAVE_MS); });
    expect(move).toHaveBeenCalledTimes(1);
  });

  it('measures menus and hover cards with the card', () => {
    const card = document.createElement('section');
    const menu = document.createElement('div');
    menu.setAttribute('role', 'tooltip');
    card.append(menu);
    card.getBoundingClientRect = () => new DOMRect(0, 0, 200, 64);
    menu.getBoundingClientRect = () => new DOMRect(-20, 50, 224, 120.2);
    expect(windowSizeFor(card)).toEqual({ width: 204, height: 171, card: { width: 200, height: 64 } });
  });
});

describe('SessionSurface (#223)', () => {
  const archiver: Archiver = {
    running: async () => false,
    remove: vi.fn(async (agentId: string) => ({ agentId, name: 'luna', comms: 'left', archived: [] })),
  };

  it('is the companion window\'s chrome without its close dot, titled for the window', async () => {
    const { win } = fakeWindow();
    render(<SessionSurface {...data} soul="user/agent_p" tab="audit" action={null} win={win} open={null} />);
    expect(screen.queryByRole('button', { name: 'Close window' })).toBeNull();
    const heading = screen.getAllByRole('heading', { name: 'luna' })[0];
    const header = heading.parentElement!;
    expect(header.hasAttribute('data-tauri-drag-region')).toBe(true);
    expect(header.className).toContain('pl-[72px]');
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('Audit log');
    expect(document.title).toBe('luna — GeniusBar');
    await waitFor(() => expect(win.setTitle).toHaveBeenCalledWith('luna — GeniusBar'));
  });

  it('offers the header\'s Stop from the shared badges and the live stopper (#122)', async () => {
    const { win } = fakeWindow();
    const stopped: string[] = [];
    const stopper = { supported: async () => true, stop: async (id: string) => { stopped.push(id); return { agentId: id, stopped: true } as never; } };
    const badges = { comms: new Set<string>(), computerUse: new Set(['agent_c']), busy: new Set<string>() };
    render(<SessionSurface {...data} badges={badges} stopper={stopper} soul="user/agent_c" tab={null} action={null} win={win} open={null} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop: agent_c is using the computer' }));
    await waitFor(() => expect(stopped).toEqual(['agent_c']));
  });

  it('closes the window on Escape outside a field, once', () => {
    const { win } = fakeWindow();
    render(<SessionSurface {...data} soul="user/agent_p" tab={null} action={null} win={win} open={null} />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.keyDown(screen.getAllByRole('tab')[0], { key: 'Escape' });
    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it('opens with the Archive confirmation for action=archive, and closes once archived', async () => {
    const { win } = fakeWindow();
    render(<SessionSurface {...data} soul="user/agent_p" tab={null} action="archive" win={win} open={null} archiver={archiver} />);
    const dialog = screen.getByRole('alertdialog');
    const archive = within(dialog).getByRole('button', { name: 'Archive' });
    await waitFor(() => expect((archive as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(archive);
    await waitFor(() => expect(win.close).toHaveBeenCalled());
    expect(archiver.remove).toHaveBeenCalledWith('agent_p');
  });

  it('opens the delegation tree\'s companions in their own windows', async () => {
    const { opened, open } = fakeOpen();
    render(<SessionSurface {...data} soul="user/agent_p" tab="tree" action={null} win={null} open={open} />);
    fireEvent.click(within(screen.getByRole('tabpanel')).getByRole('button', { name: /agent_c/ }));
    await waitFor(() => expect(opened).toEqual([{ surface: 'session', soul: 'user/agent_c' }]));
  });

  it('says so when the companion has gone, and waits while the census loads', () => {
    render(<SessionSurface {...data} soul="user/nobody" tab={null} action={null} win={null} open={null} />);
    expect(screen.getByText('This companion is no longer in your roster.')).toBeTruthy();
    cleanup();
    render(<SessionSurface census={[]} loaded={false} soul="user/agent_p" tab={null} action={null} win={null} open={null} />);
    expect(screen.queryByText('This companion is no longer in your roster.')).toBeNull();
  });
});

describe('the other window surfaces (#223)', () => {
  it('audit: every companion\'s records, or one\'s; Escape closes', () => {
    const { win } = fakeWindow();
    render(<AuditSurface {...data} soul={null} win={win} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Audit log · All activity');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(win.close).toHaveBeenCalledTimes(1);
    cleanup();
    render(<AuditSurface {...data} soul="user/agent_p" win={null} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Audit log · luna');
    expect(document.title).toBe('Audit log · luna — GeniusBar');
  });

  it('customize: the dialog is the page, with no backdrop; Escape closes', () => {
    const { win } = fakeWindow();
    const { container } = render(
      <ProfileSourceContext.Provider value={profiles}>
        <CustomizeSurface {...data} soul="user/agent_p" win={win} />
      </ProfileSourceContext.Provider>,
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(container.querySelector('.bg-black\\/80')).toBeNull();
    expect(document.body.querySelector('.bg-black\\/80')).toBeNull();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(win.close).toHaveBeenCalled();
  });

  it('launch: the form is the page, with no backdrop; Cancel closes', () => {
    const { win } = fakeWindow();
    const { opened, open } = fakeOpen();
    const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
    const view = render(<LaunchSurface {...data} win={win} launcher={launcher} open={open} />);
    expect(screen.getByRole('dialog', { name: 'Launch a new companion' })).toBeTruthy();
    expect(view.container.querySelector('.bg-black\\/80')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(win.close).toHaveBeenCalledTimes(1);
    expect(opened).toEqual([]);
  });
});

describe('LaunchSurface with a dropped package (#98)', () => {
  const idle = (): LaunchApi => ({ state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() });

  it('checks the package, then fills the form as a Finder-opened one', async () => {
    let answer: (value: PackageCheck) => void = () => {};
    const checkPackage = vi.fn(() => new Promise<PackageCheck>((resolve) => { answer = resolve; }));
    render(<LaunchSurface {...data} win={null} launcher={idle()} open={null} packagePath="/souls/helper.soul/" checkPackage={checkPackage} />);
    expect(await screen.findByText('Checking this companion package…')).toBeTruthy();
    expect(checkPackage).toHaveBeenCalledWith('/souls/helper.soul/');
    await act(async () => { answer({ error: null, name: 'Helper - Starter', description: 'Answers questions about this Mac.', preferredHarnesses: ['opencode'] }); });
    expect(screen.queryByText('Checking this companion package…')).toBeNull();
    expect(screen.getByText('Answers questions about this Mac.')).toBeTruthy();
    expect((screen.getByPlaceholderText('Optional') as HTMLInputElement).value).toBe('Helper');
  });

  it('shows why a package cannot be launched', async () => {
    const checkPackage = vi.fn(async (): Promise<PackageCheck> => ({ error: 'Two folders claim this companion.' }));
    render(<LaunchSurface {...data} win={null} launcher={idle()} open={null} packagePath="/souls/dup.soul" checkPackage={checkPackage} />);
    expect((await screen.findByRole('alert')).textContent).toContain('Two folders claim this companion.');
  });

  it('opens an installed soul\'s session instead of a new launch, and closes', async () => {
    const { win } = fakeWindow();
    const { opened, open } = fakeOpen();
    const checkPackage = vi.fn(async (): Promise<PackageCheck> => ({ error: null, agentId: 'agent_p' }));
    render(<LaunchSurface {...data} win={win} launcher={idle()} open={open} packagePath="/souls/Luna - Starter.soul" checkPackage={checkPackage} />);
    await waitFor(() => expect(opened).toEqual([{ surface: 'session', soul: 'user/agent_p' }]));
    expect(win.close).toHaveBeenCalled();
  });

  it('takes the path as is outside the app, and checks nothing without a package', () => {
    const checkPackage = vi.fn(async (): Promise<PackageCheck> => ({ error: null }));
    const view = render(<LaunchSurface {...data} win={null} launcher={idle()} open={null} packagePath="/souls/helper.soul" />);
    expect(screen.queryByText('Checking this companion package…')).toBeNull();
    expect((screen.getByLabelText('Path to soul, ending with .soul') as HTMLInputElement).value).toBe('/souls/helper.soul');
    view.unmount();
    render(<LaunchSurface {...data} win={null} launcher={idle()} open={null} checkPackage={checkPackage} />);
    expect(checkPackage).not.toHaveBeenCalled();
  });
});

describe('TeamSurface drop cue (#98)', () => {
  it('draws a dashed border over the card only while a .soul hovers', () => {
    const { rerender } = render(<TeamSurface {...data} soul="user/agent_p" win={null} open={null} />);
    expect(screen.queryByTestId('soul-drop-cue')).toBeNull();
    rerender(<TeamSurface {...data} soul="user/agent_p" win={null} open={null} dropping />);
    expect(screen.getByTestId('soul-drop-cue').className).toContain('border-dashed');
  });
});

describe('PerimeterSurface and HaltSurface (#122)', () => {
  it('draws the border on a transparent page', () => {
    const { container } = render(<PerimeterSurface />);
    expect(document.documentElement.classList.contains('gb-transparent')).toBe(true);
    expect(container.querySelector('.perimeter')).not.toBeNull();
    cleanup();
    expect(document.documentElement.classList.contains('gb-transparent')).toBe(false);
  });

  it('names the soul driving the screen and halts it from Stop', async () => {
    const stopped: string[] = [];
    const stopper = { supported: async () => true, stop: async (id: string) => { stopped.push(id); return { agentId: id, stopped: true } as never; } };
    const badges = { comms: new Set<string>(), computerUse: new Set(['agent_p']), busy: new Set<string>() };
    render(<HaltSurface census={sampleCensus} badges={badges} stopper={stopper} />);
    expect(document.documentElement.classList.contains('gb-transparent')).toBe(true);
    const pill = await screen.findByRole('alert');
    expect(pill.textContent).toContain('luna');
    fireEvent.click(within(pill).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(stopped).toEqual(['agent_p']));
    expect(within(pill).getByRole('button').textContent).toContain('Stopping');
  });

  it('shows nothing while no soul drives the screen, and no Stop without a stopper', () => {
    const { container, rerender } = render(<HaltSurface census={sampleCensus} badges={{ comms: new Set(), computerUse: new Set(), busy: new Set() }} />);
    expect(container.textContent).toBe('');
    rerender(<HaltSurface census={sampleCensus} badges={{ comms: new Set(), computerUse: new Set(['agent_p']), busy: new Set() }} />);
    expect(screen.getByRole('status').textContent).toContain('luna');
    expect(screen.queryByRole('button')).toBeNull();
  });
});

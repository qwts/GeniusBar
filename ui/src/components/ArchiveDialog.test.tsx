import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { BridgeError, type RemovedSoul } from '../bridge';
import { I18nProvider } from '../lib/i18n';
import { sampleBadges, sampleCensus, sampleConnection } from '../model/fixtures';
import { LAYOUT_KEY, layoutActions } from '../state/layout';
import { ArchiveDialog, type Archiver } from './ArchiveDialog';

afterEach(() => { cleanup(); globalThis.localStorage?.clear(); layoutActions.forget(); });

const [luna] = sampleCensus;
const removed = (agentId: string, comms = 'left'): RemovedSoul =>
  ({ agentId, name: null, comms, archived: [{ from: `/souls/${agentId}`, to: `/souls/.archive/${agentId}` }] });
const archiverOf = (running: boolean | null, remove: Archiver['remove'] = async (id) => removed(id)): Archiver =>
  ({ running: vi.fn(async () => running), remove: vi.fn(remove) });

function renderDialog(archiver: Archiver, onCancel = vi.fn(), onArchived = vi.fn()) {
  render(<I18nProvider><ArchiveDialog soul={luna} archiver={archiver} onCancel={onCancel} onArchived={onArchived} /></I18nProvider>);
  return { dialog: screen.getByRole('alertdialog', { name: /^Archive luna\?/ }), onCancel, onArchived };
}

describe('ArchiveDialog (#94)', () => {
  it('names the soul and says what happens, then archives once agent-bot says it is not running', async () => {
    const archiver = archiverOf(false);
    const { dialog, onArchived } = renderDialog(archiver);
    expect(within(dialog).getByText(/Archive luna\? They leave the desktop/)).toBeTruthy();
    expect(within(dialog).getByText('Agent ID: agent_p')).toBeTruthy();
    for (const line of ['Stops waking on new messages.', 'Leaves agent comms.', 'Nothing is deleted.']) {
      expect(within(dialog).getByText(line)).toBeTruthy();
    }
    expect(within(dialog).getByText(/folder moved to \.archive/)).toBeTruthy();
    const archive = within(dialog).getByRole('button', { name: 'Archive' }) as HTMLButtonElement;
    expect(archive.disabled).toBe(true);
    await waitFor(() => expect(archive.disabled).toBe(false));
    expect(archiver.running).toHaveBeenCalledWith('agent_p');
    fireEvent.click(archive);
    await waitFor(() => expect(onArchived).toHaveBeenCalledWith(luna, removed('agent_p')));
    expect(archiver.remove).toHaveBeenCalledWith('agent_p');
  });

  it('is locked with a why while the soul runs', async () => {
    const { dialog } = renderDialog(archiverOf(true));
    await waitFor(() => expect(within(dialog).getByText('Stop the companion to archive it.')).toBeTruthy());
    expect((within(dialog).getByRole('button', { name: 'Archive' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('allows archiving when agent-bot cannot say, and shows a refusal as-is while the soul stays', async () => {
    const archiver = archiverOf(null, async () => { throw new BridgeError('soul-running', 'agent_p is running; stop it before removing it'); });
    const { dialog, onArchived } = renderDialog(archiver);
    const archive = within(dialog).getByRole('button', { name: 'Archive' }) as HTMLButtonElement;
    await waitFor(() => expect(archive.disabled).toBe(false));
    fireEvent.click(archive);
    expect(within(dialog).getByRole('status').textContent).toBe('Waiting for your approval…');
    expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'agent_p is running; stop it before removing it');
    expect(onArchived).not.toHaveBeenCalled();
    expect(archive.disabled).toBe(false);
  });

  it('cancels from the button, Escape, or the backdrop', () => {
    const { dialog, onCancel } = renderDialog(archiverOf(false));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(dialog.parentElement!);
    expect(onCancel).toHaveBeenCalledTimes(3);
  });
});

describe('Archive in the app (#94)', () => {
  const desktop = () => screen.getByRole('main', { name: 'Fleet' });

  it('archives from the desktop’s menu: says so and refreshes the census', async () => {
    const onRefresh = vi.fn();
    const archiver = archiverOf(false);
    layoutActions.setHidden('user/agent_c', true);
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic archiver={archiver} onRefresh={onRefresh} />);
    fireEvent.contextMenu(within(desktop()).getByRole('button', { name: /^old,/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove…' }));
    const dialog = screen.getByRole('alertdialog', { name: /^Archive old\?/ });
    const archive = within(dialog).getByRole('button', { name: 'Archive' }) as HTMLButtonElement;
    await waitFor(() => expect(archive.disabled).toBe(false));
    fireEvent.click(archive);
    expect(await screen.findByText('old archived')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(archiver.remove).toHaveBeenCalledWith('agent_gone');
    expect(onRefresh).toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!).hidden).toEqual(['user/agent_c']);
  });

  it('archives from the menu’s fleet row, drops it from the hidden list, and reports a comms leave still pending', async () => {
    const archiver = archiverOf(false, async (id) => removed(id, 'not left: the hub is unreachable'));
    layoutActions.setHidden('user/agent_p', true);
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic archiver={archiver} />);
    fireEvent.click(screen.getByRole('button', { name: 'GeniusBar menu' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'GeniusBar menu' })).getByRole('button', { name: 'Archive: luna' }));
    const dialog = screen.getByRole('alertdialog', { name: /^Archive luna\?/ });
    const archive = within(dialog).getByRole('button', { name: 'Archive' }) as HTMLButtonElement;
    await waitFor(() => expect(archive.disabled).toBe(false));
    fireEvent.click(archive);
    expect(await screen.findByText('luna archived, but it hasn’t left agent comms yet: the hub is unreachable')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!).hidden).toEqual([]);
  });

  it('offers no Archive without an archiver (outside the app)', () => {
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic />);
    fireEvent.contextMenu(within(desktop()).getByRole('button', { name: /^luna,/ }));
    expect(screen.queryByRole('menuitem', { name: 'Remove…' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'GeniusBar menu' }));
    expect(screen.queryByRole('button', { name: /^Archive:/ })).toBeNull();
  });
});

describe('desktop badges (#122)', () => {
  const desktop = () => screen.getByRole('main', { name: 'Fleet' });

  it('marks agent comms and computer use on the avatar and in its label', () => {
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic badges={sampleBadges} />);
    const lunaButton = within(desktop()).getByRole('button', { name: /^luna,/ });
    expect(lunaButton.getAttribute('aria-label')).toMatch(/, Comms enabled — wakes on new messages$/);
    expect(lunaButton.querySelector('.bg-success')).toBeTruthy();
    expect(lunaButton.querySelector('.bg-warning')).toBeNull();
    const child = within(desktop()).getByRole('button', { name: /^agent_c,/ });
    expect(child.getAttribute('aria-label')).toMatch(/, Controlling your screen$/);
    expect(child.querySelector('.bg-warning')).toBeTruthy();
    expect(child.querySelector('.bg-success')).toBeNull();
  });

  it('shows none without badges', () => {
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic />);
    expect(desktop().querySelector('.bg-success, .bg-warning')).toBeNull();
  });
});

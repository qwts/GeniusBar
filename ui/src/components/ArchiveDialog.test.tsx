import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { BridgeError, type RemovalPlan, type RemovalScope, type RemovedSoul } from '../bridge';
import { I18nProvider, translate } from '../lib/i18n';
import { sampleBadges, sampleCensus, sampleConnection, sampleRemovalPlan } from '../model/fixtures';
import { LAYOUT_KEY, layoutActions } from '../state/layout';
import { ArchiveDialog, archivedNotice, type Archiver } from './ArchiveDialog';

afterEach(() => { cleanup(); globalThis.localStorage?.clear(); layoutActions.forget(); });

const [luna] = sampleCensus;
const removed = (agentId: string, comms = 'left'): RemovedSoul =>
  ({ agentId, name: null, comms, archived: [{ from: `/souls/${agentId}`, to: `/souls/.archive/${agentId}` }] });
/** A standalone plan for any soul, as an engine with `--plan` gives one that leads nobody. */
const alone = async (agentId: string, scope: RemovalScope): Promise<RemovalPlan> => ({
  schemaVersion: 1, scope, agentId, capabilities: { plan: true, team: true, independent: true, restore: false, delete: false },
  archived: [{ agentId, name: null, displayName: agentId, status: 'active', harness: null, parentId: null, running: false, depth: 0 }], independent: [], unchanged: [],
});
const archiverOf = (running: boolean | null, remove: Archiver['remove'] = async (id) => removed(id), plan: Archiver['plan'] = alone): Archiver =>
  ({ running: vi.fn(async () => running), remove: vi.fn(remove), plan: vi.fn(plan) });

function renderDialog(archiver: Archiver, onCancel = vi.fn(), onArchived = vi.fn(), soul = luna) {
  render(<I18nProvider><ArchiveDialog soul={soul} archiver={archiver} onCancel={onCancel} onArchived={onArchived} /></I18nProvider>);
  return { dialog: screen.getByRole('alertdialog', { name: /^Archive luna\?/ }), onCancel, onArchived };
}
const archiveButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: /^Archive / }) as HTMLButtonElement;
const names = (list: HTMLElement) => within(list).getAllByRole('listitem').map((li) => li.textContent);

describe('ArchiveDialog (#94)', () => {
  it('names the soul and what stays, then archives once agent-bot says it is not running', async () => {
    const archiver = archiverOf(false);
    const { dialog, onArchived } = renderDialog(archiver);
    expect(within(dialog).getByRole('heading').textContent).toContain('Archive luna?');
    expect(within(dialog).getByText('luna leaves the desktop and stops waking for new messages. Conversations, memory, work and history stay with the soul and are kept.')).toBeTruthy();
    expect(within(dialog).getByText('Agent ID: agent_p')).toBeTruthy();
    for (const line of ['Stops waking on new messages.', 'Leaves agent comms.', 'Nothing is deleted.']) {
      expect(within(dialog).getByText(line)).toBeTruthy();
    }
    expect(within(dialog).getByText(/folder moved to \.archive/)).toBeTruthy();
    expect(within(dialog).getByText(/Bringing an archived soul back, or deleting it for good, isn’t offered here/)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /restore|delete/i })).toBeNull();
    const archive = archiveButton(dialog);
    expect(archive.textContent).toBe('Archive luna');
    expect(archive.disabled).toBe(true);
    await waitFor(() => expect(archive.disabled).toBe(false));
    expect(archiver.running).toHaveBeenCalledWith('agent_p');
    // A plan for a soul that leads nobody: one name, no scope to choose.
    expect(names(within(dialog).getByRole('list', { name: 'Will be archived' }))).toEqual(['agent_p · offline']);
    expect(within(dialog).queryByRole('radio')).toBeNull();
    fireEvent.click(archive);
    await waitFor(() => expect(onArchived).toHaveBeenCalledWith(luna, removed('agent_p')));
    expect(archiver.remove).toHaveBeenCalledWith('agent_p', 'soul');
  });

  it('is locked with a why while the soul runs', async () => {
    const { dialog } = renderDialog(archiverOf(true));
    await waitFor(() => expect(within(dialog).getByText('Stop the companion to archive it.')).toBeTruthy());
    expect(archiveButton(dialog).disabled).toBe(true);
  });

  it('allows archiving when agent-bot cannot say, and shows a refusal as-is while the soul stays', async () => {
    const archiver = archiverOf(null, async () => { throw new BridgeError('soul-running', 'agent_p is running; stop it before removing it'); });
    const { dialog, onArchived } = renderDialog(archiver);
    const archive = archiveButton(dialog);
    await waitFor(() => expect(archive.disabled).toBe(false));
    fireEvent.click(archive);
    expect(within(dialog).getByRole('status').textContent).toBe('Waiting for your approval…');
    expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'agent_p is running; stop it before removing it');
    expect(onArchived).not.toHaveBeenCalled();
    expect(archive.disabled).toBe(false);
  });

  it('focuses Cancel first, changes nothing on Cancel, Escape or the backdrop, and gives focus back to the opener', () => {
    const opener = document.createElement('button');
    opener.textContent = 'Remove…';
    document.body.append(opener);
    opener.focus();
    const archiver = archiverOf(false);
    const onCancel = vi.fn();
    const { unmount } = render(<I18nProvider><ArchiveDialog soul={luna} archiver={archiver} onCancel={onCancel} onArchived={vi.fn()} /></I18nProvider>);
    const dialog = screen.getByRole('alertdialog');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(dialog.parentElement!);
    expect(onCancel).toHaveBeenCalledTimes(3);
    expect(archiver.remove).not.toHaveBeenCalled();
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe('ArchiveDialog plan and scope (#283)', () => {
  const planned = (running = false, remove: Archiver['remove'] = async (id) => removed(id)) =>
    archiverOf(running, remove, async (agentId, scope) => sampleRemovalPlan(agentId, scope));

  it('offers the scope for a lead and lists exactly what the engine’s plan names, nested, with each state', async () => {
    const archiver = planned();
    const { dialog } = renderDialog(archiver);
    const group = await within(dialog).findByRole('group', { name: 'What to archive' });
    const only = within(group).getByRole('radio', { name: 'Only luna — the companions it leads become independent' }) as HTMLInputElement;
    expect(only.checked).toBe(true);
    await waitFor(() => expect(within(group).getByRole('radio', { name: 'luna and its team (3 souls)' })).toBeTruthy());
    expect(names(within(dialog).getByRole('list', { name: 'Will be archived' }))).toEqual(['luna · offline']);
    expect(names(within(dialog).getByRole('list', { name: 'Become independent (no lead)' }))).toEqual(['agent_c · running']);
    const unchanged = within(dialog).getByRole('list', { name: 'Unchanged' });
    expect(names(unchanged)).toEqual(['Sprocket (sprocket) · offline']);
    expect((within(unchanged).getByRole('listitem') as HTMLElement).style.paddingLeft).toBe('24px');
    expect(within(dialog).getByText('Will be archived (1)')).toBeTruthy();
    const archive = archiveButton(dialog);
    await waitFor(() => expect(archive.disabled).toBe(false));
    expect(archive.textContent).toBe('Archive luna');
    fireEvent.click(archive);
    await waitFor(() => expect(archiver.remove).toHaveBeenCalledWith('agent_p', 'soul'));
  });

  it('refreshes the plan for the team scope, counts it on the button, and is locked while one of them runs', async () => {
    const archiver = planned();
    const { dialog } = renderDialog(archiver);
    const group = await within(dialog).findByRole('group', { name: 'What to archive' });
    fireEvent.click(within(group).getByRole('radio', { name: /^luna and its team/ }));
    await waitFor(() => expect(names(within(dialog).getByRole('list', { name: 'Will be archived' }))).toEqual(['luna · offline', 'agent_c · running', 'Sprocket (sprocket) · offline']));
    expect(archiver.plan).toHaveBeenCalledWith('agent_p', 'team');
    expect(within(dialog).queryByRole('list', { name: 'Become independent (no lead)' })).toBeNull();
    expect(within(dialog).getByText('Will be archived (3)')).toBeTruthy();
    const archive = archiveButton(dialog);
    expect(archive.textContent).toBe('Archive 3 souls');
    expect(archive.disabled).toBe(true);
    expect(within(dialog).getByText('agent_c is running. Stop it to archive the team.')).toBeTruthy();
    expect(archiver.remove).not.toHaveBeenCalled();
    // Back to the soul alone: its own plan again, unlocked.
    fireEvent.click(within(group).getByRole('radio', { name: /^Only luna/ }));
    await waitFor(() => expect(archiveButton(dialog).disabled).toBe(false));
    expect(archiveButton(dialog).textContent).toBe('Archive luna');
  });

  it('archives the team through the engine and reports its effects', async () => {
    const result: RemovedSoul = {
      ...removed('agent_p'),
      effects: {
        scope: 'team', notArchived: [], independent: [],
        archived: [{ agentId: 'agent_s', name: 'Sprocket', comms: 'left' }, { agentId: 'agent_c', name: null, comms: 'left' }, { agentId: 'agent_p', name: 'luna', comms: 'left' }],
      },
    };
    const archiver = archiverOf(false, async () => result, async (agentId, scope) => {
      const plan = sampleRemovalPlan(agentId, scope);
      return { ...plan, archived: plan.archived.map((e) => ({ ...e, running: false })) };
    });
    const { dialog, onArchived } = renderDialog(archiver);
    fireEvent.click(await within(dialog).findByRole('radio', { name: /^luna and its team/ }));
    await waitFor(() => expect(archiveButton(dialog).textContent).toBe('Archive 3 souls'));
    await waitFor(() => expect(archiveButton(dialog).disabled).toBe(false));
    fireEvent.click(archiveButton(dialog));
    await waitFor(() => expect(onArchived).toHaveBeenCalledWith(luna, result));
    expect(archiver.remove).toHaveBeenCalledWith('agent_p', 'team');
    const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars);
    expect(archivedNotice(t, 'luna', result)).toBe('Sprocket, agent_c, luna archived');
    expect(archivedNotice(t, 'luna', { ...removed('agent_p'), effects: { scope: 'soul', archived: [{ agentId: 'agent_p', name: 'luna', comms: 'left' }], independent: [{ agentId: 'agent_c', name: null, displayName: 'agent_c', formerParentId: 'agent_p' }], notArchived: [] } }))
      .toBe('luna archived · agent_c now independent');
    expect(archivedNotice(t, 'luna', removed('agent_p', 'not left: the hub is unreachable'))).toBe('luna archived, but it hasn’t left agent comms yet: the hub is unreachable');
  });

  it('shows the engine’s refusal and a partial team failure verbatim', async () => {
    const message = 'agent_c is retired, but its folder could not be moved into the souls folder\'s .archive: EBUSY; close whatever holds the folder open (or move it there by hand), then run soul remove again; archived so far: agent_s; not archived: agent_c, agent_p';
    const archiver = archiverOf(false, async () => { throw new BridgeError('soul-archive-failed', message); }, async (agentId, scope) => {
      const plan = sampleRemovalPlan(agentId, scope);
      return { ...plan, archived: plan.archived.map((e) => ({ ...e, running: false })) };
    });
    const { dialog, onArchived } = renderDialog(archiver);
    fireEvent.click(await within(dialog).findByRole('radio', { name: /^luna and its team/ }));
    await waitFor(() => expect(archiveButton(dialog).textContent).toBe('Archive 3 souls'));
    await waitFor(() => expect(archiveButton(dialog).disabled).toBe(false));
    fireEvent.click(archiveButton(dialog));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(message);
    expect(onArchived).not.toHaveBeenCalled();
  });

  it('stays the single-soul dialog with an engine that cannot plan, saying so and guessing nothing about the team', async () => {
    const archiver = archiverOf(false, async (id) => removed(id), async () => null);
    const { dialog, onArchived } = renderDialog(archiver);
    await waitFor(() => expect(within(dialog).getByText('This agent-bot archives only luna; it can’t say what happens to the companions it leads.')).toBeTruthy());
    expect(within(dialog).queryByRole('radio')).toBeNull();
    expect(within(dialog).queryByRole('list', { name: /archived|independent|Unchanged/ })).toBeNull();
    expect(within(dialog).queryByText(/agent_c|Sprocket/)).toBeNull();
    const archive = archiveButton(dialog);
    expect(archive.textContent).toBe('Archive luna');
    await waitFor(() => expect(archive.disabled).toBe(false));
    fireEvent.click(archive);
    await waitFor(() => expect(onArchived).toHaveBeenCalledWith(luna, removed('agent_p')));
    expect(archiver.remove).toHaveBeenCalledWith('agent_p', undefined);
  });

  it('says when the plan could not be read and still offers the single archive', async () => {
    const archiver = archiverOf(false, async (id) => removed(id), async () => { throw new BridgeError('soul-remove-failed', 'no population record for agent_p'); });
    const { dialog } = renderDialog(archiver);
    await waitFor(() => expect(within(dialog).getByText('agent-bot couldn’t say what this touches: no population record for agent_p')).toBeTruthy());
    await waitFor(() => expect(archiveButton(dialog).disabled).toBe(false));
    fireEvent.click(archiveButton(dialog));
    await waitFor(() => expect(archiver.remove).toHaveBeenCalledWith('agent_p', undefined));
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
    const archive = within(dialog).getByRole('button', { name: 'Archive old' }) as HTMLButtonElement;
    await waitFor(() => expect(archive.disabled).toBe(false));
    fireEvent.click(archive);
    expect(await screen.findByText('old archived')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(archiver.remove).toHaveBeenCalledWith('agent_gone', 'soul');
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
    const archive = within(dialog).getByRole('button', { name: 'Archive luna' }) as HTMLButtonElement;
    await waitFor(() => expect(archive.disabled).toBe(false));
    fireEvent.click(archive);
    expect(await screen.findByText('luna archived, but it hasn’t left agent comms yet: the hub is unreachable')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!).hidden).toEqual([]);
  });

  it('names everything the engine archived and made independent (#283)', async () => {
    const archiver = archiverOf(false, async (id) => ({
      ...removed(id),
      effects: { scope: 'soul', archived: [{ agentId: id, name: 'luna', comms: 'left' }], independent: [{ agentId: 'agent_c', name: null, displayName: 'agent_c', formerParentId: id }], notArchived: [] },
    }));
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic archiver={archiver} />);
    fireEvent.click(screen.getByRole('button', { name: 'GeniusBar menu' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'GeniusBar menu' })).getByRole('button', { name: 'Archive: luna' }));
    const dialog = screen.getByRole('alertdialog', { name: /^Archive luna\?/ });
    const archive = within(dialog).getByRole('button', { name: 'Archive luna' }) as HTMLButtonElement;
    await waitFor(() => expect(archive.disabled).toBe(false));
    fireEvent.click(archive);
    expect(await screen.findByText('luna archived · agent_c now independent')).toBeTruthy();
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

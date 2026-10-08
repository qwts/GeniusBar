import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSoulForest, type CensusRow } from '../model/census';
import { sampleCensus } from '../model/fixtures';
import { noBadges, type SoulBadges } from '../model/refresh';
import { translate } from '../lib/i18n';
import { layoutActions, useLayout } from '../state/layout';
import { samplePreparedRevision, sampleProfile } from '../model/fixtures';
import { ProfileSourceContext, type ProfileSource } from '../useSoulProfile';
import { CompanionWindow, Desktop } from './Desktop';
import { noStatus, soulStatus, statusText } from './DesktopStatus';
import { HOVER_OPEN_MS } from './HoverCard';

const [luna, child, left] = sampleCensus;
const forest = buildSoulForest(sampleCensus);
const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars);

function Live({ badges = noBadges, awaiting, fleetPaused, onOpen = () => {} }: {
  badges?: SoulBadges; awaiting?: ReadonlySet<string>; fleetPaused?: boolean; onOpen?: (soul: CensusRow) => void;
}) {
  const layout = useLayout();
  return <Desktop forest={forest} layout={layout} paused selectedKey={null} onOpen={onOpen} badges={badges}
    awaiting={awaiting} fleetPaused={fleetPaused} />;
}

const avatar = (name: RegExp) => screen.getByRole('button', { name });

beforeEach(() => { localStorage.clear(); layoutActions.forget(); });
afterEach(() => { cleanup(); vi.useRealTimers(); layoutActions.reset(); });

describe('soulStatus', () => {
  it('orders paused, waiting, working, idle, and tells asleep from offline', () => {
    expect(soulStatus(luna, noStatus)).toBe('idle');
    expect(soulStatus(luna, { ...noStatus, busy: new Set(['agent_p']) })).toBe('working');
    expect(soulStatus(luna, { ...noStatus, computerUse: new Set(['agent_p']) })).toBe('working');
    expect(soulStatus(luna, { ...noStatus, busy: new Set(['agent_p']), awaiting: new Set(['agent_p']) })).toBe('awaiting');
    expect(soulStatus(luna, { ...noStatus, awaiting: new Set(['agent_p']), fleetPaused: true })).toBe('paused');
    expect(soulStatus(left, { ...noStatus, fleetPaused: true })).toBe('offline');
    expect(soulStatus({ ...left, daemonWatching: true }, noStatus)).toBe('asleep');
  });

  it('says idle and offline in the census presence words the menu uses', () => {
    expect(statusText('idle', luna, t)).toBe('Ready');
    expect(statusText('idle', child, t)).toBe('Starting');
    expect(statusText('offline', left, t)).toBe('Offline');
    expect(statusText('awaiting', luna, t)).toBe('Waiting on you');
    expect(statusText('working', luna, t)).toBe('Working…');
    expect(statusText('paused', luna, t)).toBe('Paused');
  });
});

describe('Desktop team card status (Lovable TeamCluster)', () => {
  it('counts who waits and who works in the team, and outlines a team that waits', () => {
    render(<Live awaiting={new Set(['agent_c'])} badges={{ ...noBadges, busy: new Set(['agent_p', 'agent_c']) }} />);
    const card = screen.getByRole('region', { name: 'luna' });
    expect(card.className).toContain('border-warning/70');
    expect(within(card).getByText('1 waiting on you')).toBeTruthy();
    expect(within(card).getByText('1 working')).toBeTruthy();
  });

  it('shows no pills and a plain border while nobody waits or works', () => {
    render(<Live />);
    const card = screen.getByRole('region', { name: 'luna' });
    expect(card.className).not.toContain('border-warning/70');
    expect(within(card).queryByText(/waiting on you|working/)).toBeNull();
  });
});

describe('Desktop hover card', () => {
  it('opens on keyboard focus with harness, status, team and subagents, and closes on Escape', () => {
    render(<Live />);
    const lead = avatar(/^luna,/);
    expect(lead.getAttribute('aria-describedby')).toBeNull();
    act(() => lead.focus());
    const id = lead.getAttribute('aria-describedby');
    const card = document.getElementById(id!)!;
    expect(card.getAttribute('role')).toBe('tooltip');
    expect(card.textContent).toContain('luna');
    expect(card.textContent).toContain('codex');
    expect(card.textContent).toContain('Ready');
    expect(card.textContent).toContain('Leads this team');
    expect(card.textContent).toContain('1 subagent');
    fireEvent.keyDown(lead, { key: 'Escape' });
    expect(lead.getAttribute('aria-describedby')).toBeNull();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it("names a subagent's lead and closes on blur", () => {
    render(<Live />);
    const sub = avatar(/^agent_c,/);
    act(() => sub.focus());
    const card = screen.getByRole('tooltip');
    expect(within(card).getByText('luna')).toBeTruthy();
    expect(within(card).getByText('None')).toBeTruthy();
    expect(within(card).getByText('unknown harness', { exact: false })).toBeTruthy();
    act(() => sub.blur());
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('opens after resting the pointer on an avatar and closes on leave', () => {
    vi.useFakeTimers();
    render(<Live />);
    const wrap = avatar(/^old,/).parentElement!;
    fireEvent.mouseEnter(wrap);
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_MS); });
    expect(screen.getByRole('tooltip').textContent).toContain('No team');
    fireEvent.mouseLeave(wrap);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('Desktop status dot', () => {
  it('shows each status in a tooltip on hover, and speaks the ones beyond presence', () => {
    render(<Live badges={{ ...noBadges, busy: new Set(['agent_c']) }} awaiting={new Set(['agent_p'])} />);
    const dot = (name: RegExp) => avatar(name).querySelector('[data-status]')!;
    expect(dot(/^luna,/).getAttribute('data-status')).toBe('awaiting');
    fireEvent.mouseEnter(dot(/^luna,/).parentElement!);
    expect(screen.getByRole('tooltip').textContent).toBe('Waiting on you');
    fireEvent.mouseLeave(dot(/^luna,/).parentElement!);
    fireEvent.mouseEnter(dot(/^agent_c,/).parentElement!);
    expect(screen.getByRole('tooltip').textContent).toBe('Working…');
    expect(avatar(/^luna,/).getAttribute('aria-label')).toContain('Waiting on you');
    expect(avatar(/^old,/).getAttribute('aria-label')).not.toContain('Waiting on you');
  });

  it('says Paused while agent-bot reports the companions paused', () => {
    render(<Live fleetPaused />);
    fireEvent.mouseEnter(avatar(/^luna,/).querySelector('[data-status]')!.parentElement!);
    expect(screen.getByRole('tooltip').textContent).toBe('Paused');
  });
});

describe('Desktop hide and restore', () => {
  it("shows a team's ⋯ on hover and focus only, but always on a hidden lead's placeholder (N9)", () => {
    render(<Live />);
    const more = screen.getByRole('button', { name: 'More for luna' });
    expect(more.className.split(' ')).toEqual(expect.arrayContaining(['opacity-0', 'group-hover:opacity-100', 'focus-visible:opacity-100', 'aria-expanded:opacity-100']));
    expect(screen.getByRole('region', { name: 'luna' }).className.split(' ')).toContain('group');
    act(() => layoutActions.setHidden('user/agent_p', true));
    expect(screen.getByRole('button', { name: 'More for Team' }).className).not.toMatch(/opacity-0/);
  });

  it("hides a lead's whole team from its team's ⋯, as the design's Hide on a lead (D5), keeping a lead-only Hide", () => {
    render(<Live />);
    fireEvent.click(screen.getByRole('button', { name: 'More for luna' }));
    const menu = screen.getByRole('menu', { name: 'luna' });
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Open' }));
    expect(within(menu).getByRole('menuitem', { name: 'Hide only this companion' })).toBeTruthy();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Hide from desktop' }));
    expect(screen.queryByRole('region', { name: 'luna' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Team' })).toBeNull();
    expect(useLayoutSnapshot().hidden).toEqual(['user/agent_p', 'user/agent_c']);
  });

  it('still hides a lead on its own from its menu (Hide only this companion)', () => {
    render(<Live />);
    fireEvent.click(screen.getByRole('button', { name: 'More for luna' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'luna' })).getByRole('menuitem', { name: 'Hide only this companion' }));
    expect(useLayoutSnapshot().hidden).toEqual(['user/agent_p']);
  });

  it('hides a lead from its right-click menu with its team too (D5)', () => {
    render(<Live />);
    fireEvent.contextMenu(avatar(/^luna,/));
    fireEvent.click(within(screen.getByRole('menu', { name: 'luna' })).getByRole('menuitem', { name: 'Hide from desktop' }));
    expect(useLayoutSnapshot().hidden).toEqual(['user/agent_p', 'user/agent_c']);
  });

  it('restores a lead hidden on its own (from the menu bar list) from the placeholder', () => {
    render(<Live />);
    act(() => layoutActions.setHidden('user/agent_p', true));
    expect(screen.queryByRole('region', { name: 'luna' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Team' })).toBeTruthy();
    expect(useLayoutSnapshot().hidden).toEqual(['user/agent_p']);

    fireEvent.click(screen.getByRole('button', { name: 'More for Team' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Team' })).getByRole('menuitem', { name: 'Show on desktop' }));
    expect(screen.getByRole('region', { name: 'luna' })).toBeTruthy();
    expect(useLayoutSnapshot().hidden).toEqual([]);
  });

  it('restores a whole hidden team from the placeholder', () => {
    render(<Live />);
    act(() => layoutActions.setTeamHidden(['user/agent_p', 'user/agent_c'], true));
    expect(screen.queryByRole('region', { name: 'Team' })).toBeNull();
    // A subagent shown again brings the placeholder back, which restores the rest.
    act(() => layoutActions.setHidden('user/agent_c', false));
    fireEvent.click(screen.getByRole('button', { name: 'More for Team' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show team on desktop' }));
    expect(useLayoutSnapshot().hidden).toEqual([]);
  });

  it('hides from the right-click menu, closes on Escape with focus back on the avatar', () => {
    render(<Live />);
    const sub = avatar(/^agent_c,/);
    fireEvent.contextMenu(sub);
    fireEvent.keyDown(screen.getByRole('menu', { name: 'agent_c' }), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(sub);
    fireEvent.contextMenu(sub);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide from desktop' }));
    expect(screen.queryByRole('button', { name: /^agent_c,/ })).toBeNull();
    expect(screen.getByRole('region', { name: 'luna' })).toBeTruthy();
    expect(useLayoutSnapshot().hidden).toEqual(['user/agent_c']);
  });

  it('opens the right-click menu at the pointer, kept inside the viewport, and under the avatar from the keyboard (X12)', () => {
    render(<Live />);
    const sub = avatar(/^agent_c,/);
    fireEvent.contextMenu(sub, { clientX: 200, clientY: 150 });
    let menu = screen.getByRole('menu', { name: 'agent_c' });
    expect([menu.style.position, menu.style.left, menu.style.top]).toEqual(['fixed', '200px', '150px']);
    // Over the body (#262): no card, pane or window the card's size clips it.
    expect(menu.parentElement).toBe(document.body);
    expect(screen.getByRole('region', { name: 'luna' }).contains(menu)).toBe(false);
    expect(document.activeElement).toBe(within(menu).getAllByRole('menuitem')[0]);
    fireEvent.keyDown(menu, { key: 'Escape' });
    // Near the bottom-right corner, the menu's size keeps it on screen, 8 px in (Radix collisionPadding).
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'menu'
        ? { width: 128, height: 100, left: 0, top: 0, right: 128, bottom: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
        : { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    fireEvent.contextMenu(sub, { clientX: window.innerWidth - 10, clientY: window.innerHeight - 10 });
    menu = screen.getByRole('menu', { name: 'agent_c' });
    expect([menu.style.left, menu.style.top]).toEqual([`${window.innerWidth - 8 - 128}px`, `${window.innerHeight - 8 - 100}px`]);
    fireEvent.keyDown(menu, { key: 'Escape' });
    rect.mockRestore();
    // Shift+F10 and the ContextMenu key: anchored under the avatar, centred on it.
    const anchored = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('role') === 'menu') return new DOMRect(0, 0, 128, 100);
      return this === sub ? new DOMRect(300, 200, 40, 40) : new DOMRect(0, 0, 0, 0);
    });
    for (const key of [{ key: 'F10', shiftKey: true }, { key: 'ContextMenu' }]) {
      fireEvent.keyDown(sub, key);
      menu = screen.getByRole('menu', { name: 'agent_c' });
      expect(menu.getAttribute('data-side')).toBe('bottom');
      expect([menu.style.left, menu.style.top]).toEqual(['256px', '244px']);
      fireEvent.keyDown(menu, { key: 'Escape' });
      expect(document.activeElement).toBe(sub);
    }
    anchored.mockRestore();
  });

  it('flips a menu above its trigger when the window ends under it, and keeps a hover card inside the window (#262)', () => {
    render(<Live />);
    const more = screen.getByRole('button', { name: 'More for luna' });
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const role = this.getAttribute('role');
      if (role === 'menu') return new DOMRect(0, 0, 128, 100);
      if (role === 'tooltip') return new DOMRect(0, 0, 224, 120);
      // The trigger sits 20 px above the window's bottom edge.
      return this === more || this === avatar(/^luna,/) ? new DOMRect(10, window.innerHeight - 50, 30, 30) : new DOMRect(0, 0, 0, 0);
    });
    fireEvent.click(more);
    const menu = screen.getByRole('menu', { name: 'luna' });
    expect(menu.getAttribute('data-side')).toBe('top');
    // Aligned to the trigger's right edge (40), shifted in to the padding.
    expect([menu.style.left, menu.style.top]).toEqual(['8px', `${window.innerHeight - 50 - 4 - 100}px`]);
    fireEvent.keyDown(menu, { key: 'Escape' });
    act(() => avatar(/^luna,/).focus());
    const card = screen.getByRole('tooltip');
    expect(card.parentElement).toBe(document.body);
    expect(card.getAttribute('data-side')).toBe('top');
    expect(card.style.left).toBe('8px');
    rect.mockRestore();
  });

  it('moves through the menu with Up, Down, Home and End, and Escape gives focus back to ⋯ (D6)', () => {
    render(<Live />);
    const more = screen.getByRole('button', { name: 'More for luna' });
    fireEvent.click(more);
    const menu = screen.getByRole('menu', { name: 'luna' });
    const items = within(menu).getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it('rings a focused avatar, as the design (D4)', () => {
    render(<Live />);
    expect(avatar(/^luna,/).className.split(' ')).toEqual(expect.arrayContaining(['focus-visible:ring-2', 'focus-visible:ring-ring']));
  });
});

/** The stored layout, read the way the desktop reads it. */
function useLayoutSnapshot() {
  return JSON.parse(localStorage.getItem('gb.desktop') ?? '{"hidden":[]}') as { hidden: string[] };
}

describe('Desktop Customize… (#64)', () => {
  const profiles: ProfileSource = {
    profile: vi.fn(async () => sampleProfile),
    file: vi.fn(async (agentId: string, path: string) => ({ agentId, path, size: 0, contents: '' })),
    prepare: vi.fn(async () => samplePreparedRevision),
    discard: vi.fn(async () => {}),
  };

  it('offers Customize… between Open and Hide in the right-click menu, and opens the dialog for that companion', async () => {
    render(<ProfileSourceContext.Provider value={profiles}><Live /></ProfileSourceContext.Provider>);
    const lead = avatar(/^luna,/);
    fireEvent.contextMenu(lead);
    const menu = screen.getByRole('menu', { name: 'luna' });
    const items = within(menu).getAllByRole('menuitem').map((i) => i.textContent?.trim());
    expect(items.slice(0, 3)).toEqual(['Open', 'Customize…', 'Hide from desktop']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Customize…' }));
    expect(screen.queryByRole('menu')).toBeNull();
    const dialog = await screen.findByRole('dialog', { name: 'Luna' });
    expect(profiles.profile).toHaveBeenCalledWith('agent_p');
    expect(within(dialog).getByRole('radiogroup', { name: 'Color' })).toBeTruthy();
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' })[0]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(lead);
  });

  it('leaves the team ⋯ menu and a browser without profiles as they were', () => {
    render(<ProfileSourceContext.Provider value={profiles}><Live /></ProfileSourceContext.Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'More for luna' }));
    expect(within(screen.getByRole('menu', { name: 'luna' })).queryByRole('menuitem', { name: 'Customize…' })).toBeNull();
    cleanup();
    render(<Live />);
    fireEvent.contextMenu(avatar(/^luna,/));
    expect(within(screen.getByRole('menu', { name: 'luna' })).queryByRole('menuitem', { name: 'Customize…' })).toBeNull();
  });
});

describe('CompanionWindow role (#122, agent-bot-identity #535)', () => {
  it('shows role · harness in the title bar, and the harness alone without a role', () => {
    const { unmount } = render(<CompanionWindow soul={{ ...luna, role: 'Release captain' }} paused onClose={() => {}}>body</CompanionWindow>);
    expect(within(screen.getByRole('dialog', { name: 'luna' })).getByText('Release captain · codex')).toBeTruthy();
    unmount();
    render(<CompanionWindow soul={luna} paused onClose={() => {}}>body</CompanionWindow>);
    expect(within(screen.getByRole('dialog', { name: 'luna' })).getByText('codex')).toBeTruthy();
  });
});

describe('CompanionWindow title Dudle (S3)', () => {
  it('animates the title bar Dudle with the live state, idle without one', () => {
    const { unmount } = render(<CompanionWindow soul={luna} paused onClose={() => {}} state="working">body</CompanionWindow>);
    const bar = screen.getByRole('dialog', { name: 'luna' });
    expect(bar.querySelector('svg.dudle')?.getAttribute('data-state')).toBe('working');
    unmount();
    render(<CompanionWindow soul={luna} paused onClose={() => {}}>body</CompanionWindow>);
    expect(screen.getByRole('dialog', { name: 'luna' }).querySelector('svg.dudle')?.getAttribute('data-state')).toBe('idle');
  });
});

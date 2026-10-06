import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { I18nProvider } from '../lib/i18n';
import { emptyChat } from '../model/chat';
import type { CensusRow } from '../model/census';
import { sampleCensus, sampleConnection } from '../model/fixtures';
import { layoutActions } from '../state/layout';
import type { ChatApi } from '../useChat';
import { BridgeError, type ComputerUseSwitch } from '../bridge';
import { COMPUTER_USE_ERROR_MS, HALT_HOLD_MS, STOP_SETTLE_MS } from '../model/floating';
import { FloatingDudle, type Stopper } from './FloatingDudle';

afterEach(() => { cleanup(); globalThis.localStorage?.clear(); layoutActions.forget(); });

const luna = sampleCensus[0];

function floating(props: Partial<Parameters<typeof FloatingDudle>[0]> = {}) {
  const onPrompt = vi.fn();
  const onHistory = vi.fn();
  render(<I18nProvider><FloatingDudle lead={luna} state="idle" computerUser={null} paused showButton onPrompt={onPrompt} onHistory={onHistory} {...props} /></I18nProvider>);
  return { onPrompt, onHistory, button: screen.queryByRole('button', { name: 'Companion quick actions' }) };
}

describe('FloatingDudle', () => {
  it('draws the lead in its state, with the awaiting dot only while awaiting', () => {
    const { button } = floating({ state: 'working' });
    expect(button?.querySelector('svg')?.getAttribute('data-state')).toBe('working');
    expect(screen.queryByTestId('awaiting-dot')).toBeNull();
    cleanup();
    floating({ state: 'awaiting' });
    expect(screen.getByTestId('awaiting-dot')).toBeTruthy();
    cleanup();
    floating({ state: 'idle' });
    expect(document.querySelector('.dudle')?.getAttribute('data-state')).toBe('idle');
  });

  it('is off by default, as in the Lovable export: only the perimeter shows', () => {
    floating({ showButton: undefined, computerUser: 'coder' });
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.querySelector('.perimeter')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('coder is using the computer');
  });

  it('shows nothing without a lead or computer use', () => {
    const { button } = floating({ lead: null });
    expect(button).toBeNull();
    expect(document.querySelector('.perimeter')).toBeNull();
  });

  it('opens the radial menu from the keyboard, moves with arrows and closes on Escape', () => {
    const { button } = floating();
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(button!, { key: 'Enter' });
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('list', { name: 'Companion quick actions' });
    const [prompt, history] = within(menu).getAllByRole('button');
    expect(prompt.getAttribute('aria-label')).toBe('Write a prompt');
    expect(history.getAttribute('aria-label')).toBe('Open history');
    expect(document.activeElement).toBe(prompt);
    fireEvent.keyDown(prompt, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(history);
    fireEvent.keyDown(history, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(prompt);
    fireEvent.keyDown(prompt, { key: 'Escape' });
    expect(screen.queryByRole('list')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('without a pauser offers only prompt and history: no pause, computer-use toggle or stop', () => {
    const { button } = floating({ computerUser: 'luna' });
    fireEvent.keyDown(button!, { key: ' ' });
    expect(within(screen.getByRole('list')).getAllByRole('button')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /pause|resume|computer|stop/i })).toBeNull();
  });

  it('offers the design\'s Pause all, or Resume while the fleet is paused, between prompt and history', () => {
    const onTogglePause = vi.fn();
    const { button } = floating({ onTogglePause });
    fireEvent.keyDown(button!, { key: 'Enter' });
    expect(within(screen.getByRole('list')).getAllByRole('button').map((b) => b.getAttribute('aria-label')))
      .toEqual(['Write a prompt', 'Pause all', 'Open history']);
    fireEvent.click(screen.getByRole('button', { name: 'Pause all' }));
    expect(onTogglePause).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('list')).toBeNull();
    cleanup();
    const paused = floating({ onTogglePause, fleetPaused: true });
    fireEvent.keyDown(paused.button!, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause all' })).toBeNull();
  });

  it('runs an action on the lead and closes', () => {
    const { button, onPrompt, onHistory } = floating();
    fireEvent.pointerDown(button!, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(button!, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Open history' }));
    expect(onHistory).toHaveBeenCalledWith(luna);
    expect(screen.queryByRole('list')).toBeNull();
    fireEvent.keyDown(button!, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Write a prompt' }));
    expect(onPrompt).toHaveBeenCalledWith(luna);
  });

  it('a drag moves it instead of opening the menu', () => {
    const { button } = floating();
    fireEvent.pointerDown(button!, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(button!, { clientX: 60, clientY: 80, pointerId: 1 });
    fireEvent.pointerUp(button!, { clientX: 60, clientY: 80, pointerId: 1 });
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    expect((button!.parentElement as HTMLElement).style.right).toBe('64px');
  });

  it('draws the perimeter and names who uses the computer, promising no stop', () => {
    floating({ computerUser: 'coder' });
    const perimeter = document.querySelector('.perimeter');
    expect(perimeter?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('coder is using the computer');
    expect(screen.queryByText(/stop|esc/i)).toBeNull();
  });
});

describe('FloatingDudle in the desktop', () => {
  const chat: ChatApi = { chat: emptyChat, composers: {}, open: vi.fn(), setDraft: vi.fn(), send: vi.fn() };
  const desk = (extra: Partial<Parameters<typeof App>[0]> = {}) =>
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic chat={chat} floatingButton {...extra} />);

  it('is not in the tray popup', () => {
    render(<App census={sampleCensus} connection={sampleConnection} isStatic chat={chat} />);
    expect(screen.queryByRole('button', { name: 'Companion quick actions' })).toBeNull();
  });

  it('the live app shows no floating button, only the perimeter while a soul uses the computer', () => {
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic chat={chat}
      badges={{ comms: new Set(), computerUse: new Set(['agent_p']), busy: new Set(['agent_p']) }} />);
    expect(screen.queryByRole('button', { name: 'Companion quick actions' })).toBeNull();
    expect(document.querySelector('.perimeter')).toBeTruthy();
    expect(screen.getByText('luna is using the computer')).toBeTruthy();
  });

  it('shows the first team lead, idle, and working while the daemon reports a soul busy', () => {
    desk();
    const button = screen.getByRole('button', { name: 'Companion quick actions' });
    expect(button.getAttribute('title')).toBe('luna');
    expect(button.querySelector('svg')?.getAttribute('data-state')).toBe('idle');
    cleanup();
    desk({ badges: { comms: new Set(), computerUse: new Set(), busy: new Set(['agent_c']) } });
    expect(screen.getByRole('button', { name: 'Companion quick actions' }).querySelector('svg')?.getAttribute('data-state')).toBe('working');
  });

  it('draws the perimeter while the daemon reports computer use', () => {
    desk({ badges: { comms: new Set(), computerUse: new Set(['agent_p']), busy: new Set() } });
    expect(document.querySelector('.perimeter')).toBeTruthy();
    expect(screen.getByText('luna is using the computer')).toBeTruthy();
  });

  it('history opens the lead on its Audit log, prompt on its chat with the composer focused', async () => {
    vi.useFakeTimers();
    try {
      desk();
      const button = screen.getByRole('button', { name: 'Companion quick actions' });
      fireEvent.keyDown(button, { key: 'Enter' });
      fireEvent.click(screen.getByRole('button', { name: 'Open history' }));
      expect(screen.getByRole('tab', { name: 'Audit log' }).getAttribute('aria-selected')).toBe('true');
      fireEvent.keyDown(button, { key: 'Enter' });
      fireEvent.click(screen.getByRole('button', { name: 'Write a prompt' }));
      expect(screen.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('true');
      await act(async () => { vi.advanceTimersByTime(60); });
      expect(document.activeElement?.tagName).toBe('TEXTAREA');
    } finally {
      vi.useRealTimers();
    }
  });

  it('follows the lead the desktop shows when the first team is hidden', async () => {
    const roster: CensusRow[] = [...sampleCensus, { ...sampleCensus[0], agentId: 'agent_n', name: 'nova' }];
    layoutActions.setHidden('user/agent_p', true);
    desk({ census: roster });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Companion quick actions' }).getAttribute('title')).toBe('nova'));
  });
});

describe('FloatingDudle Stop (agent-bot soul stop)', () => {
  const driving = new Set(['agent_c']);
  const stopperWith = (stop: Stopper['stop'] = async (agentId) => ({ agentId, stopped: true }), supported = true): Stopper =>
    ({ supported: vi.fn(async () => supported), stop: vi.fn(stop) });
  const perimeter = (stopper: Stopper, computerUse: ReadonlySet<string> = driving) =>
    <I18nProvider><FloatingDudle lead={luna} state="working" computerUser={computerUse.size ? 'coder' : null} computerUse={computerUse} stopper={stopper} paused onPrompt={vi.fn()} onHistory={vi.fn()} /></I18nProvider>;
  const settle = () => act(async () => {});

  it('offers the design\'s Stop in an alert, probing agent-bot once', async () => {
    const stopper = stopperWith();
    const view = render(perimeter(stopper));
    await settle();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('coder is controlling the screen. Hold Esc or press Stop to halt.');
    expect(within(alert).getByRole('button', { name: 'Stop' })).toBeTruthy();
    view.rerender(perimeter(stopper, new Set(['agent_c'])));
    await settle();
    expect(stopper.supported).toHaveBeenCalledTimes(1);
  });

  it('stops the soul driving the screen and shows stopping until the daemon drops it', async () => {
    const stopper = stopperWith();
    const view = render(perimeter(stopper));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await settle();
    expect(stopper.stop).toHaveBeenCalledWith('agent_c');
    const button = screen.getByRole('button', { name: 'Stopping…' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(stopper.stop).toHaveBeenCalledTimes(1);
    view.rerender(perimeter(stopper, new Set()));
    await settle();
    expect(document.querySelector('.perimeter')).toBeNull();
    view.rerender(perimeter(stopper, driving));
    await settle();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
  });

  it('offers Stop again if the daemon never drops the soul', async () => {
    vi.useFakeTimers();
    try {
      render(perimeter(stopperWith()));
      await settle();
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      await settle();
      expect(screen.getByRole('button', { name: 'Stopping…' })).toBeTruthy();
      await act(async () => { vi.advanceTimersByTime(STOP_SETTLE_MS); });
      expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a failure in the error style and lets the owner try again', async () => {
    const stopper = stopperWith(async () => { throw new BridgeError('daemon-unavailable', 'the daemon is not running'); });
    render(perimeter(stopper));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await settle();
    const failure = screen.getByText('Could not stop: the daemon is not running');
    expect(failure.className).toContain('text-destructive');
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
  });

  it('halts on Escape held ~0.6 s, not on a quick press', async () => {
    vi.useFakeTimers();
    try {
      const stopper = stopperWith();
      render(perimeter(stopper));
      await settle();
      fireEvent.keyDown(window, { key: 'Escape' });
      await act(async () => { vi.advanceTimersByTime(300); });
      fireEvent.keyUp(window, { key: 'Escape' });
      await act(async () => { vi.advanceTimersByTime(1000); });
      expect(stopper.stop).not.toHaveBeenCalled();
      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.keyDown(window, { key: 'Escape', repeat: true });
      await act(async () => { vi.advanceTimersByTime(HALT_HOLD_MS - 1); });
      expect(stopper.stop).not.toHaveBeenCalled();
      await act(async () => { vi.advanceTimersByTime(1); });
      expect(stopper.stop).toHaveBeenCalledWith('agent_c');
      expect(stopper.stop).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'Stopping…' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a quick Escape still closes the quick menu without halting', async () => {
    vi.useFakeTimers();
    try {
      const stopper = stopperWith();
      render(<I18nProvider><FloatingDudle lead={luna} state="working" computerUser="coder" computerUse={driving} stopper={stopper} paused showButton onPrompt={vi.fn()} onHistory={vi.fn()} /></I18nProvider>);
      await settle();
      fireEvent.keyDown(screen.getByRole('button', { name: 'Companion quick actions' }), { key: 'Enter' });
      const menu = screen.getByRole('list', { name: 'Companion quick actions' });
      fireEvent.keyDown(within(menu).getAllByRole('button')[0], { key: 'Escape' });
      fireEvent.keyUp(window, { key: 'Escape' });
      expect(screen.queryByRole('list')).toBeNull();
      await act(async () => { vi.advanceTimersByTime(HALT_HOLD_MS * 2); });
      expect(stopper.stop).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('hides Stop and the Escape hold on an agent-bot without soul stop', async () => {
    vi.useFakeTimers();
    try {
      const stopper = stopperWith(undefined, false);
      render(perimeter(stopper));
      await settle();
      expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
      expect(screen.getByRole('status').textContent).toBe('coder is using the computer');
      fireEvent.keyDown(window, { key: 'Escape' });
      await act(async () => { vi.advanceTimersByTime(HALT_HOLD_MS * 2); });
      expect(stopper.stop).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('hides Stop when a stop says the bundle has no soul stop', async () => {
    render(perimeter(stopperWith(async () => { throw new BridgeError('soul-stop-unsupported', 'this agent-bot has no soul stop'); })));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await settle();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('coder is using the computer');
  });

  it('in the desktop, stops the soul the daemon reports driving the screen', async () => {
    const stopper = stopperWith();
    const chat: ChatApi = { chat: emptyChat, composers: {}, open: vi.fn(), setDraft: vi.fn(), send: vi.fn() };
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic chat={chat} stopper={stopper}
      badges={{ comms: new Set(), computerUse: new Set(['agent_p']), busy: new Set(['agent_p']) }} />);
    await settle();
    expect(screen.getByText('luna is controlling the screen. Hold Esc or press Stop to halt.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await settle();
    expect(stopper.stop).toHaveBeenCalledWith('agent_p');
  });
});

describe('FloatingDudle Toggle computer use (agent-bot soul computer-use)', () => {
  function switchWith(on: boolean | null, overrides: Partial<ComputerUseSwitch> = {}) {
    const state = { on };
    const sw = {
      supported: vi.fn(async () => true),
      read: vi.fn(async () => state.on),
      set: vi.fn(async (agentId: string, next: boolean) => { state.on = next; return { agentId, computerUse: next }; }),
      ...overrides,
    };
    return { sw, state };
  }
  const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  const openMenu = (button: HTMLElement | null) => fireEvent.keyDown(button!, { key: 'Enter' });
  const labels = () => within(screen.getByRole('list')).getAllByRole('button').map((b) => b.getAttribute('aria-label'));

  it('offers the design\'s item between Pause all and history, probing agent-bot once', async () => {
    const { sw } = switchWith(true);
    const { button } = floating({ onTogglePause: vi.fn(), computerUseSwitch: sw });
    await flush();
    openMenu(button);
    expect(labels()).toEqual(['Write a prompt', 'Pause all', 'Toggle computer use', 'Open history']);
    expect(sw.supported).toHaveBeenCalledTimes(1);
  });

  it('turns the lead\'s computer use off while on, and back on while off', async () => {
    const { sw, state } = switchWith(true);
    const { button } = floating({ computerUseSwitch: sw });
    await flush();
    openMenu(button);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle computer use' }));
    expect(screen.queryByRole('list')).toBeNull();
    await flush();
    expect(sw.read).toHaveBeenCalledWith(luna.agentId);
    expect(sw.set).toHaveBeenCalledWith(luna.agentId, false);
    expect(state.on).toBe(false);
    openMenu(button);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle computer use' }));
    await flush();
    expect(sw.set).toHaveBeenLastCalledWith(luna.agentId, true);
    expect(state.on).toBe(true);
  });

  it('shows a refusal in the error style for a while, the switch unchanged', async () => {
    vi.useFakeTimers();
    try {
      const { sw } = switchWith(true, { set: vi.fn(async () => { throw new BridgeError('soul-computer-use-failed', 'the owner did not approve'); }) });
      const { button } = floating({ computerUseSwitch: sw });
      await flush();
      openMenu(button);
      fireEvent.click(screen.getByRole('button', { name: 'Toggle computer use' }));
      await flush();
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toBe('Computer use unchanged: the owner did not approve');
      expect(alert.className).toContain('text-destructive');
      act(() => { vi.advanceTimersByTime(COMPUTER_USE_ERROR_MS); });
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('changes nothing when agent-bot cannot say what the switch is', async () => {
    const { sw } = switchWith(null);
    const { button } = floating({ computerUseSwitch: sw });
    await flush();
    openMenu(button);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle computer use' }));
    await flush();
    expect(sw.set).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('Computer use unchanged: agent-bot gave no computer-use setting');
  });

  it('is hidden on an agent-bot without soul computer-use, or once a switch says so', async () => {
    const { sw } = switchWith(true, { supported: vi.fn(async () => false) });
    const { button } = floating({ computerUseSwitch: sw });
    await flush();
    openMenu(button);
    expect(labels()).toEqual(['Write a prompt', 'Open history']);
    cleanup();
    const older = switchWith(true, { set: vi.fn(async () => { throw new BridgeError('soul-computer-use-unsupported', 'this agent-bot has no soul computer-use'); }) });
    const again = floating({ computerUseSwitch: older.sw });
    await flush();
    openMenu(again.button);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle computer use' }));
    await flush();
    expect(screen.queryByRole('alert')).toBeNull();
    openMenu(again.button);
    expect(labels()).toEqual(['Write a prompt', 'Open history']);
  });

  it('in the desktop, acts on the lead the floating Dudle shows', async () => {
    const { sw } = switchWith(true);
    const chat: ChatApi = { chat: emptyChat, composers: {}, open: vi.fn(), setDraft: vi.fn(), send: vi.fn() };
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic chat={chat} floatingButton computerUseSwitch={sw} />);
    await flush();
    openMenu(screen.getByRole('button', { name: 'Companion quick actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle computer use' }));
    await flush();
    expect(sw.set).toHaveBeenCalledWith('agent_p', false);
  });
});

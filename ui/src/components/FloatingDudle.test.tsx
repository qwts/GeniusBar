import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { I18nProvider } from '../lib/i18n';
import { emptyChat } from '../model/chat';
import type { CensusRow } from '../model/census';
import { sampleCensus, sampleConnection } from '../model/fixtures';
import { layoutActions } from '../state/layout';
import type { ChatApi } from '../useChat';
import { FloatingDudle } from './FloatingDudle';

afterEach(() => { cleanup(); globalThis.localStorage?.clear(); layoutActions.forget(); });

const luna = sampleCensus[0];

function floating(props: Partial<Parameters<typeof FloatingDudle>[0]> = {}) {
  const onPrompt = vi.fn();
  const onHistory = vi.fn();
  render(<I18nProvider><FloatingDudle lead={luna} state="idle" computerUser={null} paused onPrompt={onPrompt} onHistory={onHistory} {...props} /></I18nProvider>);
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

  it('offers only prompt and history: no pause, computer-use toggle or stop', () => {
    const { button } = floating({ computerUser: 'luna' });
    fireEvent.keyDown(button!, { key: ' ' });
    expect(within(screen.getByRole('list')).getAllByRole('button')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /pause|resume|computer|stop/i })).toBeNull();
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
    render(<App mode="window" census={sampleCensus} connection={sampleConnection} isStatic chat={chat} {...extra} />);

  it('is not in the tray popup', () => {
    render(<App census={sampleCensus} connection={sampleConnection} isStatic chat={chat} />);
    expect(screen.queryByRole('button', { name: 'Companion quick actions' })).toBeNull();
  });

  it('shows the first team lead, idle, and working while a soul is busy', () => {
    desk();
    const button = screen.getByRole('button', { name: 'Companion quick actions' });
    expect(button.getAttribute('title')).toBe('luna');
    expect(button.querySelector('svg')?.getAttribute('data-state')).toBe('idle');
    cleanup();
    desk({ busy: new Set(['agent_c']) });
    expect(screen.getByRole('button', { name: 'Companion quick actions' }).querySelector('svg')?.getAttribute('data-state')).toBe('working');
  });

  it('draws the perimeter while the daemon reports computer use', () => {
    desk({ badges: { comms: new Set(), computerUse: new Set(['agent_p']) } });
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

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchApi } from '../useLaunch';
import { DEV_TOOLS_POLL_MS, FirstLaunch, type Starter } from './FirstLaunch';

const launcher: LaunchApi = { state: { phase: 'idle' }, launch: vi.fn(async () => {}), reset: vi.fn() };
const missing: Starter = { package: '/App/souls/starter.soul', account: 'friend', name: 'Starter', harnesses: ['claude'], devTools: false, devToolsInstalling: false };

// Lets the install promise settle inside act.
const flush = () => act(async () => {});
const tick = () => act(async () => { vi.advanceTimersByTime(DEV_TOOLS_POLL_MS); });

describe('FirstLaunch command line tools step (#101)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('explains the tools before anything opens Apple’s installer', () => {
    const devTools = { install: vi.fn(async () => {}), recheck: vi.fn() };
    render(<FirstLaunch starter={missing} launcher={launcher} devTools={devTools} />);
    expect(screen.getByText('GeniusBar needs Apple’s free command-line tools (for git). This takes a few minutes, once.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start with Starter' })).toBeNull();
    expect(devTools.install).not.toHaveBeenCalled();
  });

  it('opens the installer only on Continue, then waits', async () => {
    const devTools = { install: vi.fn(async () => {}), recheck: vi.fn() };
    render(<FirstLaunch starter={missing} launcher={launcher} devTools={devTools} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(devTools.install).toHaveBeenCalledOnce();
    await flush();
    expect(screen.getByText(/Waiting for the installer/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });

  it('polls while waiting and moves on once the tools are installed', async () => {
    const devTools = { install: vi.fn(async () => {}), recheck: vi.fn() };
    const { rerender } = render(<FirstLaunch starter={missing} launcher={launcher} devTools={devTools} />);
    await tick();
    expect(devTools.recheck).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await flush();
    rerender(<FirstLaunch starter={{ ...missing, devToolsInstalling: true }} launcher={launcher} devTools={devTools} />);
    await tick();
    await tick();
    expect(devTools.recheck).toHaveBeenCalledTimes(2);
    rerender(<FirstLaunch starter={{ ...missing, devTools: true }} launcher={launcher} devTools={devTools} />);
    expect(screen.getByRole('button', { name: 'Start with Starter' })).toBeTruthy();
    await tick();
    expect(devTools.recheck).toHaveBeenCalledTimes(2);
  });

  it('says what is missing and how to resume when the installer is cancelled', async () => {
    const devTools = { install: vi.fn(async () => {}), recheck: vi.fn() };
    const { rerender } = render(<FirstLaunch starter={missing} launcher={launcher} devTools={devTools} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await flush();
    rerender(<FirstLaunch starter={{ ...missing, devToolsInstalling: true }} launcher={launcher} devTools={devTools} />);
    rerender(<FirstLaunch starter={{ ...missing, devToolsInstalling: false }} launcher={launcher} devTools={devTools} />);
    expect(screen.getByText(/command-line tools aren’t installed/)).toBeTruthy();
    expect(screen.getByText('xcode-select --install').tagName).toBe('CODE');
    const calls = devTools.recheck.mock.calls.length;
    await tick();
    expect(devTools.recheck).toHaveBeenCalledTimes(calls);
    fireEvent.click(screen.getByRole('button', { name: 'Install again' }));
    expect(devTools.install).toHaveBeenCalledTimes(2);
    await flush();
    expect(screen.getByText(/Waiting for the installer/)).toBeTruthy();
  });

  it('counts an installer that never opens as cancelled', async () => {
    const devTools = { install: vi.fn(async () => {}), recheck: vi.fn() };
    render(<FirstLaunch starter={missing} launcher={launcher} devTools={devTools} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await flush();
    for (let i = 0; i < 3; i += 1) await tick();
    expect(screen.getByText(/Waiting for the installer/)).toBeTruthy();
    await tick();
    expect(screen.getByRole('button', { name: 'Install again' })).toBeTruthy();
  });

  it('shows the error and the resume step when the installer cannot open', async () => {
    const devTools = { install: vi.fn(async () => { throw new Error('xcode-select failed'); }), recheck: vi.fn() };
    render(<FirstLaunch starter={missing} launcher={launcher} devTools={devTools} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await flush();
    expect(screen.getByRole('alert').textContent).toBe('xcode-select failed');
    expect(screen.getByRole('button', { name: 'Install again' })).toBeTruthy();
  });
});

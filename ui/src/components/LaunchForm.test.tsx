import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../lib/i18n';
import type { LaunchState } from '../model/launch';
import type { LaunchApi } from '../useLaunch';
import { LaunchForm } from './LaunchForm';

afterEach(cleanup);

const launcherIn = (state: LaunchState): LaunchApi => ({ state, launch: vi.fn(async () => {}), reset: vi.fn() });

function form(launcher: LaunchApi, extra: Partial<Parameters<typeof LaunchForm>[0]> = {}) {
  return (
    <I18nProvider>
      <LaunchForm launcher={launcher} accounts={['user']} harnesses={['claude']} defaultHarness="claude" onCancel={() => {}} {...extra} />
    </I18nProvider>
  );
}
const launchButton = () => screen.getByRole('button', { name: 'Launch' }) as HTMLButtonElement;

describe('LaunchForm after a launch (#116)', () => {
  it('reports the launched agent once and never arms Launch again in the dialog', () => {
    const onLaunched = vi.fn();
    const idle = launcherIn({ phase: 'idle' });
    const { rerender } = render(form(idle, { initialPackagePath: '/souls/helper.soul', onLaunched }));
    fireEvent.submit(screen.getByRole('form'));
    expect(idle.launch).toHaveBeenCalledOnce();
    rerender(form({ ...idle, state: { phase: 'pending', requestId: 'r1', note: null } }, { initialPackagePath: '/souls/helper.soul', onLaunched }));
    expect(launchButton().disabled).toBe(true);
    expect(onLaunched).not.toHaveBeenCalled();
    const done = { ...idle, state: { phase: 'launched', requestId: 'r1', agentId: 'agent_new' } as LaunchState };
    rerender(form(done, { initialPackagePath: '/souls/helper.soul', onLaunched }));
    rerender(form({ ...done }, { initialPackagePath: '/souls/helper.soul', onLaunched }));
    expect(onLaunched).toHaveBeenCalledOnce();
    expect(onLaunched).toHaveBeenCalledWith('agent_new');
    expect(launchButton().disabled).toBe(true);
    fireEvent.submit(screen.getByRole('form'));
    expect(idle.launch).toHaveBeenCalledOnce();
  });

  it('does not report a launch it did not start', () => {
    const onLaunched = vi.fn();
    render(form(launcherIn({ phase: 'launched', requestId: 'r0', agentId: 'agent_old' }), { onLaunched }));
    expect(onLaunched).not.toHaveBeenCalled();
    expect(launchButton().disabled).toBe(false);
  });
});

describe('LaunchForm package path (#116)', () => {
  it('drops the trailing slash Finder gives an opened .soul', () => {
    const launcher = launcherIn({ phase: 'idle' });
    render(form(launcher, { initialPackagePath: '/Users/admin/Desktop/VMShare.soul/' }));
    expect((screen.getByLabelText('Package') as HTMLInputElement).value).toBe('/Users/admin/Desktop/VMShare.soul');
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ target: { package: '/Users/admin/Desktop/VMShare.soul' } }));
  });

  it('drops a pasted trailing slash when the field is left or the form is sent', () => {
    const launcher = launcherIn({ phase: 'idle' });
    render(form(launcher));
    const path = screen.getByLabelText('Package') as HTMLInputElement;
    fireEvent.change(path, { target: { value: '/souls/a.soul//' } });
    // Typing a folder path keeps its slash until the field is left.
    expect(path.value).toBe('/souls/a.soul//');
    fireEvent.blur(path);
    expect(path.value).toBe('/souls/a.soul');
    fireEvent.change(path, { target: { value: '/souls/b.soul/' } });
    fireEvent.submit(screen.getByRole('form'));
    expect(path.value).toBe('/souls/b.soul');
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ target: { package: '/souls/b.soul' } }));
  });
});

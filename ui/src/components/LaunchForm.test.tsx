import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../lib/i18n';
import type { CensusRow } from '../model/census';
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

const starter: CensusRow = { account: 'user', agentId: 'agent_s', name: 'Starter', harness: 'claude', parent: null, presence: 'left', unacked: 0, lastWake: null };

describe('LaunchForm relaunching an existing companion (#79)', () => {
  it('has no Name field and sends no name', () => {
    const launcher = launcherIn({ phase: 'idle' });
    render(form(launcher, { soul: starter }));
    expect(screen.queryByText('Name')).toBeNull();
    expect(screen.queryByPlaceholderText('Optional')).toBeNull();
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ target: { soul: 'agent_s' }, name: '' }));
  });

  it('ignores a package name and harness preference for an existing soul', () => {
    const launcher = launcherIn({ phase: 'idle' });
    render(form(launcher, { soul: starter, packageName: 'Scott - Starter', preferredHarnesses: ['opencode'] }));
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ name: '', harness: 'claude' }));
  });
});

describe('LaunchForm for a copied soul folder (#110)', () => {
  const copyOf = { name: 'luna', agentId: 'agent_p' };
  it('requires a name before Launch and explains the copy', () => {
    const launcher = launcherIn({ phase: 'idle' });
    render(form(launcher, { initialPackagePath: '/souls/luna copy.soul', copyOf }));
    expect(screen.getByText(/new companion copied from luna/)).toBeTruthy();
    const name = screen.getByPlaceholderText('Required') as HTMLInputElement;
    expect(name.value).toBe('');
    expect(launchButton().disabled).toBe(true);
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: '   ' } });
    expect(launchButton().disabled).toBe(true);
    fireEvent.change(name, { target: { value: 'Nova' } });
    expect(launchButton().disabled).toBe(false);
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ target: { package: '/souls/luna copy.soul' }, name: 'Nova' }));
  });

  it('falls back to the original agent id when it has no name', () => {
    render(form(launcherIn({ phase: 'idle' }), { initialPackagePath: '/souls/x.soul', copyOf: { name: null, agentId: 'agent_x' } }));
    expect(screen.getByText(/copied from agent_x/)).toBeTruthy();
  });
});

describe('LaunchForm prefill from an opened package (#120)', () => {
  it('prefers the package harness over the default and shows its description', () => {
    const launcher = launcherIn({ phase: 'idle' });
    render(form(launcher, { initialPackagePath: '/souls/helper.soul', packageName: 'Helper - Starter', preferredHarnesses: ['opencode'],
      packageDescription: 'Answers questions about this Mac.' }));
    expect(screen.getByText('Answers questions about this Mac.')).toBeTruthy();
    expect((screen.getByLabelText('Harness') as HTMLSelectElement).value).toBe('opencode');
    expect((screen.getByPlaceholderText('Optional') as HTMLInputElement).value).toBe('Helper');
    fireEvent.submit(screen.getByRole('form'));
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ harness: 'opencode', name: 'Helper' }));
  });

  it('switches to the package harness when its manifest arrives late, unless the owner picked one', () => {
    const launcher = launcherIn({ phase: 'idle' });
    const { rerender } = render(form(launcher, { initialPackagePath: '/souls/helper.soul', checkingPackage: true }));
    expect((screen.getByLabelText('Harness') as HTMLSelectElement).value).toBe('claude');
    rerender(form(launcher, { initialPackagePath: '/souls/helper.soul', preferredHarnesses: ['opencode'] }));
    expect((screen.getByLabelText('Harness') as HTMLSelectElement).value).toBe('opencode');
  });

  it('keeps the default harness when the package prefers none the app offers', () => {
    render(form(launcherIn({ phase: 'idle' }), { initialPackagePath: '/souls/helper.soul', preferredHarnesses: ['nonesuch'] }));
    expect((screen.getByLabelText('Harness') as HTMLSelectElement).value).toBe('claude');
  });
});

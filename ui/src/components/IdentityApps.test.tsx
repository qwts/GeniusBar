import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { App } from '../App';
import { BridgeError } from '../bridge';
import { I18nProvider } from '../lib/i18n';
import { sampleCensus, sampleConnection } from '../model/fixtures';
import { layoutActions } from '../state/layout';
import { preferenceActions } from '../state/preferences';
import { CompanionDetails } from './CompanionSession';
import {
  identityStatus, IdentityAppsProvider, liveIdentityApps, normalizeIdentityApps,
  type IdentityApp, type IdentityAppsSource, type IdentityCreateStatus,
} from './IdentityApps';
import { IdentityAppsCard } from './IdentityAppsCard';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

afterEach(() => { cleanup(); globalThis.localStorage?.clear(); layoutActions.forget(); preferenceActions.forget(); vi.mocked(invoke).mockReset(); });

const [luna, child] = sampleCensus;

function app(slug: string, over: Partial<IdentityApp> = {}): IdentityApp {
  return {
    slug, botLogin: `${slug}[bot]`, issuerPresent: true, keyPresent: true,
    installations: [{ id: 7, account: 'qwts', repositorySelection: 'all' }],
    harnesses: [], souls: [], liveMint: { status: 'ready', code: null, checkedAt: '2026-10-06T10:00:00Z' }, ...over,
  };
}

/** A fake agent-bot: `assign` moves the soul, `create` completes on the second status read. */
function fakeSource(initial: IdentityApp[], over: Partial<IdentityAppsSource> = {}) {
  let current = initial;
  let reads = 0;
  const source = {
    list: vi.fn(async () => current),
    create: vi.fn(async () => ({ handle: 1, localUrl: 'http://127.0.0.1:5123/?state=ab' })),
    createStatus: vi.fn(async (): Promise<IdentityCreateStatus> => (++reads < 2
      ? { status: 'pending', localUrl: 'http://127.0.0.1:5123/?state=ab' }
      : { status: 'complete', result: { id: '9', slug: 'new-bot', installUrl: 'https://github.com/apps/new-bot/installations/new' } })),
    cancelCreate: vi.fn(async () => {}),
    connect: vi.fn(async (id: string) => {
      current = [...current, app('linked-bot')];
      return { id, slug: 'linked-bot', installUrl: 'https://github.com/apps/linked-bot/installations/new' };
    }),
    rotateKey: vi.fn(async (slug: string) => ({ id: '1', slug, installUrl: `https://github.com/apps/${slug}/installations/new`, retired: 'SHA256:old=' })),
    assign: vi.fn(async (slug: string, target: { soul: string } | { harness: string }) => {
      if ('soul' in target) {
        current = current.map((a) => ({ ...a, souls: a.slug === slug ? [...a.souls, target.soul] : a.souls.filter((s) => s !== target.soul) }));
      }
      return { slug, ...target };
    }),
    open: vi.fn(async () => {}),
    ...over,
  } satisfies IdentityAppsSource;
  return source;
}

const withIdentities = (source: IdentityAppsSource | null, ui: ReactNode) =>
  render(<I18nProvider><IdentityAppsProvider source={source}>{ui}</IdentityAppsProvider></I18nProvider>);

const expand = async () => fireEvent.click(await screen.findByRole('button', { name: 'Show GitHub Apps' }));

const actsAs = async () => (await screen.findByText('Acts as', { selector: 'dt' })).nextElementSibling as HTMLElement;

describe('Acts as row', () => {
  it('names the App whose souls include this companion', async () => {
    withIdentities(fakeSource([app('luna-bot', { souls: [luna.agentId] }), app('other-bot')]), <CompanionDetails soul={luna} />);
    const value = await actsAs();
    await waitFor(() => expect(value.textContent).toContain('luna-bot[bot]'));
  });

  it('says "your account" when no App names it', async () => {
    withIdentities(fakeSource([app('luna-bot', { souls: [luna.agentId] })]), <CompanionDetails soul={child} />);
    const value = await actsAs();
    await waitFor(() => expect(value.textContent).toContain('your account'));
  });

  it('is hidden when the list cannot be read, keeping the census App row', async () => {
    const source = fakeSource([], { list: vi.fn(async () => { throw new BridgeError('identity-app-failed', 'usage'); }) });
    withIdentities(source, <><CompanionDetails soul={luna} /><IdentityAppsCard /></>);
    await waitFor(() => expect(source.list).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByText('Acts as', { selector: 'dt' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'GitHub identity' })).toBeNull();
  });

  it('assigns another App to this companion through agent-bot', async () => {
    const source = fakeSource([app('luna-bot', { souls: [luna.agentId] }), app('other-bot'), app('no-key', { keyPresent: false })]);
    withIdentities(source, <CompanionDetails soul={luna} />);
    const change = await screen.findByRole('combobox', { name: 'Change the GitHub App for luna' }) as HTMLSelectElement;
    expect([...change.options].map((o) => o.textContent)).toEqual(['Change…', 'other-bot[bot]']);
    fireEvent.change(change, { target: { value: 'other-bot' } });
    expect(source.assign).toHaveBeenCalledWith('other-bot', { soul: luna.agentId });
    await waitFor(async () => expect((await actsAs()).textContent).toContain('other-bot[bot]'));
  });

  it('rotates the current key and says to delete the old one on github.com', async () => {
    const source = fakeSource([app('luna-bot', { souls: [luna.agentId] })]);
    withIdentities(source, <CompanionDetails soul={luna} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate key…' }));
    expect(source.rotateKey).toHaveBeenCalledWith('luna-bot', 'Choose the new private key for luna-bot (.pem)');
    const notice = await screen.findByText(/New key in use for luna-bot\./);
    expect(notice.textContent).toContain('Old key: SHA256:old=.');
    expect(notice.textContent).toContain('Delete the old key in the App’s settings on github.com');
  });

  it('offers Connect… when agent-bot manages no App, with the App ID', async () => {
    const source = fakeSource([]);
    withIdentities(source, <CompanionDetails soul={luna} />);
    expect((await actsAs()).textContent).toContain('your account');
    fireEvent.click(screen.getByRole('button', { name: 'Connect…' }));
    const choose = screen.getByRole('button', { name: 'Choose key file…' }) as HTMLButtonElement;
    expect(choose.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'App ID' }), { target: { value: ' 123 ' } });
    fireEvent.click(choose);
    expect(source.connect).toHaveBeenCalledWith('123', 'Choose the GitHub App’s private key (.pem)');
    expect(await screen.findByRole('combobox', { name: 'Change the GitHub App for luna' })).toBeTruthy();
  });

  it('shows a refusal, but not a closed file dialog', async () => {
    const source = fakeSource([app('luna-bot', { souls: [luna.agentId] })], {
      rotateKey: vi.fn(async () => { throw new BridgeError('identity-app-cancelled', 'no key file was chosen'); }),
    });
    withIdentities(source, <CompanionDetails soul={luna} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate key…' }));
    await waitFor(() => expect(source.list).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('IdentityAppsCard', () => {
  it('starts folded to a summary line, so the Apps never crowd out the fleet (#189)', async () => {
    withIdentities(fakeSource([app('luna-bot'), app('keyless', { keyPresent: false })]), <IdentityAppsCard roster={sampleCensus} />);
    expect(await screen.findByText('2 Apps, 1 ready')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'GitHub Apps' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create a new App' })).toBeNull();
    await expand();
    expect(screen.getByRole('list', { name: 'GitHub Apps' })).toBeTruthy();
    expect(screen.getByText(/Companions can act on GitHub/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide GitHub Apps' }));
    expect(screen.queryByRole('list', { name: 'GitHub Apps' })).toBeNull();
  });

  it('lists each App with its status, installations, harnesses and companions', async () => {
    withIdentities(fakeSource([
      app('luna-bot', { souls: [luna.agentId, 'agent_archived-1'], harnesses: ['codex'] }),
      app('keyless', { keyPresent: false, installations: [], souls: ['agent_gone-1', 'agent_gone-2'] }),
      app('broken', { liveMint: { status: 'failed', code: 'mint-failed', checkedAt: null }, installations: [{ id: 2, account: 'me', repositorySelection: 'selected' }] }),
    ]), <IdentityAppsCard roster={sampleCensus} />);
    await expand();
    const list = await screen.findByRole('list', { name: 'GitHub Apps' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0].textContent).toContain('luna-bot[bot]');
    expect(rows[0].textContent).toContain('Ready');
    expect(rows[0].textContent).toContain('Installed on qwts (all repositories)');
    expect(rows[0].textContent).toContain('Harnesses: codex');
    expect(rows[0].textContent).toContain('Companions: luna and 1 more');
    expect(rows[0].textContent).not.toContain('agent_archived-1');
    expect(rows[1].textContent).toContain('Companions: 2 not on the desk');
    expect(rows[1].textContent).toContain('Key missing');
    expect(rows[1].textContent).toContain('No installation known yet');
    expect(within(rows[1]).queryByRole('button', { name: 'Rotate key…' })).toBeNull();
    expect(rows[2].textContent).toContain('Token mint failing');
    expect(rows[2].textContent).toContain('Installed on me (selected repositories)');
    expect((screen.getByRole('switch', { name: 'github-identity add-on' }) as HTMLInputElement).checked).toBe(true);
  });

  it('shows the add-on off, with how to turn it on, while agent-bot lists no Apps', async () => {
    withIdentities(fakeSource([]), <IdentityAppsCard />);
    const toggle = await screen.findByRole('switch', { name: 'github-identity add-on' }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(true);
    await expand();
    expect(screen.getByText(/"features": \{"github-identity": true\}/)).toBeTruthy();
  });

  it('creates an App: opens the local page, waits for GitHub, then offers the install page', async () => {
    const source = fakeSource([]);
    withIdentities(source, <IdentityAppsCard pollMs={1} />);
    await expand();
    fireEvent.click(await screen.findByRole('button', { name: 'Create a new App' }));
    expect(await screen.findByText('Waiting for GitHub…')).toBeTruthy();
    expect(source.open).toHaveBeenCalledWith('http://127.0.0.1:5123/?state=ab');
    const install = await screen.findByRole('button', { name: 'Install on GitHub' });
    expect(screen.getByText(/Created new-bot\./)).toBeTruthy();
    fireEvent.click(install);
    expect(source.open).toHaveBeenLastCalledWith('https://github.com/apps/new-bot/installations/new');
  });

  it('explains a refusal because the add-on is off', async () => {
    const source = fakeSource([], {
      create: vi.fn(async () => { throw new BridgeError('identity-app-disabled', 'Enable the github-identity add-on before managing Apps.'); }),
    });
    withIdentities(source, <IdentityAppsCard />);
    await expand();
    fireEvent.click(await screen.findByRole('button', { name: 'Create a new App' }));
    expect((await screen.findByRole('alert')).textContent).toContain('The github-identity add-on is off.');
  });

  it('connects an existing App by ID and key file', async () => {
    const source = fakeSource([]);
    withIdentities(source, <IdentityAppsCard />);
    await expand();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect an existing App' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'App ID' }), { target: { value: '42' } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose key file…' }));
    expect(source.connect).toHaveBeenCalledWith('42', 'Choose the GitHub App’s private key (.pem)');
    expect(await screen.findByText('linked-bot[bot]')).toBeTruthy();
  });

  it('sits below Sandboxing in the menu', async () => {
    render(<App census={sampleCensus} connection={sampleConnection} isStatic sandboxSource={null} identityAppsSource={fakeSource([app('luna-bot')])} />);
    expect(await screen.findByRole('region', { name: 'GitHub identity' })).toBeTruthy();
  });
});

describe('agent-bot identity calls', () => {
  it('normalizes the list and maps statuses', () => {
    const apps = normalizeIdentityApps({ apps: [{ slug: 'a', keyPresent: true, liveMint: { status: 'unknown' } }, { nope: 1 }] });
    expect(apps).toHaveLength(1);
    expect(apps?.[0].botLogin).toBe('a[bot]');
    expect(identityStatus(apps![0])).toBe('unknown');
    expect(normalizeIdentityApps({})).toBeNull();
  });

  it('invokes the shell commands with their arguments', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'identity_apps_list') return { apps: [] };
      if (command === 'identity_app_create') return { handle: 3, localUrl: 'http://127.0.0.1:1/' };
      if (command === 'identity_app_assign') return { slug: 'a', soul: 'agent_1' };
      return { id: '1', slug: 'a', installUrl: 'https://github.com/apps/a/installations/new', retired: 'SHA256:x' };
    });
    expect(await liveIdentityApps.list()).toEqual([]);
    expect(await liveIdentityApps.create()).toEqual({ handle: 3, localUrl: 'http://127.0.0.1:1/' });
    await liveIdentityApps.connect('12', 'pick');
    await liveIdentityApps.rotateKey('a', 'pick');
    await liveIdentityApps.assign('a', { soul: 'agent_1' });
    await liveIdentityApps.assign('a', { harness: 'codex' });
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['identity_apps_list', {}],
      ['identity_app_create', {}],
      ['identity_app_connect', { id: '12', prompt: 'pick' }],
      ['identity_app_rotate_key', { slug: 'a', prompt: 'pick' }],
      ['identity_app_assign', { slug: 'a', soul: 'agent_1' }],
      ['identity_app_assign', { slug: 'a', harness: 'codex' }],
    ]);
    vi.mocked(invoke).mockRejectedValueOnce({ code: 'identity-app-disabled', message: 'off' });
    await expect(liveIdentityApps.connect('1', 'p')).rejects.toMatchObject({ code: 'identity-app-disabled' });
  });
});

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
  GitHubAppRow, identityStatus, IdentityAppsProvider, liveIdentityApps, normalizeIdentityApps, normalizeIdentityAppsList,
  type IdentityApp, type IdentityAppsSource, type IdentityCreateStatus,
} from './IdentityApps';
import { IdentityAppsCard } from './IdentityAppsCard';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

afterEach(() => { cleanup(); globalThis.localStorage?.clear(); layoutActions.forget(); preferenceActions.forget(); vi.mocked(invoke).mockReset(); });

const [luna, child] = sampleCensus;

function app(slug: string, over: Partial<IdentityApp> = {}): IdentityApp {
  return {
    slug, botLogin: `${slug}[bot]`, issuerPresent: true, keyPresent: true, key: null,
    installations: [{ id: 7, account: 'qwts', repositorySelection: 'all' }],
    harnesses: [], souls: [], liveMint: { status: 'ready', code: null, checkedAt: '2026-10-06T10:00:00Z' }, ...over,
  };
}

/**
 * A fake agent-bot: `assign` moves the soul or harness, `create` completes on
 * the second status read, `remove` drops an App no harness or soul uses, and
 * `setAddon` switches the add-on. `addons` undefined is an older bundle.
 */
function fakeSource(initial: IdentityApp[], over: Partial<IdentityAppsSource> = {}, addon?: boolean) {
  let current = initial;
  let enabled = addon;
  let reads = 0;
  const source = {
    list: vi.fn(async () => ({
      apps: enabled === false ? [] : current,
      addons: enabled === undefined ? null : { 'github-identity': enabled },
    })),
    create: vi.fn(async () => ({ handle: 1, localUrl: 'http://127.0.0.1:5123/?state=ab' })),
    createStatus: vi.fn(async (): Promise<IdentityCreateStatus> => (++reads < 2
      ? { status: 'pending', localUrl: 'http://127.0.0.1:5123/?state=ab' }
      : { status: 'complete', result: { id: '9', slug: 'new-bot', installUrl: 'https://github.com/apps/new-bot/installations/new' } })),
    cancelCreate: vi.fn(async () => {}),
    createPending: vi.fn(async () => []),
    connect: vi.fn(async (id: string) => {
      current = [...current, app('linked-bot')];
      return { id, slug: 'linked-bot', installUrl: 'https://github.com/apps/linked-bot/installations/new' };
    }),
    rotateKey: vi.fn(async (slug: string) => ({ id: '1', slug, installUrl: `https://github.com/apps/${slug}/installations/new`, retired: 'SHA256:old=' })),
    assign: vi.fn(async (slug: string, target: { soul: string } | { harness: string }) => {
      if ('soul' in target) {
        current = current.map((a) => ({ ...a, souls: a.slug === slug ? [...a.souls, target.soul] : a.souls.filter((s) => s !== target.soul) }));
      } else {
        current = current.map((a) => ({ ...a, harnesses: a.slug === slug ? [...a.harnesses, target.harness] : a.harnesses.filter((h) => h !== target.harness) }));
      }
      return { slug, ...target };
    }),
    remove: vi.fn(async (slug: string) => {
      const gone = current.find((a) => a.slug === slug);
      if (gone && (gone.harnesses.length > 0 || gone.souls.length > 0)) {
        throw new BridgeError('identity-app-assigned',
          `${slug} is still used by ${[...gone.harnesses.map((h) => `harness ${h}`), ...gone.souls.map((s) => `soul ${s}`)].join(', ')}; assign them another App first.`);
      }
      current = current.filter((a) => a.slug !== slug);
      return { slug, id: '1', removed: { storeItem: null, configRecord: true } };
    }),
    setAddon: vi.fn(async (_name: 'github-identity', next: boolean) => {
      const changed = enabled !== next;
      enabled = next;
      return { addon: 'github-identity', enabled: next, changed };
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

  it('keeps only Change…: Rotate key and Connect moved to the ⓘ sheet\'s GitHub App row', async () => {
    withIdentities(fakeSource([app('luna-bot', { souls: [luna.agentId] }), app('other-bot')]), <CompanionDetails soul={luna} />);
    const value = await actsAs();
    await waitFor(() => expect(within(value).getByRole('combobox', { name: 'Change the GitHub App for luna' })).toBeTruthy());
    expect(within(value).queryByRole('button')).toBeNull();
  });

  it('offers no Connect… when agent-bot manages no App', async () => {
    withIdentities(fakeSource([]), <CompanionDetails soul={luna} />);
    const value = await actsAs();
    await waitFor(() => expect(value.textContent).toContain('your account'));
    expect(within(value).queryByRole('button')).toBeNull();
  });
});

describe('GitHub App row in the ⓘ sheet (Lovable fidelity pass 5)', () => {
  const issuedAt = '2026-10-01T12:00:00Z';
  const keyed = (over: Partial<IdentityApp> = {}) =>
    app('luna-bot', { souls: [luna.agentId], key: { fingerprint: 'SHA256:abc=', updatedAt: issuedAt }, ...over });
  const row = (source: IdentityAppsSource | null, appSlug: string | null = 'luna-bot') =>
    withIdentities(source, <GitHubAppRow agentId={luna.agentId} name="luna" appSlug={appSlug} />);

  it('shows the key fingerprint and when it was issued', async () => {
    row(fakeSource([keyed()]));
    const when = new Date(issuedAt).toLocaleDateString('en');
    expect(await screen.findByText(`Connected · key SHA256:abc= · Key issued ${when}`)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'GitHub App' })).toBeTruthy();
  });

  it('leaves out the issued date when agent-bot does not know it', async () => {
    row(fakeSource([keyed({ key: { fingerprint: 'SHA256:abc=', updatedAt: null } })]));
    expect(await screen.findByText('Connected · key SHA256:abc=')).toBeTruthy();
  });

  it('shows Connected · {app} when an older agent-bot gives no key', async () => {
    row(fakeSource([app('luna-bot', { souls: [luna.agentId] })]));
    expect(await screen.findByRole('button', { name: 'Rotate key' })).toBeTruthy();
    expect(screen.getByText('Connected · luna-bot')).toBeTruthy();
  });

  it('is text only while the managed Apps are hidden', () => {
    row(null);
    expect(screen.getByText('Connected · luna-bot')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    row(null, null);
    expect(screen.getByText('Not connected · joins without an App')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('rotates the key and says to delete the old one on github.com', async () => {
    const source = fakeSource([keyed()]);
    row(source);
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate key' }));
    expect(source.rotateKey).toHaveBeenCalledWith('luna-bot', 'Choose the new private key for luna-bot (.pem)');
    const notice = await screen.findByText(/New key in use for luna-bot\./);
    expect(notice.textContent).toContain('Old key: SHA256:old=.');
    expect(notice.textContent).toContain('Delete the old key in the App’s settings on github.com');
  });

  it('rotates the key from a pass-cli item named inline, without a file dialog', async () => {
    const source = fakeSource([keyed()]);
    row(source);
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate from pass-cli…' }));
    const go = screen.getByRole('button', { name: 'Rotate' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'pass-cli item' }), { target: { value: ' luna-key ' } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    expect(source.rotateKey).toHaveBeenCalledWith('luna-bot', '', 'luna-key');
    expect(screen.queryByRole('textbox', { name: 'pass-cli item' })).toBeNull();
    expect((await screen.findByText(/New key in use for luna-bot\./)).textContent).toContain('Old key: SHA256:old=.');
    // Cancel folds the field away, calling nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Rotate from pass-cli…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox', { name: 'pass-cli item' })).toBeNull();
    expect(source.rotateKey).toHaveBeenCalledTimes(1);
  });

  it('shows a rotation refusal, but not a closed file dialog', async () => {
    const source = fakeSource([keyed()], {
      rotateKey: vi.fn(async () => { throw new BridgeError('identity-app-cancelled', 'no key file was chosen'); }),
    });
    row(source);
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate key' }));
    await waitFor(() => expect(source.list).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).toBeNull();
    vi.mocked(source.rotateKey).mockRejectedValueOnce(new BridgeError('identity-app-failed', 'the owner did not approve'));
    fireEvent.click(screen.getByRole('button', { name: 'Rotate key' }));
    expect((await screen.findByRole('alert')).textContent).toBe('GitHub identity unchanged: the owner did not approve');
  });

  it('Connect GitHub App opens Change…, and choosing an App assigns it', async () => {
    const source = fakeSource([app('other-bot', { key: { fingerprint: 'SHA256:other=', updatedAt: null } }), app('no-key', { keyPresent: false })]);
    row(source, null);
    const connect = await screen.findByRole('button', { name: 'Connect GitHub App' });
    expect(screen.getByText('Not connected · joins without an App')).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(connect);
    const change = screen.getByRole('combobox', { name: 'Change the GitHub App for luna' }) as HTMLSelectElement;
    expect([...change.options].map((o) => o.textContent)).toEqual(['Change…', 'other-bot[bot]']);
    fireEvent.change(change, { target: { value: 'other-bot' } });
    expect(source.assign).toHaveBeenCalledWith('other-bot', { soul: luna.agentId });
    expect(await screen.findByText('Connected · key SHA256:other=')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rotate key' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect GitHub App' })).toBeNull();
  });

  it('Connect GitHub App opens the App ID form when agent-bot manages no App', async () => {
    const source = fakeSource([]);
    row(source, null);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect GitHub App' }));
    const choose = screen.getByRole('button', { name: 'Choose key file…' }) as HTMLButtonElement;
    expect(choose.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'App ID' }), { target: { value: ' 123 ' } });
    fireEvent.click(choose);
    expect(source.connect).toHaveBeenCalledWith('123', 'Choose the GitHub App’s private key (.pem)');
    expect(await screen.findByRole('combobox', { name: 'Change the GitHub App for luna' })).toBeTruthy();
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

  it('connects an existing App from a pass-cli item, with no file dialog', async () => {
    const source = fakeSource([]);
    withIdentities(source, <IdentityAppsCard />);
    await expand();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect an existing App' }));
    const connect = screen.getByRole('button', { name: 'Connect from pass-cli' }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    expect(screen.getByText('Or the name of the key’s item in pass-cli; agent-bot restores it itself.')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'App ID' }), { target: { value: '42' } });
    expect(connect.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'pass-cli item' }), { target: { value: ' luna-key ' } });
    expect(connect.disabled).toBe(false);
    fireEvent.click(connect);
    expect(source.connect).toHaveBeenCalledWith('42', '', 'luna-key');
    expect(await screen.findByText('linked-bot[bot]')).toBeTruthy();
  });

  it('takes up a create still waiting for GitHub from before GeniusBar last quit', async () => {
    const source = fakeSource([], { createPending: vi.fn(async () => [{ handle: 7, localUrl: 'http://127.0.0.1:5123/?state=ab' }]) });
    withIdentities(source, <IdentityAppsCard pollMs={1} />);
    await expand();
    expect(await screen.findByText('Waiting for GitHub…')).toBeTruthy();
    expect(source.create).not.toHaveBeenCalled();
    expect(source.open).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Create a new App' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Open the page again' }));
    expect(source.open).toHaveBeenCalledWith('http://127.0.0.1:5123/?state=ab');
    await waitFor(() => expect(source.createStatus).toHaveBeenCalledWith(7));
    expect(await screen.findByRole('button', { name: 'Install on GitHub' })).toBeTruthy();
  });

  it('rotates an App\'s key from a pass-cli item in the list', async () => {
    const source = fakeSource([app('luna-bot')]);
    withIdentities(source, <IdentityAppsCard />);
    await expand();
    const row = within(await screen.findByRole('list', { name: 'GitHub Apps' })).getAllByRole('listitem')[0];
    fireEvent.click(within(row).getByRole('button', { name: 'Rotate from pass-cli…' }));
    fireEvent.change(within(row).getByRole('textbox', { name: 'pass-cli item' }), { target: { value: 'luna-key' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Rotate' }));
    expect(source.rotateKey).toHaveBeenCalledWith('luna-bot', '', 'luna-key');
    expect((await within(row).findByText(/New key in use for luna-bot\./)).textContent).toContain('Old key: SHA256:old=.');
  });

  it('switches the add-on on through agent-bot when the list reports it', async () => {
    const source = fakeSource([app('luna-bot')], {}, false);
    withIdentities(source, <IdentityAppsCard />);
    const toggle = await screen.findByRole('switch', { name: 'github-identity add-on' }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(false);
    await expand();
    expect(screen.getByText(/Off: companions act on GitHub as your account/)).toBeTruthy();
    expect(screen.queryByText(/config\.json/)).toBeNull();
    fireEvent.click(toggle);
    expect(source.setAddon).toHaveBeenCalledWith('github-identity', true);
    expect(toggle.disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('Waiting for your approval…');
    await waitFor(() => expect(toggle.checked).toBe(true));
    expect(toggle.disabled).toBe(false);
    expect(await screen.findByText('luna-bot[bot]')).toBeTruthy();
    fireEvent.click(toggle);
    expect(source.setAddon).toHaveBeenLastCalledWith('github-identity', false);
    await waitFor(() => expect(toggle.checked).toBe(false));
    expect(screen.queryByRole('list', { name: 'GitHub Apps' })).toBeNull();
  });

  it('shows a refused switch and leaves the add-on as it was', async () => {
    const source = fakeSource([], {
      setAddon: vi.fn(async () => { throw new BridgeError('identity-app-owner-required', 'The owner did not approve.'); }),
    }, false);
    withIdentities(source, <IdentityAppsCard />);
    const toggle = await screen.findByRole('switch', { name: 'github-identity add-on' }) as HTMLInputElement;
    fireEvent.click(toggle);
    expect((await screen.findByRole('alert')).textContent).toBe('GitHub identity unchanged: The owner did not approve.');
    expect(toggle.checked).toBe(false);
  });

  it('keeps the switch read-only, and offers no Remove…, for an older bundle', async () => {
    const source = fakeSource([app('luna-bot')]);
    withIdentities(source, <IdentityAppsCard />);
    const toggle = await screen.findByRole('switch', { name: 'github-identity add-on' }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(true);
    fireEvent.click(toggle);
    expect(source.setAddon).not.toHaveBeenCalled();
    await expand();
    expect(screen.getByText('luna-bot[bot]')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove…' })).toBeNull();
  });

  it('removes an App after asking, and says it stays on GitHub', async () => {
    const source = fakeSource([app('luna-bot'), app('other-bot')], {}, true);
    withIdentities(source, <IdentityAppsCard />);
    await expand();
    const rows = within(await screen.findByRole('list', { name: 'GitHub Apps' })).getAllByRole('listitem');
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Remove…' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Forget luna-bot[bot] on this Mac?' });
    expect(dialog.textContent).toContain('Its private key and its local record');
    expect(dialog.textContent).toContain('The App itself stays on GitHub');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(source.remove).not.toHaveBeenCalled();
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Remove…' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    expect(source.remove).toHaveBeenCalledWith('luna-bot');
    expect(await screen.findByText('Forgot luna-bot[bot] on this Mac. The App is still on GitHub.')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(screen.queryByText('luna-bot[bot]')).toBeNull());
    expect(screen.getByText('other-bot[bot]')).toBeTruthy();
  });

  it('shows agent-bot\'s refusal naming who still uses the App, and keeps it', async () => {
    const source = fakeSource([app('luna-bot', { harnesses: ['codex'], souls: [luna.agentId] })], {}, true);
    withIdentities(source, <IdentityAppsCard roster={sampleCensus} />);
    await expand();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove…' }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect((await within(dialog).findByRole('alert')).textContent)
      .toBe(`GitHub identity unchanged: luna-bot is still used by harness codex, soul ${luna.agentId}; assign them another App first.`);
    expect((within(dialog).getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('luna-bot[bot]')).toBeTruthy();
  });

  it('uses an App for a harness through agent-bot', async () => {
    const source = fakeSource([app('luna-bot', { harnesses: ['claude'] }), app('keyless', { keyPresent: false })], {}, true);
    withIdentities(source, <IdentityAppsCard roster={sampleCensus} />);
    await expand();
    const rows = within(await screen.findByRole('list', { name: 'GitHub Apps' })).getAllByRole('listitem');
    expect(within(rows[1]).queryByRole('combobox')).toBeNull();
    const select = within(rows[0]).getByRole('combobox', { name: 'Use luna-bot[bot] for a harness' }) as HTMLSelectElement;
    const options = [...select.options].map((o) => o.textContent);
    expect(options[0]).toBe('Use for a harness…');
    expect(options).toContain('opencode');
    expect(options).not.toContain('Claude Code');
    fireEvent.change(select, { target: { value: 'opencode' } });
    expect(source.assign).toHaveBeenCalledWith('luna-bot', { harness: 'opencode' });
    await waitFor(() => expect(rows[0].textContent).toContain('Harnesses: claude, opencode'));
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

  it('reads the add-on state from the envelope, and none from an older bundle', () => {
    expect(normalizeIdentityAppsList({ apps: [], addons: { 'github-identity': false } })).toEqual({ apps: [], addons: { 'github-identity': false } });
    expect(normalizeIdentityAppsList({ apps: [] })?.addons).toBeNull();
    expect(normalizeIdentityAppsList({ apps: [], addons: { 'github-identity': 'on' } })?.addons).toBeNull();
    expect(normalizeIdentityAppsList({})).toBeNull();
  });

  it('reads the key fingerprint, and null from an older bundle or a malformed key', () => {
    const apps = normalizeIdentityApps({ apps: [
      { slug: 'new', keyPresent: true, key: { fingerprint: 'SHA256:abc=', updatedAt: '2026-10-01T12:00:00Z' } },
      { slug: 'legacy', keyPresent: true, key: { fingerprint: 'SHA256:def=', updatedAt: null } },
      { slug: 'old', keyPresent: true },
      { slug: 'keyless', keyPresent: false, key: null },
      { slug: 'odd', keyPresent: true, key: { fingerprint: 7 } },
    ] });
    expect(apps?.map((a) => a.key)).toEqual([
      { fingerprint: 'SHA256:abc=', updatedAt: '2026-10-01T12:00:00Z' },
      { fingerprint: 'SHA256:def=', updatedAt: null },
      null, null, null,
    ]);
  });

  it('invokes the shell commands with their arguments', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'identity_apps_list') return { apps: [], addons: { 'github-identity': true } };
      if (command === 'identity_addon_set') return { addon: 'github-identity', enabled: false, changed: true };
      if (command === 'identity_app_remove') return { slug: 'a', id: '1', removed: { storeItem: { store: 'keychain', name: 'agent-bot.app.a/github-app/a', existed: true }, configRecord: true } };
      if (command === 'identity_app_create') return { handle: 3, localUrl: 'http://127.0.0.1:1/' };
      if (command === 'identity_app_create_pending') return [{ handle: 7, localUrl: 'http://127.0.0.1:2/' }, { nope: 1 }];
      if (command === 'identity_app_assign') return { slug: 'a', soul: 'agent_1' };
      return { id: '1', slug: 'a', installUrl: 'https://github.com/apps/a/installations/new', retired: 'SHA256:x' };
    });
    expect(await liveIdentityApps.list()).toEqual({ apps: [], addons: { 'github-identity': true } });
    expect(await liveIdentityApps.create()).toEqual({ handle: 3, localUrl: 'http://127.0.0.1:1/' });
    expect(await liveIdentityApps.createPending()).toEqual([{ handle: 7, localUrl: 'http://127.0.0.1:2/' }]);
    await liveIdentityApps.connect('12', 'pick');
    await liveIdentityApps.connect('12', '', 'luna-key');
    await liveIdentityApps.rotateKey('a', 'pick');
    await liveIdentityApps.rotateKey('a', '', 'luna-key');
    await liveIdentityApps.assign('a', { soul: 'agent_1' });
    await liveIdentityApps.assign('a', { harness: 'codex' });
    expect(await liveIdentityApps.setAddon('github-identity', false)).toEqual({ addon: 'github-identity', enabled: false, changed: true });
    expect((await liveIdentityApps.remove('a')).removed).toEqual({
      storeItem: { store: 'keychain', name: 'agent-bot.app.a/github-app/a', existed: true }, configRecord: true,
    });
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['identity_apps_list', {}],
      ['identity_app_create', {}],
      ['identity_app_create_pending', {}],
      ['identity_app_connect', { id: '12', prompt: 'pick' }],
      ['identity_app_connect', { id: '12', prompt: '', passCli: 'luna-key' }],
      ['identity_app_rotate_key', { slug: 'a', prompt: 'pick' }],
      ['identity_app_rotate_key', { slug: 'a', prompt: '', passCli: 'luna-key' }],
      ['identity_app_assign', { slug: 'a', soul: 'agent_1' }],
      ['identity_app_assign', { slug: 'a', harness: 'codex' }],
      ['identity_addon_set', { name: 'github-identity', enabled: false }],
      ['identity_app_remove', { slug: 'a' }],
    ]);
    vi.mocked(invoke).mockRejectedValueOnce({ code: 'identity-app-disabled', message: 'off' });
    await expect(liveIdentityApps.connect('1', 'p')).rejects.toMatchObject({ code: 'identity-app-disabled' });
  });
});

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeError, type SoulProfile, type SoulProfileFile } from '../bridge';
import { sampleCensus, sampleProfile, sampleProfileFiles } from '../model/fixtures';
import { ProfileSourceContext, type ProfileSource } from '../useSoulProfile';
import { CustomizeDialog } from './CustomizeDialog';

afterEach(cleanup);

const [luna] = sampleCensus;

function source(overrides: Partial<ProfileSource> = {}): ProfileSource {
  return {
    profile: vi.fn(async (): Promise<SoulProfile> => sampleProfile),
    file: vi.fn(async (agentId: string, path: string): Promise<SoulProfileFile> => ({ agentId, path, size: 1, contents: sampleProfileFiles[path] ?? '' })),
    ...overrides,
  };
}

function open(s: ProfileSource, onClose = vi.fn(), wrap = (node: ReactNode) => node) {
  render(<ProfileSourceContext.Provider value={s}>{wrap(<CustomizeDialog soul={luna} onClose={onClose} />)}</ProfileSourceContext.Provider>);
  return { onClose, dialog: screen.getByRole('dialog') };
}

describe('CustomizeDialog (#64)', () => {
  it('is named by its heading and shows the profile read-only, with no Save', async () => {
    const s = source();
    const { dialog } = open(s);
    expect(await screen.findByRole('dialog', { name: 'Luna' })).toBe(dialog);
    expect(s.profile).toHaveBeenCalledWith(luna.agentId);
    expect(within(dialog).getByText('claude', { selector: 'span' })).toBeTruthy();
    expect(within(dialog).getByRole('tab', { name: 'Profile' }).getAttribute('aria-selected')).toBe('true');
    const name = within(dialog).getByLabelText('Name') as HTMLInputElement;
    expect(name.value).toBe('Luna');
    expect(name.disabled && name.readOnly).toBe(true);
    const role = within(dialog).getByLabelText('Role') as HTMLInputElement;
    expect(role.disabled).toBe(true);
    const description = within(dialog).getByLabelText('Description') as HTMLTextAreaElement;
    expect(description.value).toBe(sampleProfile.profile.description);
    expect(description.disabled).toBe(true);
    expect(within(dialog).getByText('/Users/user/Souls/Luna.soul')).toBeTruthy();
    expect(within(dialog).getByText('2026.10.1')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Save' })).toBeNull();
    expect(within(dialog).queryByText('Color')).toBeNull();
  });

  it('shows the SOP, skills with source and commit, credential names and status, and the files', async () => {
    const { dialog } = open(source());
    await within(dialog).findByDisplayValue('Luna');
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Context' }));
    expect(within(dialog).getByRole('tab', { name: 'Context' }).getAttribute('aria-selected')).toBe('true');
    const panel = within(dialog).getByRole('tabpanel');
    expect(within(panel).getByText("Files the harness loads into this agent's context.")).toBeTruthy();
    // SOP: resolved with its pinned commit, and the soul's own override.
    expect(within(panel).getByText('qwts/agent-sop', { exact: false }).textContent).toContain('commit 3f9c2a1d7e');
    expect(within(panel).getByText('agent-sop.toml', { exact: false })).toBeTruthy();
    expect(within(panel).getByText('workflows/release.toml')).toBeTruthy();
    // Skills: the SOP's with their commit, the soul's own without one.
    const skills = within(panel).getByRole('heading', { name: 'Skills' }).nextElementSibling as HTMLElement;
    const review = within(skills).getByText('review').closest('li') as HTMLElement;
    expect(review.textContent).toContain('SOP');
    expect(review.textContent).toContain('commit 3f9c2a1d7e');
    const triage = within(skills).getByText('triage').closest('li') as HTMLElement;
    expect(triage.textContent).toContain('own');
    expect(triage.textContent).toContain('no commit');
    // Credentials: name, provider and status, nothing else.
    const credentials = within(panel).getByRole('heading', { name: 'Credentials' }).nextElementSibling as HTMLElement;
    expect(credentials.textContent).toBe('luna-geniusbargithubdeclared');
    // Files: text files open; the rest say why not.
    expect(within(panel).getByRole('button', { name: /soul\.md/ })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: /^CLAUDE\.md/ })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: /\.claude\/settings\.json/ })).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: /diagram\.png/ })).toBeNull();
    expect(within(panel).getByText('skills/triage/diagram.png').closest('li')?.textContent).toContain('not text');
  });

  it('never shows a credential value, even if agent-bot sent one', async () => {
    const leaky = { ...sampleProfile, credentials: [{ name: 'luna-app', provider: 'github', status: 'declared', value: 'ghs_secretvalue', token: 'ghp_x' }] } as unknown as SoulProfile;
    const { normalizeSoulProfile } = await import('../bridge');
    const s = source({ profile: vi.fn(async () => normalizeSoulProfile(leaky)!) });
    const { dialog } = open(s);
    await within(dialog).findByDisplayValue('Luna');
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Context' }));
    expect(within(dialog).getByText('luna-app')).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/ghs_|ghp_|secret/);
  });

  it('opens a file read-only through soul profile --file, and goes back', async () => {
    const s = source();
    const { dialog } = open(s);
    await within(dialog).findByDisplayValue('Luna');
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Context' }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^CLAUDE\.md/ }));
    expect(s.file).toHaveBeenCalledWith(luna.agentId, 'CLAUDE.md');
    expect(within(dialog).getByRole('heading', { name: 'CLAUDE.md' })).toBeTruthy();
    const viewer = await within(dialog).findByLabelText('CLAUDE.md');
    expect(viewer.tagName).toBe('PRE');
    expect(viewer.textContent).toBe(sampleProfileFiles['CLAUDE.md']);
    expect(within(dialog).queryByRole('textbox', { name: 'CLAUDE.md' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back to context' }));
    expect(within(dialog).getByRole('heading', { name: 'Files' })).toBeTruthy();
  });

  it('says why a file did not open', async () => {
    const s = source({ file: vi.fn(async (): Promise<SoulProfileFile> => { throw new BridgeError('soul-profile-file-too-large', 'Profile file is larger than 262144 bytes.'); }) });
    const { dialog } = open(s);
    await within(dialog).findByDisplayValue('Luna');
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Context' }));
    fireEvent.click(within(dialog).getByRole('button', { name: /soul\.md/ }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Could not open soul.md: Profile file is larger than 262144 bytes.');
  });

  it('lists agent-bot\'s errors as muted lines', async () => {
    const s = source({ profile: vi.fn(async () => ({ ...sampleProfile, errors: [...sampleProfile.errors, { area: 'sop', message: 'SOP pins need the network' }] })) });
    const { dialog } = open(s);
    expect(await within(dialog).findByText('skills: skills/draft/SKILL.md is not UTF-8 text')).toBeTruthy();
    expect(within(dialog).getByText('sop: SOP pins need the network')).toBeTruthy();
  });

  it('says why the profile could not be read', async () => {
    const s = source({ profile: vi.fn(async (): Promise<SoulProfile> => { throw new BridgeError('soul-not-found', 'No soul named luna.'); }) });
    const { dialog } = open(s);
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Could not read the profile: No soul named luna.');
    expect(screen.getByRole('dialog', { name: 'luna' })).toBe(dialog);
  });

  it('closes on Escape, ×, Close and a backdrop click, and not on a click inside', async () => {
    const { onClose, dialog } = open(source());
    await within(dialog).findByDisplayValue('Luna');
    fireEvent.keyDown(within(dialog).getByRole('tab', { name: 'Profile' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' })[0]);
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' })[1]);
    expect(onClose).toHaveBeenCalledTimes(4);
    fireEvent.pointerDown(dialog);
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(4);
    const backdrop = dialog.parentElement as HTMLElement;
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(5);
  });

  it('keeps Escape from reaching the session around it', async () => {
    const outer = vi.fn();
    const { onClose, dialog } = open(source(), vi.fn(), (node) => <section onKeyDown={(e) => { if (e.key === 'Escape') outer(); }}>{node}</section>);
    await within(dialog).findByDisplayValue('Luna');
    fireEvent.keyDown(within(dialog).getByRole('tab', { name: 'Profile' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
  });

  it('moves between tabs with the arrow keys', async () => {
    const { dialog } = open(source());
    await within(dialog).findByDisplayValue('Luna');
    fireEvent.keyDown(within(dialog).getByRole('tab', { name: 'Profile' }), { key: 'ArrowRight' });
    await waitFor(() => expect(within(dialog).getByRole('tab', { name: 'Context' }).getAttribute('aria-selected')).toBe('true'));
    expect(document.activeElement).toBe(within(dialog).getByRole('tab', { name: 'Context' }));
  });
});

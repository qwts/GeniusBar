import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeError, type SoulProfile, type SoulProfileFile } from '../bridge';
import { derivedHue } from '../model/dudle';
import { sampleCensus, sampleProfile, sampleProfileFiles } from '../model/fixtures';
import type { CensusRow } from '../model/census';
import { ProfileSourceContext, type ProfileSource } from '../useSoulProfile';
import { CustomizeDialog, type SaveRevision } from './CustomizeDialog';

afterEach(cleanup);

const [luna] = sampleCensus;

function source(overrides: Partial<ProfileSource> = {}): ProfileSource {
  return {
    profile: vi.fn(async (): Promise<SoulProfile> => sampleProfile),
    file: vi.fn(async (agentId: string, path: string): Promise<SoulProfileFile> => ({ agentId, path, size: 1, contents: sampleProfileFiles[path] ?? '' })),
    ...overrides,
  };
}

function open(s: ProfileSource, onClose = vi.fn(), wrap = (node: ReactNode) => node, save?: SaveRevision) {
  render(<ProfileSourceContext.Provider value={s}>{wrap(<CustomizeDialog soul={luna} onClose={onClose} save={save} />)}</ProfileSourceContext.Provider>);
  return { onClose, dialog: screen.getByRole('dialog') };
}

const REVISION = 'sha256:4be1c0ffee5a9d8e7f6a5b4c3d2e1f00112233445566778899aabbccddeeff00';

describe('CustomizeDialog (#64)', () => {
  it('is named by its heading and shows the profile, Save off until something changes', async () => {
    const s = source();
    const { dialog } = open(s);
    expect(await screen.findByRole('dialog', { name: 'Luna' })).toBe(dialog);
    expect(s.profile).toHaveBeenCalledWith(luna.agentId);
    // The harness by its label, as the design's title badge (N3).
    expect(within(dialog).getByText('Claude Code', { selector: 'span' })).toBeTruthy();
    expect(within(dialog).getByRole('tab', { name: 'Profile' }).getAttribute('aria-selected')).toBe('true');
    const name = within(dialog).getByLabelText('Name') as HTMLInputElement;
    expect(name.value).toBe('Luna');
    expect(name.disabled).toBe(false);
    // Editable since agent-bot-identity #535; Luna's census row declares none.
    const role = within(dialog).getByLabelText('Role') as HTMLInputElement;
    expect(role.disabled).toBe(false);
    expect(role.value).toBe('');
    expect(role.maxLength).toBe(60);
    const description = within(dialog).getByLabelText('Description') as HTMLTextAreaElement;
    expect(description.value).toBe(sampleProfile.profile.description);
    expect(description.disabled).toBe(false);
    expect((within(dialog).getByLabelText('Why') as HTMLInputElement).value).toBe('Edited in GeniusBar');
    expect(within(dialog).getByText('/Users/user/Souls/Luna.soul')).toBeTruthy();
    expect(within(dialog).getByText('2026.10.1')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the SOP, skills with source and commit, credential names and status, and the files', async () => {
    const { dialog } = open(source());
    await within(dialog).findByDisplayValue('Luna');
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Context' }));
    expect(within(dialog).getByRole('tab', { name: 'Context' }).getAttribute('aria-selected')).toBe('true');
    const panel = within(dialog).getByRole('tabpanel');
    expect(within(panel).getByText("Files the harness loads into this agent's context.")).toBeTruthy();
    // The design's two panes (C1): the list on the left, the SOP chosen first.
    const list = within(panel).getByRole('list', { name: 'Context' });
    expect(list.className.split(' ')).toEqual(expect.arrayContaining(['w-44', 'border-r', 'bg-muted/40', 'py-1']));
    expect(list.parentElement?.className.split(' ')).toEqual(expect.arrayContaining(['flex', 'h-72', 'rounded-md', 'border']));
    expect(within(list).getByRole('button', { name: 'SOP' }).getAttribute('aria-current')).toBe('true');
    expect(within(list).getByRole('button', { name: 'SOP' }).className).toContain('bg-accent');
    // SOP: resolved with its pinned commit, and the soul's own override.
    expect(within(panel).getByText('qwts/agent-sop', { exact: false }).textContent).toContain('commit 3f9c2a1d7e');
    expect(within(panel).getByText('agent-sop.toml', { exact: false })).toBeTruthy();
    expect(within(panel).getByText('workflows/release.toml')).toBeTruthy();
    // Skills: the SOP's with their commit, the soul's own without one.
    fireEvent.click(within(list).getByRole('button', { name: 'Skills' }));
    expect(within(list).getByRole('button', { name: 'Skills' }).getAttribute('aria-current')).toBe('true');
    expect(within(list).getByRole('button', { name: 'SOP' }).getAttribute('aria-current')).toBeNull();
    const skills = within(panel).getByRole('heading', { name: 'Skills' }).nextElementSibling as HTMLElement;
    const review = within(skills).getByText('review').closest('li') as HTMLElement;
    expect(review.textContent).toContain('SOP');
    expect(review.textContent).toContain('commit 3f9c2a1d7e');
    const triage = within(skills).getByText('triage').closest('li') as HTMLElement;
    expect(triage.textContent).toContain('own');
    expect(triage.textContent).toContain('no commit');
    // Credentials: name, provider and status, nothing else.
    fireEvent.click(within(list).getByRole('button', { name: 'Credentials' }));
    const credentials = within(panel).getByRole('heading', { name: 'Credentials' }).nextElementSibling as HTMLElement;
    expect(credentials.textContent).toBe('luna-geniusbargithubdeclared');
    // Files: text files open; the rest say why not.
    expect(within(panel).getByRole('button', { name: /soul\.md/ })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: /^CLAUDE\.md/ })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: /\.claude\/settings\.json/ })).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: /diagram\.png/ })).toBeNull();
    expect(within(panel).getByText('skills/triage/diagram.png').closest('li')?.textContent).toContain('not text');
    // Every file is in the left pane, in mono.
    expect(within(list).getByRole('button', { name: /^CLAUDE\.md/ }).className).toContain('font-mono');
  });

  it('never shows a credential value, even if agent-bot sent one', async () => {
    const leaky = { ...sampleProfile, credentials: [{ name: 'luna-app', provider: 'github', status: 'declared', value: 'ghs_secretvalue', token: 'ghp_x' }] } as unknown as SoulProfile;
    const { normalizeSoulProfile } = await import('../bridge');
    const s = source({ profile: vi.fn(async () => normalizeSoulProfile(leaky)!) });
    const { dialog } = open(s);
    await within(dialog).findByDisplayValue('Luna');
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Context' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Credentials' }));
    expect(within(dialog).getByText('luna-app')).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/ghs_|ghp_|secret/);
  });

  it('opens a file read-only through soul profile --file in the right pane, and goes back to a section', async () => {
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
    // No back-arrow page: the list stays beside the file, which is marked current.
    expect(within(dialog).queryByRole('button', { name: 'Back to context' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: /^CLAUDE\.md/ }).getAttribute('aria-current')).toBe('true');
    fireEvent.click(within(dialog).getByRole('button', { name: 'SOP' }));
    expect(within(dialog).getByRole('heading', { name: 'SOP' })).toBeTruthy();
    expect(within(dialog).queryByLabelText('CLAUDE.md')).toBeNull();
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

  it('follows the typed name in its title, with the design’s fields and no role placeholder (N13, R2)', async () => {
    const { dialog } = open(source());
    const name = await within(dialog).findByDisplayValue('Luna') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Lunita' } });
    expect(within(dialog).getByRole('heading', { level: 2 }).textContent).toBe('Lunita');
    fireEvent.change(name, { target: { value: '  ' } });
    expect(within(dialog).getByRole('heading', { level: 2 }).textContent).toBe('Luna');
    const role = within(dialog).getByLabelText('Role') as HTMLInputElement;
    expect(role.placeholder).toBe('');
    expect(role.className.split(' ')).toEqual(expect.arrayContaining(['h-9', 'py-1', 'shadow-sm']));
    const description = within(dialog).getByLabelText('Description');
    expect(description.className.split(' ')).toEqual(expect.arrayContaining(['min-h-[60px]', 'py-2', 'shadow-sm']));
  });

  it('closes on Escape, ×, Cancel and a backdrop click, and not on a click inside', async () => {
    const { onClose, dialog } = open(source());
    await within(dialog).findByDisplayValue('Luna');
    fireEvent.keyDown(within(dialog).getByRole('tab', { name: 'Profile' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
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

  it('moves between tabs with the arrow keys, Home and End, with a focus ring (C3)', async () => {
    const { dialog } = open(source());
    await within(dialog).findByDisplayValue('Luna');
    fireEvent.keyDown(within(dialog).getByRole('tab', { name: 'Profile' }), { key: 'ArrowRight' });
    await waitFor(() => expect(within(dialog).getByRole('tab', { name: 'Context' }).getAttribute('aria-selected')).toBe('true'));
    expect(document.activeElement).toBe(within(dialog).getByRole('tab', { name: 'Context' }));
    fireEvent.keyDown(within(dialog).getByRole('tab', { name: 'Context' }), { key: 'Home' });
    expect(within(dialog).getByRole('tab', { name: 'Profile' }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(within(dialog).getByRole('tab', { name: 'Profile' }));
    fireEvent.keyDown(within(dialog).getByRole('tab', { name: 'Profile' }), { key: 'End' });
    expect(document.activeElement).toBe(within(dialog).getByRole('tab', { name: 'Context' }));
    expect(within(dialog).getByRole('tab', { name: 'Context' }).className).toContain('focus-visible:ring-2');
    expect(within(dialog).getByRole('button', { name: 'Close' }).className).toContain('focus-visible:ring-ring');
  });

  it('saves only what changed, as one revision with the reason', async () => {
    const s = source();
    const save = vi.fn<SaveRevision>(async () => ({ revision: REVISION }));
    const { dialog } = open(s, vi.fn(), undefined, save);
    const name = await within(dialog).findByDisplayValue('Luna');
    const button = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    fireEvent.change(name, { target: { value: 'Nova ' } });
    expect(button.disabled).toBe(false);
    // Typing it back is clean again.
    fireEvent.change(name, { target: { value: 'Luna' } });
    expect(button.disabled).toBe(true);
    fireEvent.change(name, { target: { value: 'Nova ' } });
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Context' }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^soul\.md/ }));
    const editor = await within(dialog).findByRole('textbox', { name: 'soul.md' });
    expect((editor as HTMLTextAreaElement).value).toBe(sampleProfileFiles['soul.md']);
    fireEvent.change(editor, { target: { value: '# Nova\n' } });
    expect(within(dialog).getByRole('button', { name: /^soul\.md/ }).textContent).toContain('edited');
    // Another section and back keeps the draft.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Skills' }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^soul\.md/ }));
    expect((within(dialog).getByRole('textbox', { name: 'soul.md' }) as HTMLTextAreaElement).value).toBe('# Nova\n');
    // Opened and left unchanged: not sent.
    fireEvent.click(within(dialog).getByRole('button', { name: /skills\/triage\/SKILL\.md/ }));
    await within(dialog).findByRole('textbox', { name: 'skills/triage/SKILL.md' });
    fireEvent.change(within(dialog).getByLabelText('Why'), { target: { value: ' Renamed to Nova ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith('agent_p', {
      expectedRevision: '2026.10.1',
      reason: 'Renamed to Nova',
      edit: { name: 'Nova', files: { 'soul.md': '# Nova\n' } },
    });
    expect((await within(dialog).findByText('Saved as revision 4be1c0ffee5a.')).getAttribute('role')).toBe('status');
    expect(within(dialog).getByRole('heading', { name: 'Nova' })).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps generated files and harness settings read-only', async () => {
    const { dialog } = open(source(), vi.fn(), undefined, vi.fn<SaveRevision>());
    await within(dialog).findByDisplayValue('Luna');
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Context' }));
    fireEvent.click(within(dialog).getByRole('button', { name: /\.claude\/settings\.json/ }));
    expect((await within(dialog).findByLabelText('.claude/settings.json')).tagName).toBe('PRE');
    expect(within(dialog).queryByRole('textbox', { name: '.claude/settings.json' })).toBeNull();
  });

  it('will not save an empty name or reason', async () => {
    const save = vi.fn<SaveRevision>();
    const { dialog } = open(source(), vi.fn(), undefined, save);
    const description = await within(dialog).findByLabelText('Description');
    fireEvent.change(description, { target: { value: 'Reviews pull requests.' } });
    const button = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.change(within(dialog).getByLabelText('Why'), { target: { value: '  ' } });
    expect(button.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Why'), { target: { value: 'Clearer' } });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: ' ' } });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(save).not.toHaveBeenCalled();
  });

  it('says when the owner did not approve, and keeps the edits', async () => {
    const save = vi.fn<SaveRevision>(async () => { throw new BridgeError('owner-credential-required', 'owner consent requires an interactive terminal'); });
    const { dialog } = open(source(), vi.fn(), undefined, save);
    fireEvent.change(await within(dialog).findByDisplayValue('Luna'), { target: { value: 'Nova' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Not saved: only you can approve this change, and agent-bot could not confirm it was you (owner consent requires an interactive terminal).');
    expect(within(dialog).queryByRole('button', { name: 'Reload' })).toBeNull();
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('Nova');
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows any other refusal as it came', async () => {
    const save = vi.fn<SaveRevision>(async () => { throw new BridgeError('soul-revision-failed', 'adopt a starting package before editing or proposing'); });
    const { dialog } = open(source(), vi.fn(), undefined, save);
    fireEvent.change(await within(dialog).findByDisplayValue('Luna'), { target: { value: 'Nova' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Not saved: adopt a starting package before editing or proposing');
  });

  it('offers Reload on a stale revision, which reads the profile again and drops the edits', async () => {
    const s = source();
    const save = vi.fn<SaveRevision>(async () => { throw new BridgeError('soul-revision-stale', 'the package changed since the dialog read it'); });
    const { dialog } = open(s, vi.fn(), undefined, save);
    fireEvent.change(await within(dialog).findByDisplayValue('Luna'), { target: { value: 'Nova' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toContain('changed since the dialog opened');
    expect(s.profile).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(s.profile).toHaveBeenCalledTimes(2));
    const fresh = screen.getByRole('dialog');
    expect((await within(fresh).findByLabelText('Name') as HTMLInputElement).value).toBe('Luna');
    expect(within(fresh).queryByRole('alert')).toBeNull();
    expect((within(fresh).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('CustomizeDialog colour (#64)', () => {
  const bodyHue = (dialog: HTMLElement) => dialog.querySelector('[data-part="body"]')?.getAttribute('fill');
  const withHue = (hue: number | null): ProfileSource => source({
    profile: vi.fn(async (): Promise<SoulProfile> => ({ ...sampleProfile, profile: { ...sampleProfile.profile, appearance: hue === null ? null : { hue } } })),
  });

  it('starts at the derived hue with no swatch chosen off the swatches, and previews a swatch live', async () => {
    const { dialog } = open(source());
    await within(dialog).findByDisplayValue('Luna');
    const derived = derivedHue(luna.agentId);
    const range = within(dialog).getByRole('slider', { name: 'Color' }) as HTMLInputElement;
    expect(range.value).toBe(String(derived));
    expect(range.getAttribute('aria-valuetext')).toBe(`${derived}°, the default`);
    const group = within(dialog).getByRole('radiogroup', { name: 'Color' });
    const swatches = within(group).getAllByRole('radio');
    expect(swatches.map((r) => r.getAttribute('aria-label'))).toEqual(['0°', '30°', '60°', '120°', '170°', '210°', '250°', '280°', '320°']);
    expect(within(dialog).queryByRole('button', { name: 'Use the default color' })).toBeNull();
    fireEvent.click(within(group).getByRole('radio', { name: '210°' }));
    expect(within(group).getByRole('radio', { name: '210°' }).getAttribute('aria-checked')).toBe('true');
    expect(within(group).getByRole('radio', { name: '210°' }).className).toContain('ring-2');
    expect(range.value).toBe('210');
    expect(bodyHue(dialog)).toBe('hsl(210 70% 62%)');
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('moves between swatches with the arrow keys, and follows the slider', async () => {
    const { dialog } = open(withHue(210));
    await within(dialog).findByDisplayValue('Luna');
    const group = within(dialog).getByRole('radiogroup', { name: 'Color' });
    const at210 = within(group).getByRole('radio', { name: '210°' });
    expect(at210.getAttribute('aria-checked')).toBe('true');
    expect(at210.tabIndex).toBe(0);
    at210.focus();
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(within(group).getByRole('radio', { name: '250°' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.change(within(dialog).getByRole('slider', { name: 'Color' }), { target: { value: '99' } });
    expect(within(group).queryByRole('radio', { checked: true })).toBeNull();
    // Off the swatches, the first stays reachable by Tab.
    expect(within(group).getByRole('radio', { name: '0°' }).tabIndex).toBe(0);
    expect(bodyHue(dialog)).toBe('hsl(99 70% 62%)');
  });

  it('saves a chosen hue as appearance, and nothing else', async () => {
    const save = vi.fn<SaveRevision>(async () => ({ revision: REVISION }));
    const { dialog } = open(source(), vi.fn(), undefined, save);
    await within(dialog).findByDisplayValue('Luna');
    fireEvent.click(within(dialog).getByRole('radio', { name: '170°' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(save).toHaveBeenCalledWith('agent_p', {
      expectedRevision: '2026.10.1', reason: 'Edited in GeniusBar', edit: { appearance: { hue: 170 }, files: {} },
    });
    await within(dialog).findByText('Saved as revision 4be1c0ffee5a.');
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(bodyHue(dialog)).toBe('hsl(170 70% 62%)');
  });

  it('starts at the declared hue, and clearing it saves appearance as removed', async () => {
    const save = vi.fn<SaveRevision>(async () => ({ revision: REVISION }));
    const { dialog } = open(withHue(30), vi.fn(), undefined, save);
    await within(dialog).findByDisplayValue('Luna');
    expect((within(dialog).getByRole('slider', { name: 'Color' }) as HTMLInputElement).value).toBe('30');
    expect(bodyHue(dialog)).toBe('hsl(30 70% 62%)');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use the default color' }));
    const derived = derivedHue(luna.agentId);
    expect((within(dialog).getByRole('slider', { name: 'Color' }) as HTMLInputElement).value).toBe(String(derived));
    expect(bodyHue(dialog)).toBe(`hsl(${derived} 70% 62%)`);
    expect(within(dialog).queryByRole('button', { name: 'Use the default color' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(save).toHaveBeenCalledWith('agent_p', expect.objectContaining({ edit: { appearance: null, files: {} } }));
  });

  it('leaves appearance out of a save that did not touch the colour, and picking the same hue back is clean', async () => {
    const save = vi.fn<SaveRevision>(async () => ({ revision: REVISION }));
    const { dialog } = open(withHue(210), vi.fn(), undefined, save);
    await within(dialog).findByDisplayValue('Luna');
    const button = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    fireEvent.click(within(dialog).getByRole('radio', { name: '0°' }));
    expect(button.disabled).toBe(false);
    fireEvent.click(within(dialog).getByRole('radio', { name: '210°' }));
    expect(button.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Nova' } });
    fireEvent.click(button);
    const [, request] = save.mock.calls[0];
    expect(request.edit).toEqual({ name: 'Nova', files: {} });
    expect(request.edit).not.toHaveProperty('appearance');
  });

  describe('role (agent-bot-identity #535)', () => {
    const openRow = (soul: CensusRow, save: SaveRevision) => {
      render(<ProfileSourceContext.Provider value={source()}><CustomizeDialog soul={soul} onClose={vi.fn()} save={save} /></ProfileSourceContext.Provider>);
      return screen.getByRole('dialog');
    };

    it('starts at the census row\'s role and saves an edit as role, and nothing else', async () => {
      const save = vi.fn<SaveRevision>(async () => ({ revision: REVISION }));
      const dialog = openRow({ ...luna, role: 'Release captain' }, save);
      await within(dialog).findByDisplayValue('Luna');
      const role = within(dialog).getByLabelText('Role') as HTMLInputElement;
      expect(role.value).toBe('Release captain');
      const button = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
      fireEvent.change(role, { target: { value: 'Release captain ' } });
      expect(button.disabled).toBe(true);
      fireEvent.change(role, { target: { value: ' Reviewer ' } });
      fireEvent.click(button);
      expect(save).toHaveBeenCalledWith('agent_p', {
        expectedRevision: '2026.10.1', reason: 'Edited in GeniusBar', edit: { role: 'Reviewer', files: {} },
      });
      await within(dialog).findByText('Saved as revision 4be1c0ffee5a.');
      // The saved role stays shown before the next population read.
      expect((within(dialog).getByLabelText('Role') as HTMLInputElement).value).toBe('Reviewer');
      expect(button.disabled).toBe(true);
    });

    it('saves a cleared role as empty, which removes it', async () => {
      const save = vi.fn<SaveRevision>(async () => ({ revision: REVISION }));
      const dialog = openRow({ ...luna, role: 'Release captain' }, save);
      await within(dialog).findByDisplayValue('Luna');
      fireEvent.change(within(dialog).getByLabelText('Role'), { target: { value: '' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(save).toHaveBeenCalledWith('agent_p', expect.objectContaining({ edit: { role: '', files: {} } }));
    });

    it('leaves role out of a save that did not touch it', async () => {
      const save = vi.fn<SaveRevision>(async () => ({ revision: REVISION }));
      const dialog = openRow({ ...luna, role: 'Release captain' }, save);
      await within(dialog).findByDisplayValue('Luna');
      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Nova' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      const [, request] = save.mock.calls[0];
      expect(request.edit).not.toHaveProperty('role');
    });
  });
});

describe('CustomizeDialog pass 7 (X3, X8, X13, X20)', () => {
  it('animates the title Dudle with the live state, as the design’s state={c.presence}', async () => {
    render(<ProfileSourceContext.Provider value={source()}><CustomizeDialog soul={luna} onClose={vi.fn()} state="awaiting" /></ProfileSourceContext.Provider>);
    const dialog = await screen.findByRole('dialog', { name: 'Luna' });
    expect(dialog.querySelector('svg.dudle')?.getAttribute('data-state')).toBe('awaiting');
  });

  it('gives the footer 36px ringed buttons and the tabs an offset ring with no hover colour', async () => {
    const { dialog } = open(source());
    await screen.findByRole('dialog', { name: 'Luna' });
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    expect(cancel.className.split(' ')).toEqual(expect.arrayContaining(['h-9', 'outline-none', 'focus-visible:ring-2', 'focus-visible:ring-ring']));
    expect(cancel.className).not.toContain('min-h-8');
    for (const tab of within(dialog).getAllByRole('tab')) {
      expect(tab.className.split(' ')).toEqual(expect.arrayContaining(['ring-offset-background', 'focus-visible:ring-offset-2']));
      expect(tab.className).not.toContain('hover:text-foreground');
    }
  });
});

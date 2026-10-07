import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../lib/i18n';
import { LaunchModal } from './LaunchModal';

afterEach(cleanup);

function renderModal(busy = false) {
  const onClose = vi.fn();
  render(<I18nProvider><LaunchModal onClose={onClose} busy={busy}><input aria-label="Package" /></LaunchModal></I18nProvider>);
  return { onClose, dialog: screen.getByRole('dialog', { name: 'Launch a new companion' }) };
}

describe('LaunchModal Escape (#116)', () => {
  it('rings its close button on keyboard focus (LA9)', () => {
    const { dialog } = renderModal();
    const close = dialog.querySelector('button[aria-label="Close"]')!;
    expect(close.className).toContain('focus-visible:ring-2 focus-visible:ring-ring');
  });

  it('closes on Escape from a focused field, once', () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(screen.getByLabelText('Package'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on Escape after focus left the dialog (the Launch button disabled under it)', () => {
    const { onClose } = renderModal();
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('ignores Escape while a launch is in progress, and other keys always', () => {
    const { onClose, dialog } = renderModal(true);
    fireEvent.keyDown(screen.getByLabelText('Package'), { key: 'Escape' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('LaunchModal title (a11y audit)', () => {
  it('names the dialog by its visible heading through aria-labelledby', () => {
    const { dialog } = renderModal();
    const heading = screen.getByRole('heading', { level: 2, name: 'Launch a new companion' });
    expect(heading.id).not.toBe('');
    expect(dialog.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(dialog.hasAttribute('aria-label')).toBe(false);
  });
});

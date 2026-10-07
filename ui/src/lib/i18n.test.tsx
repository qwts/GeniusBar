import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider, useI18n } from './i18n';

afterEach(() => { cleanup(); localStorage.clear(); });

function Probe() {
  const { t } = useI18n();
  return <p>{t('cancel')}</p>;
}

describe('I18nProvider across windows (#223)', () => {
  it('follows the language another window picked', () => {
    localStorage.setItem('gb.lang', 'en');
    render(<I18nProvider><Probe /></I18nProvider>);
    expect(screen.getByText('Cancel')).toBeTruthy();
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'gb.lang', newValue: 'es' })); });
    expect(screen.getByText('Cancelar')).toBeTruthy();
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'gb.lang', newValue: 'fr' })); });
    expect(screen.getByText('Cancelar')).toBeTruthy();
  });
});

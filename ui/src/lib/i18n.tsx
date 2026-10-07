import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { en, type Catalog, type MessageKey } from '../locales/en';
import { es } from '../locales/es';

export const catalogs: Record<'en' | 'es', Catalog> = { en, es };
export type Lang = keyof typeof catalogs;
export const LANGS: readonly { code: Lang; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
];

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function translate(lang: Lang, key: MessageKey, vars?: Record<string, string | number>): string {
  let text = catalogs[lang][key] ?? en[key];
  if (vars) for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}

const LANG_KEY = 'gb.lang';

// Storage can be missing or throw (private windows, tests); the language
// then follows the system and is not remembered.
function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'en' || saved === 'es') return saved;
  } catch { /* not remembered */ }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('es') ? 'es' : 'en';
}

interface I18n {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: Translate;
}

// Without a provider (component tests) text is English and fixed.
const I18nContext = createContext<I18n>({ lang: 'en', setLang: () => {}, t: (key, vars) => translate('en', key, vars) });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState(initialLang);
  // The language picked in the popup reaches the app's other windows (#223).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === LANG_KEY && (e.newValue === 'en' || e.newValue === 'es')) setLangState(e.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const value = useMemo<I18n>(() => ({
    lang,
    setLang: (next) => {
      setLangState(next);
      try { localStorage.setItem(LANG_KEY, next); } catch { /* not remembered */ }
    },
    t: (key, vars) => translate(lang, key, vars),
  }), [lang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  return useContext(I18nContext);
}

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { DEFAULT_LANG, LANG_STORAGE_KEY, dict, fmt, isLang } from './dict';
import type { Dict, Lang } from './dict';

type I18nValue = {
  lang: Lang;
  /** Dictionary of the active language only (never ship both languages to a screen). */
  t: Dict;
  setLang: (lang: Lang) => void;
  fmt: typeof fmt;
};

const I18nContext = createContext<I18nValue | null>(null);

function readStoredLang(): Lang | null {
  try {
    const v = globalThis.localStorage?.getItem(LANG_STORAGE_KEY);
    return isLang(v) ? v : null;
  } catch {
    return null; // private mode / blocked storage — fall back to default
  }
}

function writeStoredLang(lang: Lang): void {
  try {
    globalThis.localStorage?.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    /* best effort */
  }
}

export function I18nProvider({
  children,
  initialLang,
}: {
  children: ReactNode;
  initialLang?: Lang;
}) {
  const [lang, setLangState] = useState<Lang>(
    () => initialLang ?? readStoredLang() ?? DEFAULT_LANG,
  );

  // Keep <html lang> truthful for screen readers and hyphenation.
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    writeStoredLang(next);
  }, []);

  const value = useMemo<I18nValue>(() => ({ lang, t: dict[lang], setLang, fmt }), [lang, setLang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Throws outside a provider so the mistake surfaces in development. */
export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>');
  return ctx;
}

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Brand } from '@bestie/core';
import {
  DEFAULT_LANG,
  GUEST_LANG_STORAGE_KEY,
  LANG_STORAGE_KEY,
  RTL_LANGS,
  brandedDict,
  fmt,
  isGuestLang,
  isLang,
} from './dict';
import type { Dict, Lang } from './dict';

type I18nValue = {
  lang: Lang;
  /** Dictionary of the active language only (never ship both languages to a screen). */
  t: Dict;
  setLang: (lang: Lang) => void;
  fmt: typeof fmt;
};

const I18nContext = createContext<I18nValue | null>(null);

function readStoredLang(guest: boolean): Lang | null {
  try {
    const v = globalThis.localStorage?.getItem(guest ? GUEST_LANG_STORAGE_KEY : LANG_STORAGE_KEY);
    return (guest ? isGuestLang(v) : isLang(v)) ? (v as Lang) : null;
  } catch {
    return null; // private mode / blocked storage — fall back to default
  }
}

function writeStoredLang(lang: Lang, guest: boolean): void {
  try {
    globalThis.localStorage?.setItem(guest ? GUEST_LANG_STORAGE_KEY : LANG_STORAGE_KEY, lang);
  } catch {
    /* best effort */
  }
}

export function I18nProvider({
  children,
  initialLang,
  brand,
  guest = false,
}: {
  children: ReactNode;
  initialLang?: Lang;
  /** A guest page: six languages, its own stored choice, right-to-left where the language needs it. */
  guest?: boolean;
  /** Admin-chosen product name (BRANDING-KNOWLEDGE). Absent = Bestie POS. */
  brand?: Brand;
}) {
  const [lang, setLangState] = useState<Lang>(
    () => initialLang ?? readStoredLang(guest) ?? DEFAULT_LANG,
  );

  // Keep <html lang> truthful for screen readers and hyphenation.
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = RTL_LANGS.includes(lang) ? 'rtl' : 'ltr';
  }, [lang]);

  const setLang = useCallback(
    (next: Lang) => {
      setLangState(next);
      writeStoredLang(next, guest);
    },
    [guest],
  );

  const nameTh = brand?.nameTh;
  const nameEn = brand?.nameEn;
  const value = useMemo<I18nValue>(
    () => ({ lang, t: brandedDict(lang, { nameTh, nameEn }), setLang, fmt }),
    [lang, setLang, nameTh, nameEn],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Throws outside a provider so the mistake surfaces in development. */
export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>');
  return ctx;
}

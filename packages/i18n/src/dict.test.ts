import { describe, expect, it } from 'vitest';
import {
  AppError,
  LANGS,
  brandedDict,
  dict,
  errorText,
  fmt,
  isErrorKey,
  isLang,
  toErrorCode,
} from './dict';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('dictionary', () => {
  it('has the same keys in every language', () => {
    const keys = Object.keys(dict.th).sort();
    for (const lang of LANGS) expect(Object.keys(dict[lang]).sort()).toEqual(keys);
  });

  it('has no empty strings', () => {
    for (const lang of LANGS) {
      for (const [key, value] of Object.entries(dict[lang])) {
        expect(value.trim(), `${lang}.${key}`).not.toBe('');
      }
    }
  });

  it('uses identical {placeholders} in every language', () => {
    for (const key of Object.keys(dict.th) as (keyof typeof dict.th)[]) {
      expect(placeholders(dict.en[key]), key).toEqual(placeholders(dict.th[key]));
    }
  });

  it('keeps the product name identical in both languages', () => {
    expect(dict.en.appName).toBe(dict.th.appName);
  });
});

describe('fmt', () => {
  it('fills known placeholders and keeps unknown ones', () => {
    expect(fmt('Hi {name}, {x}', { name: 'Bestie' })).toBe('Hi Bestie, {x}');
  });
});

describe('errorText', () => {
  it('maps err_* codes to the language sentence', () => {
    expect(isErrorKey('err_network')).toBe(true);
    expect(errorText('err_network', dict.en)).toBe(dict.en.err_network);
  });

  it('degrades unknown codes to the generic message', () => {
    expect(errorText('err_does_not_exist', dict.th)).toBe(dict.th.err_unknown);
    expect(errorText(undefined, dict.th)).toBe(dict.th.err_unknown);
  });
});

describe('isLang', () => {
  it('accepts only supported languages', () => {
    expect(isLang('th')).toBe(true);
    expect(isLang('en')).toBe(true);
    expect(isLang('fr')).toBe(false);
    expect(isLang(null)).toBe(false);
  });
});

describe('AppError / toErrorCode', () => {
  it('keeps the code of an AppError', () => {
    expect(toErrorCode(new AppError('err_forbidden'))).toBe('err_forbidden');
  });

  it('maps fetch failures to err_network and everything else to err_unknown', () => {
    expect(toErrorCode(new TypeError('Failed to fetch'))).toBe('err_network');
    expect(toErrorCode(new Error('boom'))).toBe('err_unknown');
    expect(toErrorCode('weird')).toBe('err_unknown');
  });
});

describe('brandedDict', () => {
  it('is the plain dictionary when no name is configured', () => {
    expect(brandedDict('en', undefined)).toBe(dict.en);
    expect(brandedDict('th', {})).toBe(dict.th);
  });
  it('swaps the product name in every string of that language only', () => {
    const t = brandedDict('en', { nameEn: 'Island Shop' });
    expect(t.appName).toBe('Island Shop');
    expect(t.logoAlt).toBe('{name} logo'); // placeholders untouched
    expect(brandedDict('th', { nameEn: 'Island Shop' }).appName).toBe(dict.th.appName);
  });
  it('caches per language + name', () => {
    expect(brandedDict('en', { nameEn: 'A' })).toBe(brandedDict('en', { nameEn: 'A' }));
  });
});

describe('module names', () => {
  it('every module in the registry has a name in every language', async () => {
    const { MODULE_IDS } = await import('@bestie/core');
    for (const lang of LANGS) {
      for (const id of MODULE_IDS) {
        expect(
          (dict[lang] as Record<string, string>)[`mod_${id}`],
          `${lang} mod_${id}`,
        ).toBeTruthy();
      }
    }
  });
});

describe('guest languages', () => {
  it('only translate keys that exist, keep every {placeholder}, and fall back to English for the rest', async () => {
    const { guestOverlays } = await import('./guest-langs');
    for (const [l, o] of Object.entries(guestOverlays)) {
      for (const [k, v] of Object.entries(o)) {
        expect(k in dict.th, `${l}.${k}`).toBe(true);
        expect(placeholders(v), `${l}.${k}`).toEqual(
          placeholders((dict.th as Record<string, string>)[k]!),
        );
        expect(v.trim(), `${l}.${k}`).not.toBe('');
      }
      expect(Object.keys(dict[l as 'ru']).sort()).toEqual(Object.keys(dict.th).sort());
    }
    expect(dict.ru.appName).toBe(dict.th.appName);
  });
});

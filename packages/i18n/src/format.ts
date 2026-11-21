import type { Lang } from './dict';

/**
 * Dates are shown in Thai Buddhist-era for Thai and en-GB for English, ALWAYS in Asia/Bangkok
 * (servers run in UTC — I18N-KNOWLEDGE §3.5).
 */
const LOCALE: Record<Lang, string> = {
  th: 'th-TH-u-ca-buddhist',
  en: 'en-GB',
  ru: 'ru-RU',
  he: 'he-IL',
  de: 'de-DE',
  zh: 'zh-CN',
};
const TZ = 'Asia/Bangkok';

const toDate = (v: string | number | Date): Date | null => {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

export function formatDate(lang: Lang, value: string | number | Date): string {
  const d = toDate(value);
  return d
    ? new Intl.DateTimeFormat(LOCALE[lang], {
        timeZone: TZ,
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }).format(d)
    : '';
}

export function formatDateTime(lang: Lang, value: string | number | Date): string {
  const d = toDate(value);
  return d
    ? new Intl.DateTimeFormat(LOCALE[lang], {
        timeZone: TZ,
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(d)
    : '';
}

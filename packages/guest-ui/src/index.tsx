import { I18nProvider, LANG_STORAGE_KEY, isLang } from '@bestie/i18n';
import type { Lang } from '@bestie/i18n';
import { GuestTablePage } from './GuestTablePage';

export { GuestTablePage } from './GuestTablePage';
export { loadGuestTable, placeGuestOrder } from './guestApi';

const TABLE_PATH = /^\/t\/([0-9a-f]{24,64})\/?$/;

/** The token in `/t/<token>`, or null when this URL is not a table QR. */
export function tableTokenFromPath(pathname: string): string | null {
  return TABLE_PATH.exec(pathname)?.[1] ?? null;
}

function startLang(): Lang {
  try {
    const stored = globalThis.localStorage?.getItem(LANG_STORAGE_KEY);
    if (isLang(stored)) return stored;
  } catch {
    /* private mode */
  }
  return globalThis.navigator?.language?.toLowerCase().startsWith('th') ? 'th' : 'en';
}

/** Whole guest screen for a table QR: its own language provider, no sign-in, no shell. */
export function GuestRoot({ token }: { token: string }) {
  return (
    <I18nProvider initialLang={startLang()}>
      <main className="guest-root">
        <GuestTablePage token={token} />
      </main>
    </I18nProvider>
  );
}

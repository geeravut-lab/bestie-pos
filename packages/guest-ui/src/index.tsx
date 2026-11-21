import type { ReactElement } from 'react';
import {
  bookingTokenFromPath,
  islandSlugFromPath,
  karaokeBookingTokenFromPath,
  karaokeTokenFromPath,
  joinSlugFromPath,
  passTokenFromPath,
} from '@bestie/core';
import { GUEST_LANG_STORAGE_KEY, I18nProvider, isGuestLang } from '@bestie/i18n';
import type { Lang } from '@bestie/i18n';
import { BookingPage } from './BookingPage';
import { GuestTablePage } from './GuestTablePage';
import { IslandPage } from './IslandPage';
import { JoinPage } from './JoinPage';
import { KaraokeBookPage } from './KaraokeBookPage';
import { KaraokePage } from './KaraokePage';
import { PassPage } from './PassPage';

export { BookingPage } from './BookingPage';
export { GuestTablePage } from './GuestTablePage';
export { IslandPage } from './IslandPage';
export { JoinPage } from './JoinPage';
export { KaraokeBookPage } from './KaraokeBookPage';
export { KaraokePage } from './KaraokePage';
export { PassPage } from './PassPage';
export { loadGuestTable, placeGuestOrder } from './guestApi';

const TABLE_PATH = /^\/t\/([0-9a-f]{24,64})\/?$/;

/** The token in `/t/<token>`, or null when this URL is not a table QR. */
export function tableTokenFromPath(pathname: string): string | null {
  return TABLE_PATH.exec(pathname)?.[1] ?? null;
}

/** The guest's own choice, else the phone's language when it is one of the six, else English. */
function startLang(): Lang {
  try {
    const stored = globalThis.localStorage?.getItem(GUEST_LANG_STORAGE_KEY);
    if (isGuestLang(stored)) return stored;
  } catch {
    /* private mode */
  }
  const code = globalThis.navigator?.language?.toLowerCase().slice(0, 2) ?? '';
  const mapped = code === 'iw' ? 'he' : code;
  return isGuestLang(mapped) ? mapped : 'en';
}

/** Whole guest screen for a table QR: its own language provider, no sign-in, no shell. */
export function GuestRoot({ token }: { token: string }) {
  return (
    <I18nProvider guest initialLang={startLang()}>
      <main className="guest-root">
        <GuestTablePage token={token} />
      </main>
    </I18nProvider>
  );
}

/** Whole guest screen for a shop's booking link (`/book/<token>`). */
export function BookingRoot({ token }: { token: string }) {
  return (
    <I18nProvider guest initialLang={startLang()}>
      <main className="guest-root">
        <BookingPage token={token} />
      </main>
    </I18nProvider>
  );
}

/** Whole guest screen for a Tourist Pass (`/pass/<token>`). */
export function PassRoot({ token }: { token: string }) {
  return (
    <I18nProvider guest initialLang={startLang()}>
      <main className="guest-root">
        <PassPage token={token} />
      </main>
    </I18nProvider>
  );
}

/** Whole guest screen to get a Tourist Pass (`/join/<network>`). */
export function JoinRoot({ slug }: { slug: string }) {
  return (
    <I18nProvider guest initialLang={startLang()}>
      <main className="guest-root">
        <JoinPage slug={slug} />
      </main>
    </I18nProvider>
  );
}

/** Whole guest screen for a karaoke room's QR (`/r/<token>`). */
export function KaraokeRoot({ token }: { token: string }) {
  return (
    <I18nProvider guest initialLang={startLang()}>
      <main className="guest-root">
        <KaraokePage token={token} />
      </main>
    </I18nProvider>
  );
}

/** Whole guest screen for a karaoke shop's room booking link (`/kb/<token>`). */
export function KaraokeBookRoot({ token }: { token: string }) {
  return (
    <I18nProvider guest initialLang={startLang()}>
      <main className="guest-root">
        <KaraokeBookPage token={token} />
      </main>
    </I18nProvider>
  );
}

/** Whole guest screen for the island marketplace (`/island/<network>`). */
export function IslandRoot({ slug }: { slug: string }) {
  return (
    <I18nProvider guest initialLang={startLang()}>
      <main className="guest-root">
        <IslandPage slug={slug} />
      </main>
    </I18nProvider>
  );
}

/** The guest screen a URL stands for (table QR, booking link, Tourist Pass, sign-up, island page), or null for the staff app. */
export function guestEntry(pathname: string): ReactElement | null {
  const table = tableTokenFromPath(pathname);
  if (table) return <GuestRoot token={table} />;
  const booking = bookingTokenFromPath(pathname);
  if (booking) return <BookingRoot token={booking} />;
  const pass = passTokenFromPath(pathname);
  if (pass) return <PassRoot token={pass} />;
  const join = joinSlugFromPath(pathname);
  if (join) return <JoinRoot slug={join} />;
  const kbook = karaokeBookingTokenFromPath(pathname);
  if (kbook) return <KaraokeBookRoot token={kbook} />;
  const room = karaokeTokenFromPath(pathname);
  if (room) return <KaraokeRoot token={room} />;
  const island = islandSlugFromPath(pathname);
  if (island) return <IslandRoot slug={island} />;
  return null;
}

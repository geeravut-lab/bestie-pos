import type { ReactNode } from 'react';
import { useI18n } from '@bestie/i18n';

/** The island network the guest app points at until a guest has a link of their own (same default as the LINE "island" answer). */
export const DEFAULT_ISLAND = 'koh-phangan';

type Kind = 'menu' | 'pass' | 'book' | 'pay';
const KINDS: Readonly<Record<string, Kind>> = {
  '/g/menu': 'menu',
  '/g/pass': 'pass',
  '/g/book': 'book',
  '/g/pay': 'pay',
};

const go = (path: string) => globalThis.location.assign(path); // the guest pages are separate screens: a full load, like opening the link

/**
 * The four cards of the guest role. A guest has no account: every real guest screen opens from a link or a QR, so these pages
 * say plainly how to get there and offer the one screen that needs no link (the island page, the Tourist Pass sign-up).
 */
export function GuestHubPage({ kind }: { kind: Kind }) {
  const { t } = useI18n();
  const copy: Record<
    Kind,
    { title: string; body: string; actions: { label: string; path: string }[] }
  > = {
    menu: {
      title: t.ghMenuTitle,
      body: t.ghMenuBody,
      actions: [{ label: t.ghOpenIsland, path: `/island/${DEFAULT_ISLAND}` }],
    },
    pass: {
      title: t.ghPassTitle,
      body: t.ghPassBody,
      actions: [{ label: t.ghGetPass, path: `/join/${DEFAULT_ISLAND}` }],
    },
    book: {
      title: t.ghBookTitle,
      body: t.ghBookBody,
      actions: [{ label: t.ghOpenIsland, path: `/island/${DEFAULT_ISLAND}` }],
    },
    pay: { title: t.ghPayTitle, body: t.ghPayBody, actions: [] },
  };
  const c = copy[kind];
  return (
    <div className="admin-page">
      <h1>{c.title}</h1>
      <p>{c.body}</p>
      <div className="actions">
        {c.actions.map((a) => (
          <button key={a.path} type="button" className="btn btn-primary" onClick={() => go(a.path)}>
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** For `AuthApp guestPages`: the page of a `/g/…` card, or null for anything else. */
export function guestHubPages({
  path,
}: {
  path: string;
  navigate: (path: string) => void;
}): ReactNode | null {
  const kind = KINDS[path];
  return kind ? <GuestHubPage kind={kind} /> : null;
}

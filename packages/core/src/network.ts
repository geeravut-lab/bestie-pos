// Phase 3 — the island network: Tourist Pass, the public island page and the clearing statement. Pure helpers only; the database decides.
import type { LocalizedText } from './types';

export const NETWORK_CATEGORIES = [
  'food',
  'cafe',
  'beauty',
  'spa',
  'stay',
  'shop',
  'tour',
  'other',
] as const;
export type NetworkCategory = (typeof NETWORK_CATEGORIES)[number];

const PASS_PATH = /^\/pass\/([0-9a-f]{32})\/?$/;
const JOIN_PATH = /^\/join\/([a-z0-9][a-z0-9-]{2,39})\/?$/;
const ISLAND_PATH = /^\/island\/([a-z0-9][a-z0-9-]{2,39})\/?$/;
export const passTokenFromPath = (p: string): string | null => PASS_PATH.exec(p)?.[1] ?? null;
export const joinSlugFromPath = (p: string): string | null => JOIN_PATH.exec(p)?.[1] ?? null;
export const islandSlugFromPath = (p: string): string | null => ISLAND_PATH.exec(p)?.[1] ?? null;

export const passLink = (origin: string, token: string): string =>
  `${origin.replace(/\/+$/, '')}/pass/${token}`;
export const joinLink = (origin: string, slug: string): string =>
  `${origin.replace(/\/+$/, '')}/join/${slug}`;
export const islandLink = (origin: string, slug: string): string =>
  `${origin.replace(/\/+$/, '')}/island/${slug}`;

/** The code printed under a pass QR: `BP-` and ten characters (no I, O, 0, 1). The cashier scans or types it. */
const PASS_CODE = /^BP-[A-HJ-NP-Z2-9]{10}$/;
export const normalizePassCode = (text: string): string | null => {
  const c = text.trim().toUpperCase().replace(/\s+/g, '');
  return PASS_CODE.test(c) ? c : null;
};

/** What a cashier's scanner or keyboard gives for a pass: the printed code, or the pass page's address (its QR). Returns what `link_pass` takes. */
export const parsePassScan = (text: string): string | null => {
  const code = normalizePassCode(text);
  if (code) return code;
  const m = /\/pass\/([0-9a-f]{32})\/?(?:[?#].*)?$/i.exec(text.trim());
  return m ? m[1]!.toLowerCase() : null;
};

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const loc = (v: unknown): LocalizedText => {
  const o = obj(v);
  return { th: str(o.th), ...(str(o.en) ? { en: str(o.en) } : {}) };
};

export type IslandShop = {
  category: NetworkCategory;
  title: LocalizedText;
  about: { th?: string; en?: string } | null;
  bookingToken: string | null;
};
export type Island = {
  slug: string;
  name: LocalizedText;
  about: { th?: string; en?: string } | null;
  shops: IslandShop[];
};

const parseShops = (raw: unknown): IslandShop[] =>
  (Array.isArray(raw) ? raw : []).flatMap((r): IslandShop[] => {
    const o = obj(r);
    const cat = (NETWORK_CATEGORIES as readonly string[]).includes(str(o.category))
      ? (str(o.category) as NetworkCategory)
      : 'other';
    const title = loc(o.title);
    if (title.th === '') return [];
    const about =
      o.about && typeof o.about === 'object'
        ? { th: str(obj(o.about).th) || undefined, en: str(obj(o.about).en) || undefined }
        : null;
    return [
      {
        category: cat,
        title,
        about,
        bookingToken: /^[0-9a-f]{32}$/.test(str(o.booking_token)) ? str(o.booking_token) : null,
      },
    ];
  });

export function parseIsland(raw: unknown): Island | null {
  const o = obj(raw);
  const n = obj(o.network);
  if (str(n.slug) === '') return null;
  const about =
    n.about && typeof n.about === 'object'
      ? { th: str(obj(n.about).th) || undefined, en: str(obj(n.about).en) || undefined }
      : null;
  return { slug: str(n.slug), name: loc(n.name), about, shops: parseShops(o.shops) };
}

export type PassActivity = { kind: string; points: number; at: string; shop: string };
export type Pass = {
  name: string;
  code: string;
  network: { slug: string; name: LocalizedText };
  points: number;
  activity: PassActivity[];
  shops: IslandShop[];
};

export function parsePass(raw: unknown): Pass | null {
  const o = obj(raw);
  const code = normalizePassCode(str(o.code));
  if (!code) return null;
  const n = obj(o.network);
  return {
    name: str(o.name),
    code,
    network: { slug: str(n.slug), name: loc(n.name) },
    points: num(o.points),
    activity: (Array.isArray(o.activity) ? o.activity : []).map((a) => {
      const x = obj(a);
      return { kind: str(x.kind), points: num(x.points), at: str(x.at), shop: str(x.shop) };
    }),
    shops: parseShops(o.shops),
  };
}

export type ClearingLine = { issuer: string; redeemer: string; points: number; amount: number };

/** What this business is owed / owes: lines where it is the issuer (owed to it) or the redeemer (it owes). */
export function clearingTotals(
  lines: readonly (ClearingLine & { issuerOrg?: string; redeemerOrg?: string })[],
  org: string,
): { owedToMe: number; iOwe: number } {
  let owedToMe = 0;
  let iOwe = 0;
  for (const l of lines) {
    if (l.issuerOrg === org) owedToMe += l.amount;
    else if (l.redeemerOrg === org) iOwe += l.amount;
  }
  return { owedToMe, iOwe };
}

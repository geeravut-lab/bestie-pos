import { localizedName, parseLocalizedText } from './menuAdmin';
import type { LocalizedText } from './types';
import type { Satang } from './money';
import { parseFood } from './dietary';
import type { ItemFood } from './dietary';

/** What the guest page shows: the table's menu (prices already the dine-in prices, computed by the server). */
export type GuestMenu = {
  categories: { id: string; name: LocalizedText }[];
  items: {
    id: string;
    categoryId: string;
    name: LocalizedText;
    price: Satang;
    groupIds: string[];
    /** Version of the dish's picture (null = no picture); with the item id it makes the picture's address. */
    imageV: number | null;
    /** What the shop says about the dish (tags, spice, verified). Nothing guessed. */
    food: ItemFood;
  }[];
  groups: {
    id: string;
    name: LocalizedText;
    min: number;
    max: number;
    options: { id: string; name: LocalizedText; delta: Satang }[];
  }[];
};

export type GuestBill = {
  orderId: string | null;
  lines: { name: LocalizedText; quantity: number; status: string; amount: Satang }[];
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const int = (v: unknown, d = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : d;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function parseGuestMenu(raw: unknown): GuestMenu {
  const r = obj(raw);
  return {
    categories: arr(r.categories).map((c) => ({ id: str(c.id), name: parseLocalizedText(c.name) })),
    items: arr(r.items).map((i) => ({
      id: str(i.id),
      categoryId: str(i.category_id),
      name: parseLocalizedText(i.name),
      price: int(i.price),
      groupIds: Array.isArray(i.group_ids) ? i.group_ids.filter((g) => typeof g === 'string') : [],
      imageV: typeof i.image_v === 'number' && i.image_v > 0 ? i.image_v : null,
      food: parseFood({
        tags: i.tags,
        spice_level: i.spice_level,
        dietary_verified: i.verified,
        highlight: i.highlight,
      }),
    })),
    groups: arr(r.groups).map((g) => ({
      id: str(g.id),
      name: parseLocalizedText(g.name),
      min: int(g.min),
      max: int(g.max, 1),
      options: arr(g.options).map((o) => ({
        id: str(o.id),
        name: parseLocalizedText(o.name),
        delta: int(o.delta),
      })),
    })),
  };
}

export function parseGuestBill(raw: unknown): GuestBill {
  const r = obj(raw);
  return {
    orderId: typeof r.order_id === 'string' ? r.order_id : null,
    lines: arr(r.lines).map((l) => ({
      name: parseLocalizedText(l.name),
      quantity: int(l.quantity),
      status: str(l.status),
      amount: int(l.amount),
    })),
  };
}

export type GuestItem = GuestMenu['items'][number];
export type GuestGroup = GuestMenu['groups'][number];

/** The option groups of one item, in the order the owner arranged them. */
export const groupsOf = (menu: GuestMenu, item: GuestItem): GuestGroup[] =>
  item.groupIds
    .map((id) => menu.groups.find((g) => g.id === id))
    .filter((g): g is GuestGroup => !!g);

export type GuestSelectionProblem = { groupId: string; kind: 'min' | 'max' };

/** First rule of an option group the picks break (the server checks the same rules again). */
export function guestSelectionProblem(
  groups: readonly GuestGroup[],
  picked: readonly string[],
): GuestSelectionProblem | null {
  for (const g of groups) {
    const n = g.options.filter((o) => picked.includes(o.id)).length;
    if (n < g.min) return { groupId: g.id, kind: 'min' };
    if (n > g.max) return { groupId: g.id, kind: 'max' };
  }
  return null;
}

/** One unit of the dish with its picked options. Display only — the server prices the order itself. */
export function unitPrice(
  item: GuestItem,
  groups: readonly GuestGroup[],
  picked: readonly string[],
): Satang {
  const deltas = groups.flatMap((g) =>
    g.options.filter((o) => picked.includes(o.id)).map((o) => o.delta),
  );
  return Math.max(0, item.price + deltas.reduce((a, b) => a + b, 0));
}

export type CartLine = {
  key: string;
  itemId: string;
  quantity: number;
  optionIds: string[];
  note: string;
};

export const GUEST_MAX_LINES = 30;
export const GUEST_MAX_QTY = 99;

/** Adds a line; the same dish with the same options and note just gets a higher quantity. */
export function addToGuestCart(
  cart: readonly CartLine[],
  line: Omit<CartLine, 'key'>,
  key: string,
): CartLine[] {
  const opts = [...line.optionIds].sort();
  const same = cart.find(
    (l) =>
      l.itemId === line.itemId &&
      l.note === line.note &&
      [...l.optionIds].sort().join() === opts.join(),
  );
  if (same)
    return cart.map((l) =>
      l === same ? { ...l, quantity: Math.min(GUEST_MAX_QTY, l.quantity + line.quantity) } : l,
    );
  if (cart.length >= GUEST_MAX_LINES) return [...cart];
  return [...cart, { ...line, optionIds: opts, key }];
}

export function setCartQuantity(
  cart: readonly CartLine[],
  key: string,
  quantity: number,
): CartLine[] {
  if (quantity <= 0) return cart.filter((l) => l.key !== key);
  return cart.map((l) =>
    l.key === key ? { ...l, quantity: Math.min(GUEST_MAX_QTY, Math.floor(quantity)) } : l,
  );
}

export function cartTotal(menu: GuestMenu, cart: readonly CartLine[]): Satang {
  let total = 0;
  for (const l of cart) {
    const item = menu.items.find((i) => i.id === l.itemId);
    if (!item) continue;
    total += unitPrice(item, groupsOf(menu, item), l.optionIds) * l.quantity;
  }
  return total;
}

export const cartCount = (cart: readonly CartLine[]): number =>
  cart.reduce((a, l) => a + l.quantity, 0);

/** The request body. Only ids, quantities, options and a short note leave the phone — never prices. */
export function orderPayload(token: string, clientId: string, cart: readonly CartLine[]) {
  return {
    token,
    clientId,
    lines: cart.map((l) => ({
      item_id: l.itemId,
      quantity: l.quantity,
      option_ids: l.optionIds,
      note: l.note.trim().slice(0, 200),
    })),
  };
}

export type StatusStep = 'received' | 'cooking' | 'ready' | 'served';
/** A guest-facing word for a kitchen status. */
export const statusStep = (status: string): StatusStep =>
  status === 'new'
    ? 'received'
    : status === 'sent'
      ? 'cooking'
      : status === 'ready'
        ? 'ready'
        : 'served';

export const guestName = (n: LocalizedText, lang: string): string =>
  localizedName(n, lang === 'th' ? 'th' : 'en');

// ── remembering the basket on the guest's own phone ─────────────────────────
/** How long an unsent basket is kept on the phone (a meal, not a week). */
export const CART_KEEP_MS = 12 * 3_600_000;

export const packCart = (cart: readonly CartLine[], nowMs: number): string =>
  JSON.stringify({ at: nowMs, lines: cart });

/**
 * The basket the guest left when they closed the page, checked against the menu as it is NOW: dishes that were removed or switched
 * off, options that no longer belong to the dish, impossible quantities and anything older than 12 hours are dropped. Never throws.
 */
export function restoreCart(raw: string | null, menu: GuestMenu, nowMs: number): CartLine[] {
  if (!raw) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  if (!o || typeof o.at !== 'number' || nowMs - o.at > CART_KEEP_MS || nowMs < o.at - 60_000)
    return [];
  const out: CartLine[] = [];
  for (const l of Array.isArray(o.lines) ? o.lines : []) {
    if (!l || typeof l !== 'object') continue;
    const r = l as Record<string, unknown>;
    const item = menu.items.find((i) => i.id === r.itemId);
    const optionIds = Array.isArray(r.optionIds)
      ? r.optionIds.filter((x): x is string => typeof x === 'string')
      : [];
    if (!item || typeof r.key !== 'string') continue;
    const allowed = new Set(groupsOf(menu, item).flatMap((g) => g.options.map((p) => p.id)));
    if (!optionIds.every((id) => allowed.has(id))) continue;
    if (guestSelectionProblem(groupsOf(menu, item), optionIds)) continue;
    const quantity = typeof r.quantity === 'number' ? Math.floor(r.quantity) : 0;
    if (quantity < 1 || quantity > GUEST_MAX_QTY) continue;
    out.push({
      key: r.key,
      itemId: item.id,
      quantity,
      optionIds: [...optionIds].sort(),
      note: typeof r.note === 'string' ? r.note.slice(0, 200) : '',
    });
    if (out.length === GUEST_MAX_LINES) break;
  }
  return out;
}

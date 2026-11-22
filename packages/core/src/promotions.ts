// Promotions: shop data (`promotions`) applied by the till to the lines that are NOT sent yet. A promotion lowers the unit price of those lines and keeps the price before it (`listPrice`)
// and the promotion's id, so the discount can be reported; a line that was sent is history and never changes. The margin guard runs when the owner saves a promotion (database).
import { bangkokDate } from './bangkokDate';
import type { OrderDoc } from './orders';

export type Promotion = {
  id: string;
  name: string;
  code: string | null;
  kind: 'percent' | 'amount';
  /** percent: basis points; amount: satang. */
  value: number;
  scope: 'bill' | 'item';
  itemIds: string[];
  minSubtotal: number;
  channels: string[];
  weekdays: number[];
  fromTime: string | null;
  toTime: string | null;
  startsOn: string | null;
  endsOn: string | null;
  minMarginBps: number;
  active: boolean;
};

const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const n = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0;
const arr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export function parsePromotions(v: unknown): Promotion[] {
  if (!Array.isArray(v)) return [];
  const out: Promotion[] = [];
  for (const x of v) {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    if (!s(o.id) || !s(o.name) || (o.kind !== 'percent' && o.kind !== 'amount')) continue;
    out.push({
      id: String(o.id),
      name: String(o.name),
      code: s(o.code),
      kind: o.kind,
      value: n(o.value),
      scope: o.scope === 'item' ? 'item' : 'bill',
      itemIds: arr(o.item_ids),
      minSubtotal: n(o.min_subtotal),
      channels: arr(o.channels),
      weekdays: (Array.isArray(o.weekdays) ? o.weekdays : [])
        .map(n)
        .filter((d) => d >= 1 && d <= 7),
      fromTime: s(o.from_time)?.slice(0, 5) ?? null,
      toTime: s(o.to_time)?.slice(0, 5) ?? null,
      startsOn: s(o.starts_on),
      endsOn: s(o.ends_on),
      minMarginBps: n(o.min_margin_bps),
      active: o.active !== false,
    });
  }
  return out;
}

/** The Bangkok clock of an instant: ISO weekday (1 = Monday) and minutes since midnight. */
export function bangkokClock(ms: number): { date: string; weekday: number; minutes: number } {
  const d = new Date(ms + 7 * 3_600_000);
  return {
    date: bangkokDate(ms),
    weekday: d.getUTCDay() === 0 ? 7 : d.getUTCDay(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}
const toMin = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Is the promotion in force now, on this channel? (days, hours, dates, switch) */
export function promoRunsNow(p: Promotion, ctx: { now: number; channel: string }): boolean {
  if (!p.active) return false;
  const c = bangkokClock(ctx.now);
  if (p.startsOn && c.date < p.startsOn) return false;
  if (p.endsOn && c.date > p.endsOn) return false;
  if (p.weekdays.length > 0 && !p.weekdays.includes(c.weekday)) return false;
  if (p.channels.length > 0 && !p.channels.includes(ctx.channel)) return false;
  if (p.fromTime && p.toTime) {
    const a = toMin(p.fromTime);
    const b = toMin(p.toTime);
    const inWindow = a <= b ? c.minutes >= a && c.minutes < b : c.minutes >= a || c.minutes < b; // a window that crosses midnight
    if (!inWindow) return false;
  }
  return true;
}

const liveLines = (o: OrderDoc) => o.lines.filter((l) => l.status !== 'void');
const listOf = (l: { unitPrice: number; listPrice?: number | null }): number =>
  l.listPrice ?? l.unitPrice;

/** Back to the full prices (only lines that carry a promotion and are not sent). */
export function clearPromotion(o: OrderDoc): OrderDoc {
  return {
    ...o,
    lines: o.lines.map((l) =>
      l.status === 'new' && l.promoId
        ? { ...l, unitPrice: listOf(l), listPrice: null, promoId: null }
        : l,
    ),
  };
}

export type PromoResult =
  | { order: OrderDoc; given: number }
  | { error: 'not_running' | 'min_subtotal' | 'nothing_to_discount' };

/** Apply one promotion to the unsent lines (any promotion already on them is taken off first). `given` is what the customer saves, in satang. */
export function applyPromotion(order: OrderDoc, p: Promotion, ctx: { now: number }): PromoResult {
  if (!promoRunsNow(p, { now: ctx.now, channel: order.channel })) return { error: 'not_running' };
  const base = clearPromotion(order);
  const subtotal = liveLines(base).reduce((a, l) => a + listOf(l) * l.quantity, 0);
  if (subtotal < p.minSubtotal) return { error: 'min_subtotal' };
  const eligible = base.lines.filter(
    (l) =>
      l.status === 'new' &&
      (p.scope === 'bill' || (l.itemId !== null && p.itemIds.includes(l.itemId))),
  );
  if (eligible.length === 0) return { error: 'nothing_to_discount' };
  const eligibleTotal = eligible.reduce((a, l) => a + l.unitPrice * l.quantity, 0);
  let left = p.kind === 'amount' && p.scope === 'bill' ? Math.min(p.value, eligibleTotal) : 0;
  const ids = new Set(eligible.map((l) => l.id));
  let given = 0;
  const lastId = eligible[eligible.length - 1]!.id;
  const lines = base.lines.map((l) => {
    if (!ids.has(l.id)) return l;
    const list = l.unitPrice;
    let off: number; // per unit
    if (p.kind === 'percent') off = list - Math.round((list * (10000 - p.value)) / 10000);
    else if (p.scope === 'item') off = Math.min(p.value, list);
    else {
      const total = list * l.quantity;
      const share =
        l.id === lastId ? left : Math.min(left, Math.floor((p.value * total) / eligibleTotal));
      left -= share;
      off = Math.floor(share / l.quantity);
    }
    off = Math.max(0, Math.min(off, list));
    given += off * l.quantity;
    return off === 0 ? l : { ...l, unitPrice: list - off, listPrice: list, promoId: p.id };
  });
  if (given === 0) return { error: 'nothing_to_discount' };
  return { order: { ...base, lines }, given };
}

/** The promotions the till may offer on this bill now: running, and (for a code promotion) only with its code typed. */
export function offerablePromotions(
  all: readonly Promotion[],
  order: OrderDoc,
  ctx: { now: number; code?: string },
): Promotion[] {
  const code = ctx.code?.trim().toUpperCase() || null;
  return all.filter(
    (p) =>
      promoRunsNow(p, { now: ctx.now, channel: order.channel }) &&
      (p.code === null || p.code === code),
  );
}

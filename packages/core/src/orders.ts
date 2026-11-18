/**
 * Orders — the pure rules (no React, no I/O). An order is ONE document (`OrderDoc`) on the tablet: screens change it with
 * the functions below, then `diffOrder(before, after)` says which writes the server needs (they go into the outbox).
 * Money is integer satang; sent lines are history; nothing here knows what "paid" means (that is the payment function).
 */
import { computeBill } from './tax';
import type { BillBreakdown, BillOptions, PriceMode } from './tax';
import { validateSelection } from './menu';
import { MoneyError } from './money';
import type { Satang } from './money';
import type { OutboxOp } from './outbox';
import type { Channel, ChannelPrices, LocalizedText, OrderStatus } from './types';
import type { ReceiptDoc } from './payments';
import { receiptFromRows } from './receiptRows';

export type LineStatus = 'new' | 'sent' | 'ready' | 'served' | 'void';
export type LineModifier = { id: string; name: LocalizedText; priceDelta: Satang };

export type LineDoc = {
  id: string;
  itemId: string | null;
  /** Snapshot: menu edits never rewrite an old bill. */
  name: LocalizedText;
  /** Per unit, already including the chosen options. */
  unitPrice: Satang;
  quantity: number;
  modifiers: LineModifier[];
  note: string | null;
  station: 'kitchen' | 'bar' | null;
  status: LineStatus;
  seat: number | null;
  voidReason: string | null;
  sentAt: string | null;
  createdBy: string | null;
};

export type OrderDoc = {
  id: string;
  orgId: string;
  storeId: string;
  number: string;
  businessDate: string; // YYYY-MM-DD, Asia/Bangkok
  channel: Channel;
  status: OrderStatus;
  tableId: string | null;
  covers: number | null;
  note: string | null;
  openedBy: string | null;
  deviceId: string | null;
  createdAt: string;
  closedAt: string | null;
  lines: LineDoc[];
  /** Present once the bill is paid. */
  receipt?: ReceiptDoc | null;
};

export const MAX_QTY = 99;

export class OrderError extends Error {
  constructor(
    readonly code: 'closed' | 'selection' | 'quantity' | 'not_found' | 'sent_locked',
    message?: string,
  ) {
    super(message ?? code);
  }
}

// ── numbers & dates ─────────────────────────────────────────────────────────
/** Order number = device code + running number for the business day: A001, A002 … B001 (devices never collide). */
export const formatOrderNumber = (deviceCode: string, seq: number): string =>
  `${deviceCode}${String(seq).padStart(3, '0')}`;

/** Business date in Bangkok, whatever the tablet's own clock zone is. */
export const bangkokDate = (ms: number): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));

// ── building an order ───────────────────────────────────────────────────────
export function newOrder(p: {
  id: string;
  orgId: string;
  storeId: string;
  number: string;
  channel: Channel;
  tableId?: string | null;
  covers?: number | null;
  openedBy?: string | null;
  deviceId?: string | null;
  now: number;
}): OrderDoc {
  return {
    id: p.id,
    orgId: p.orgId,
    storeId: p.storeId,
    number: p.number,
    businessDate: bangkokDate(p.now),
    channel: p.channel,
    status: 'open',
    tableId: p.tableId ?? null,
    covers: p.covers ?? null,
    note: null,
    openedBy: p.openedBy ?? null,
    deviceId: p.deviceId ?? null,
    createdAt: new Date(p.now).toISOString(),
    closedAt: null,
    lines: [],
  };
}

export type OrderItemInput = {
  id: string;
  name: LocalizedText;
  prices: ChannelPrices;
  station: 'kitchen' | 'bar' | null;
};
export type OrderGroupInput = {
  id: string;
  /** Shown on the picking sheet; the order itself only keeps the chosen options. */
  name?: LocalizedText;
  min: number;
  max: number;
  options: readonly {
    id: string;
    name: LocalizedText;
    priceDelta: Satang;
    channelDelta?: Partial<Record<Channel, Satang>>;
  }[];
};

const isOpen = (o: OrderDoc) => o.status !== 'paid' && o.status !== 'void';
const assertOpen = (o: OrderDoc) => {
  if (!isOpen(o)) throw new OrderError('closed');
};
const live = (o: OrderDoc) => o.lines.filter((l) => l.status !== 'void');
const sameMods = (a: readonly LineModifier[], b: readonly LineModifier[]) =>
  a.length === b.length &&
  [...a]
    .map((m) => m.id)
    .sort()
    .join() ===
    [...b]
      .map((m) => m.id)
      .sort()
      .join();

/**
 * Add what the guest asked for. The options must satisfy every group's min / max; the unit price is the channel price
 * plus the chosen options' price changes (never below zero). An identical unsent line just gets a higher quantity.
 */
export function addLine(
  o: OrderDoc,
  p: {
    lineId: string;
    item: OrderItemInput;
    groups: readonly OrderGroupInput[];
    selected: readonly string[];
    quantity: number;
    note?: string | null;
    seat?: number | null;
    staffId?: string | null;
  },
): OrderDoc {
  assertOpen(o);
  if (!Number.isInteger(p.quantity) || p.quantity < 1 || p.quantity > MAX_QTY)
    throw new OrderError('quantity');
  if (validateSelection(p.groups, p.selected).length > 0) throw new OrderError('selection');

  const chosen = p.groups.flatMap((g) => g.options).filter((opt) => p.selected.includes(opt.id));
  const base = p.item.prices[o.channel] ?? p.item.prices.base;
  const modifiers: LineModifier[] = chosen.map((m) => ({
    id: m.id,
    name: m.name,
    priceDelta: m.channelDelta?.[o.channel] ?? m.priceDelta,
  }));
  const unitPrice = base + modifiers.reduce((a, m) => a + m.priceDelta, 0);
  if (unitPrice < 0) throw new MoneyError('line price cannot be negative');
  const note = p.note?.trim() ? p.note.trim().slice(0, 200) : null;

  const same = o.lines.find(
    (l) =>
      l.status === 'new' &&
      l.itemId === p.item.id &&
      l.note === note &&
      l.seat === (p.seat ?? null) &&
      l.unitPrice === unitPrice &&
      sameMods(l.modifiers, modifiers),
  );
  if (same) {
    const quantity = Math.min(MAX_QTY, same.quantity + p.quantity);
    return { ...o, lines: o.lines.map((l) => (l.id === same.id ? { ...l, quantity } : l)) };
  }
  const line: LineDoc = {
    id: p.lineId,
    itemId: p.item.id,
    name: p.item.name,
    unitPrice,
    quantity: p.quantity,
    modifiers,
    note,
    station: p.item.station,
    status: 'new',
    seat: p.seat ?? null,
    voidReason: null,
    sentAt: null,
    createdBy: p.staffId ?? null,
  };
  return { ...o, lines: [...o.lines, line] };
}

const lineOf = (o: OrderDoc, id: string): LineDoc => {
  const l = o.lines.find((x) => x.id === id);
  if (!l) throw new OrderError('not_found');
  return l;
};

/** Quantity of a line that has NOT been sent. 0 removes it. Sent lines are history (void them instead). */
export function setQuantity(o: OrderDoc, lineId: string, quantity: number): OrderDoc {
  assertOpen(o);
  const l = lineOf(o, lineId);
  if (l.status !== 'new') throw new OrderError('sent_locked');
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_QTY)
    throw new OrderError('quantity');
  if (quantity === 0) return removeNewLine(o, lineId);
  return { ...o, lines: o.lines.map((x) => (x.id === lineId ? { ...x, quantity } : x)) };
}

export function setNote(o: OrderDoc, lineId: string, note: string): OrderDoc {
  assertOpen(o);
  const l = lineOf(o, lineId);
  if (l.status !== 'new') throw new OrderError('sent_locked');
  const clean = note.trim() ? note.trim().slice(0, 200) : null;
  return { ...o, lines: o.lines.map((x) => (x.id === lineId ? { ...x, note: clean } : x)) };
}

/** Take back a line that was never sent: it stays in the document as `void` (the server row, if any, is closed the same way). */
export function removeNewLine(o: OrderDoc, lineId: string): OrderDoc {
  assertOpen(o);
  const l = lineOf(o, lineId);
  if (l.status !== 'new') throw new OrderError('sent_locked');
  return {
    ...o,
    lines: o.lines.map((x) =>
      x.id === lineId ? { ...x, status: 'void' as const, voidReason: 'removed' } : x,
    ),
  };
}

/** Cancel something already sent. The caller must have checked the person may do this (server checks `order.void` too). */
export function voidSentLine(o: OrderDoc, lineId: string, reason: string): OrderDoc {
  assertOpen(o);
  const l = lineOf(o, lineId);
  if (l.status === 'new') return removeNewLine(o, lineId);
  if (l.status === 'void') return o;
  return {
    ...o,
    lines: o.lines.map((x) =>
      x.id === lineId
        ? { ...x, status: 'void' as const, voidReason: reason.trim().slice(0, 100) || 'void' }
        : x,
    ),
  };
}

/** Everything new goes to the kitchen / bar; returns which lines were sent (for the ticket). */
export function sendNew(o: OrderDoc, now: number): { order: OrderDoc; sent: LineDoc[] } {
  assertOpen(o);
  const at = new Date(now).toISOString();
  const sent: LineDoc[] = [];
  const lines = o.lines.map((l) => {
    if (l.status !== 'new') return l;
    const s: LineDoc = { ...l, status: 'sent', sentAt: at };
    sent.push(s);
    return s;
  });
  return { order: { ...o, lines }, sent };
}

export function moveToTable(o: OrderDoc, tableId: string | null): OrderDoc {
  assertOpen(o);
  return { ...o, tableId };
}
export function setCovers(o: OrderDoc, covers: number | null): OrderDoc {
  assertOpen(o);
  return { ...o, covers: covers === null ? null : Math.min(99, Math.max(1, Math.round(covers))) };
}

// ── totals ──────────────────────────────────────────────────────────────────
export type BillConfig = {
  priceMode: PriceMode;
  vatBps: number;
  serviceChargeBps: number;
  options?: Partial<BillOptions>;
};

/** What the screen shows: the bill as the owner's billing options compute it, over the lines that still count. */
export function orderBill(o: OrderDoc, cfg: BillConfig): BillBreakdown {
  return computeBill({
    lines: live(o).map((l) => ({ unitPrice: l.unitPrice, quantity: l.quantity })),
    priceMode: cfg.priceMode,
    vatBps: cfg.vatBps,
    // a takeaway / delivery bill carries no table service charge unless the shop's service-charge module says so
    serviceChargeBps: cfg.serviceChargeBps,
    options: cfg.options,
  });
}

export const liveLines = live;
export const hasUnsent = (o: OrderDoc): boolean => o.lines.some((l) => l.status === 'new');
export const itemCount = (o: OrderDoc): number => live(o).reduce((a, l) => a + l.quantity, 0);
export const isOrderOpen = isOpen;

// ── database rows ↔ document ────────────────────────────────────────────────
export function orderToRow(o: OrderDoc): Record<string, unknown> {
  return {
    id: o.id,
    org_id: o.orgId,
    store_id: o.storeId,
    number: o.number,
    business_date: o.businessDate,
    channel: o.channel,
    status: o.status,
    table_id: o.tableId,
    covers: o.covers,
    note: o.note,
    opened_by: o.openedBy,
    device_id: o.deviceId,
    created_at: o.createdAt,
  };
}

export function lineToRow(o: OrderDoc, l: LineDoc): Record<string, unknown> {
  return {
    id: l.id,
    org_id: o.orgId,
    store_id: o.storeId,
    order_id: o.id,
    item_id: l.itemId,
    name: l.name,
    unit_price: l.unitPrice,
    quantity: l.quantity,
    modifiers: l.modifiers,
    note: l.note,
    station: l.station,
    status: l.status,
    sent_at: l.sentAt,
    void_reason: l.voidReason,
    seat: l.seat,
    created_by: l.createdBy,
  };
}

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Lenient read of what the server sent; a damaged row is skipped, never allowed to break the till. */
export function rowsToOrder(
  r: Row,
  lineRows: readonly Row[],
  paid?: { receipt: Row | null; payments: readonly Row[] },
): OrderDoc | null {
  const id = str(r.id);
  const orgId = str(r.org_id);
  const storeId = str(r.store_id);
  const number = str(r.number);
  const date = str(r.business_date);
  const channel = str(r.channel);
  if (!id || !orgId || !storeId || !number || !date) return null;
  if (!['dine-in', 'takeaway', 'delivery', 'qr'].includes(channel ?? '')) return null;
  const lines: LineDoc[] = [];
  for (const l of lineRows) {
    const lid = str(l.id);
    const unit = int(l.unit_price);
    const qty = int(l.quantity);
    const name = l.name as LocalizedText | null;
    if (!lid || unit === null || qty === null || !name || typeof name.th !== 'string') continue;
    const status = str(l.status);
    if (!['new', 'sent', 'ready', 'served', 'void'].includes(status ?? '')) continue;
    lines.push({
      id: lid,
      itemId: str(l.item_id),
      name,
      unitPrice: unit,
      quantity: qty,
      modifiers: Array.isArray(l.modifiers) ? (l.modifiers as LineModifier[]) : [],
      note: str(l.note),
      station: l.station === 'kitchen' || l.station === 'bar' ? l.station : null,
      status: status as LineStatus,
      seat: int(l.seat),
      voidReason: str(l.void_reason),
      sentAt: str(l.sent_at),
      createdBy: str(l.created_by),
    });
  }
  lines.sort((a, b) => (a.sentAt ?? '9').localeCompare(b.sentAt ?? '9'));
  const st = str(r.status);
  return {
    id,
    orgId,
    storeId,
    number,
    businessDate: date,
    channel: channel as Channel,
    status: (['open', 'sent', 'ready', 'served', 'paid', 'void'].includes(st ?? '')
      ? st
      : 'open') as OrderStatus,
    tableId: str(r.table_id),
    covers: int(r.covers),
    note: str(r.note),
    openedBy: str(r.opened_by),
    deviceId: str(r.device_id),
    createdAt: str(r.created_at) ?? new Date(0).toISOString(),
    closedAt: str(r.closed_at),
    lines,
    receipt: paid?.receipt ? receiptFromRows(paid.receipt, paid.payments) : null,
  };
}

// ── what must be written to the server ──────────────────────────────────────
/**
 * The server writes that turn `prev` into `next`, in the order they must be applied (order first, then its lines).
 * `prev = null` means the order has never been saved. Sent lines only ever send their status changes (the database
 * freezes the rest), so replaying is safe.
 */
export function diffOrder(prev: OrderDoc | null, next: OrderDoc): OutboxOp[] {
  const ops: OutboxOp[] = [];
  if (!prev) {
    ops.push({ kind: 'insert', table: 'orders', values: orderToRow(next) });
  } else {
    const values: Record<string, unknown> = {};
    if (prev.tableId !== next.tableId) values.table_id = next.tableId;
    if (prev.covers !== next.covers) values.covers = next.covers;
    if (prev.note !== next.note) values.note = next.note;
    // closing is the payment function's job (close_order), never a plain update
    if (prev.status !== next.status && next.status !== 'paid') values.status = next.status;
    if (Object.keys(values).length > 0)
      ops.push({ kind: 'update', table: 'orders', id: next.id, values });
  }
  const before = new Map((prev?.lines ?? []).map((l) => [l.id, l]));
  for (const l of next.lines) {
    const old = before.get(l.id);
    if (!old) {
      ops.push({ kind: 'insert', table: 'order_lines', values: lineToRow(next, l) });
      continue;
    }
    const values: Record<string, unknown> = {};
    if (old.status === 'new') {
      if (old.quantity !== l.quantity) values.quantity = l.quantity;
      if (old.note !== l.note) values.note = l.note;
      if (old.seat !== l.seat) values.seat = l.seat;
    }
    if (old.status !== l.status) values.status = l.status;
    if (old.sentAt !== l.sentAt) values.sent_at = l.sentAt;
    if (old.voidReason !== l.voidReason) values.void_reason = l.voidReason;
    if (Object.keys(values).length > 0)
      ops.push({ kind: 'update', table: 'order_lines', id: l.id, values });
  }
  return ops;
}

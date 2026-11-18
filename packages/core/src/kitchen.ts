/**
 * Kitchen display, waiter pick-up list and the cafe queue board — pure views over the shop's order documents.
 * A ticket is the lines of ONE bill that one station has to cook (or has cooked). Money never appears here.
 */
import { liveLines } from './orders';
import type { LineDoc, OrderDoc } from './orders';
import type { Channel, LocalizedText } from './types';

export type Station = 'kitchen' | 'bar';
export type KitchenStatus = 'sent' | 'ready' | 'served';

export type TicketLine = {
  id: string;
  name: LocalizedText;
  quantity: number;
  options: LocalizedText[];
  note: string | null;
  status: LineDoc['status'];
};

export type AgeLevel = 'ok' | 'warn' | 'late';
export const WARN_MINUTES = 8;
export const LATE_MINUTES = 15;
export const ageLevel = (minutes: number): AgeLevel =>
  minutes >= LATE_MINUTES ? 'late' : minutes >= WARN_MINUTES ? 'warn' : 'ok';

export type Ticket = {
  /** orderId + which half: "<id>:new" (to cook) or "<id>:ready" (cooked, waiting for service). */
  id: string;
  orderId: string;
  number: string;
  tableId: string | null;
  channel: Channel;
  state: 'new' | 'ready';
  /** When the oldest of its lines was sent to the kitchen. */
  sentAt: string;
  ageMinutes: number;
  age: AgeLevel;
  lines: TicketLine[];
};

const toLine = (l: LineDoc): TicketLine => ({
  id: l.id,
  name: l.name,
  quantity: l.quantity,
  options: l.modifiers.map((m) => m.name),
  note: l.note,
  status: l.status,
});

/** A station screen shows its own lines; a screen with no station (expo) shows every line that HAS a station. */
const forStation = (l: LineDoc, station: Station | null): boolean =>
  l.station !== null && (station === null || l.station === station);

const minutesSince = (iso: string | null, now: number): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : Math.max(0, Math.floor((now - t) / 60_000));
};

export function kitchenTickets(
  orders: readonly OrderDoc[],
  station: Station | null,
  now: number,
): { incoming: Ticket[]; ready: Ticket[] } {
  const incoming: Ticket[] = [];
  const ready: Ticket[] = [];
  for (const o of orders) {
    if (o.status === 'void') continue;
    const mine = liveLines(o).filter((l) => forStation(l, station));
    for (const [state, status] of [
      ['new', 'sent'],
      ['ready', 'ready'],
    ] as const) {
      const lines = mine.filter((l) => l.status === status);
      if (lines.length === 0) continue;
      const sentAt = lines.map((l) => l.sentAt ?? o.createdAt).sort()[0]!;
      const ageMinutes = minutesSince(sentAt, now);
      (state === 'new' ? incoming : ready).push({
        id: `${o.id}:${state}`,
        orderId: o.id,
        number: o.number,
        tableId: o.tableId,
        channel: o.channel,
        state,
        sentAt,
        ageMinutes,
        age: state === 'new' ? ageLevel(ageMinutes) : 'ok',
        lines: lines.map(toLine),
      });
    }
  }
  const byAge = (a: Ticket, b: Ticket) =>
    a.sentAt.localeCompare(b.sentAt) || a.number.localeCompare(b.number);
  return { incoming: incoming.sort(byAge), ready: ready.sort(byAge) };
}

/** What a waiter has to carry out: ready lines per bill (every station), oldest first. */
export function pickupList(orders: readonly OrderDoc[], now: number): Ticket[] {
  return kitchenTickets(orders, null, now).ready;
}

// ── cafe queue board ────────────────────────────────────────────────────────
export type QueueEntry = { orderId: string; number: string; sentAt: string };

/**
 * Counter / takeaway bills only (a table is called by the waiter). `preparing` = something is still being made,
 * `ready` = everything made is ready and not yet handed over. Handed over (served) or never sent = not on the board.
 */
export function queueBoard(orders: readonly OrderDoc[]): {
  preparing: QueueEntry[];
  ready: QueueEntry[];
} {
  const preparing: QueueEntry[] = [];
  const ready: QueueEntry[] = [];
  for (const o of orders) {
    if (o.status === 'void' || o.channel === 'dine-in') continue;
    const lines = liveLines(o).filter((l) => l.station !== null && l.status !== 'new');
    if (lines.length === 0) continue;
    const entry = {
      orderId: o.id,
      number: o.number,
      sentAt: lines.map((l) => l.sentAt ?? o.createdAt).sort()[0]!,
    };
    if (lines.some((l) => l.status === 'sent')) preparing.push(entry);
    else if (lines.some((l) => l.status === 'ready')) ready.push(entry);
  }
  const bySent = (a: QueueEntry, b: QueueEntry) =>
    a.sentAt.localeCompare(b.sentAt) || a.number.localeCompare(b.number);
  return { preparing: preparing.sort(bySent), ready: ready.sort(bySent) };
}

// ── changing status ─────────────────────────────────────────────────────────
const RANK: Record<KitchenStatus, number> = { sent: 1, ready: 2, served: 3 };

/** Forward any distance, or ONE step back (the undo for a mis-tap). Lines never sent, or cancelled, are left alone. */
const canMove = (from: LineDoc['status'], to: KitchenStatus): boolean =>
  (from === 'sent' || from === 'ready' || from === 'served') &&
  from !== to &&
  RANK[from] - RANK[to] <= 1;

/** The documents after the given lines move to `status` (only lines that may move do). */
export function setLinesStatus(
  orders: readonly OrderDoc[],
  lineIds: readonly string[],
  status: KitchenStatus,
): OrderDoc[] {
  const ids = new Set(lineIds);
  const out: OrderDoc[] = [];
  for (const o of orders) {
    let changed = false;
    const lines = o.lines.map((l) => {
      if (!ids.has(l.id) || !canMove(l.status, status)) return l;
      changed = true;
      return { ...l, status };
    });
    if (changed) out.push({ ...o, lines });
  }
  return out;
}

/** The `set_lines_status` call. */
export const statusPayload = (lineIds: readonly string[], status: KitchenStatus) => ({
  p: { line_ids: [...lineIds], status },
});

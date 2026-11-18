/**
 * Splitting and merging bills — pure. A split moves lines (or part of a line's quantity) from one open bill to a NEW bill on the
 * same table; a merge moves every line of one bill into another and closes the empty one. Each resulting bill is paid on its own
 * (its own receipt). The server does the same move atomically (`move_order_lines`); `movePayload` is exactly what it is sent.
 */
import { OrderError, liveLines, newOrder } from './orders';
import type { LineDoc, OrderDoc } from './orders';

export type SplitPick = { lineId: string; qty: number };
/** One move as the server function takes it; `new_line_id` is present only when part of a line's quantity moves. */
export type LineMove = { line_id: string; qty: number; new_line_id?: string };

const isOpen = (o: OrderDoc) => o.status !== 'paid' && o.status !== 'void';

/** Which seats the lines of this bill are assigned to (1, 2, 3 …), for "split by seat". */
export const seatsOf = (o: OrderDoc): number[] =>
  [...new Set(liveLines(o).flatMap((l) => (l.seat === null ? [] : [l.seat])))].sort(
    (a, b) => a - b,
  );

/** Say who a line is for (any time, even after it was sent: it changes nothing in the kitchen). */
export function setSeat(o: OrderDoc, lineId: string, seat: number | null): OrderDoc {
  if (!isOpen(o)) throw new OrderError('closed');
  if (seat !== null && (!Number.isInteger(seat) || seat < 1 || seat > 30))
    throw new OrderError('quantity');
  if (!o.lines.some((l) => l.id === lineId && l.status !== 'void'))
    throw new OrderError('not_found');
  return { ...o, lines: o.lines.map((l) => (l.id === lineId ? { ...l, seat } : l)) };
}

/** Every live line of one seat, whole. */
export const picksForSeat = (o: OrderDoc, seat: number): SplitPick[] =>
  liveLines(o)
    .filter((l) => l.seat === seat)
    .map((l) => ({ lineId: l.id, qty: l.quantity }));

/**
 * Take the picked lines (or part of a line's quantity) out of `source` into a new bill on the same table.
 * At least one live line must stay on the source: a split that empties it is a different thing (pay it, or merge).
 */
export function splitOrder(
  source: OrderDoc,
  picks: readonly SplitPick[],
  p: {
    newOrderId: string;
    newNumber: string;
    newLineId: () => string;
    openedBy: string | null;
    deviceId: string | null;
    now: number;
  },
): { source: OrderDoc; target: OrderDoc; moves: LineMove[] } {
  if (!isOpen(source)) throw new OrderError('closed');
  const chosen = picks.filter((x) => x.qty > 0);
  if (chosen.length === 0) throw new OrderError('split');
  const seen = new Set<string>();
  const moved: LineDoc[] = [];
  const moves: LineMove[] = [];
  let lines = source.lines;
  for (const pick of chosen) {
    if (seen.has(pick.lineId)) throw new OrderError('split');
    seen.add(pick.lineId);
    const l = lines.find((x) => x.id === pick.lineId && x.status !== 'void');
    if (!l) throw new OrderError('not_found');
    if (!Number.isInteger(pick.qty) || pick.qty < 1 || pick.qty > l.quantity)
      throw new OrderError('quantity');
    if (pick.qty === l.quantity) {
      moved.push(l);
      moves.push({ line_id: l.id, qty: l.quantity });
      lines = lines.filter((x) => x.id !== l.id);
    } else {
      const id = p.newLineId();
      moved.push({ ...l, id, quantity: pick.qty });
      moves.push({ line_id: l.id, qty: pick.qty, new_line_id: id });
      lines = lines.map((x) => (x.id === l.id ? { ...x, quantity: x.quantity - pick.qty } : x));
    }
  }
  if (!lines.some((l) => l.status !== 'void')) throw new OrderError('split');
  const target: OrderDoc = {
    ...newOrder({
      id: p.newOrderId,
      orgId: source.orgId,
      storeId: source.storeId,
      number: p.newNumber,
      channel: source.channel,
      tableId: source.tableId,
      openedBy: p.openedBy,
      deviceId: p.deviceId,
      now: p.now,
    }),
    lines: moved,
  };
  return { source: { ...source, lines }, target, moves };
}

/** Put every live line of `source` onto `target`; the source is left empty and closed as void ("merged"). */
export function mergeOrders(
  source: OrderDoc,
  target: OrderDoc,
): { source: OrderDoc; target: OrderDoc; moves: LineMove[] } {
  if (!isOpen(source) || !isOpen(target)) throw new OrderError('closed');
  if (source.id === target.id || source.storeId !== target.storeId) throw new OrderError('split');
  const live = liveLines(source);
  if (live.length === 0) throw new OrderError('split');
  return {
    source: {
      ...source,
      lines: source.lines.filter((l) => l.status === 'void'),
      status: 'void',
      note: `merged into ${target.number}`,
    },
    target: { ...target, lines: [...target.lines, ...live] },
    moves: live.map((l) => ({ line_id: l.id, qty: l.quantity })),
  };
}

/** The `move_order_lines` call for a split (new bill empty on the server until this runs) or a merge. */
export const movePayload = (
  fromId: string,
  toId: string,
  moves: readonly LineMove[],
  voidSourceIfEmpty = false,
) => ({
  p: { from_order: fromId, to_order: toId, moves, void_source_if_empty: voidSourceIfEmpty },
});

import { describe, expect, it } from 'vitest';
import { OrderError, addLine, diffOrder, liveLines, newOrder, orderBill, sendNew } from './orders';
import type { OrderDoc } from './orders';
import { mergeOrders, movePayload, picksForSeat, seatsOf, setSeat, splitOrder } from './split';

const NOW = Date.UTC(2026, 10, 18, 5);
const item = (id: string, price: number) => ({
  id,
  name: { th: id },
  prices: { base: price },
  station: null,
});
const bill = (): OrderDoc => {
  let o = newOrder({
    id: 'A',
    orgId: 'org',
    storeId: 'st',
    number: 'A001',
    channel: 'dine-in',
    tableId: 't1',
    openedBy: 'st1',
    now: NOW,
  });
  o = addLine(o, {
    lineId: 'beer',
    item: item('beer', 6000),
    groups: [],
    selected: [],
    quantity: 3,
  });
  o = sendNew(o, NOW).order;
  o = addLine(o, {
    lineId: 'noodles',
    item: item('noodles', 8000),
    groups: [],
    selected: [],
    quantity: 1,
  });
  o = addLine(o, { lineId: 'tea', item: item('tea', 3000), groups: [], selected: [], quantity: 2 });
  return o;
};
const ids = (() => {
  let n = 0;
  return () => `new-line-${++n}`;
})();
const split = (o: OrderDoc, picks: { lineId: string; qty: number }[]) =>
  splitOrder(o, picks, {
    newOrderId: 'B',
    newNumber: 'A002',
    newLineId: ids,
    openedBy: 'st1',
    deviceId: 'dev',
    now: NOW,
  });
const total = (o: OrderDoc) =>
  orderBill(o, { priceMode: 'inclusive', vatBps: 0, serviceChargeBps: 0 }).total;

describe('splitOrder', () => {
  it('moves whole lines and part of a line; the new bill is on the same table and channel', () => {
    const o = bill();
    const r = split(o, [
      { lineId: 'beer', qty: 2 },
      { lineId: 'noodles', qty: 1 },
    ]);
    expect(r.target).toMatchObject({
      id: 'B',
      number: 'A002',
      tableId: 't1',
      channel: 'dine-in',
      status: 'open',
      deviceId: 'dev',
    });
    expect(r.source.lines.find((l) => l.id === 'beer')!.quantity).toBe(1);
    expect(r.source.lines.some((l) => l.id === 'noodles')).toBe(false);
    const movedBeer = r.target.lines.find((l) => l.itemId === 'beer')!;
    expect(movedBeer).toMatchObject({ quantity: 2, unitPrice: 6000, status: 'sent' });
    expect(movedBeer.id).not.toBe('beer'); // a new line id for the split-off part
    expect(r.target.lines.find((l) => l.id === 'noodles')).toBeTruthy(); // a whole line keeps its id
    expect(r.moves).toEqual([
      { line_id: 'beer', qty: 2, new_line_id: movedBeer.id },
      { line_id: 'noodles', qty: 1 },
    ]);
  });

  it('never changes the money: the two bills add up to the original', () => {
    const o = bill();
    const r = split(o, [
      { lineId: 'beer', qty: 1 },
      { lineId: 'tea', qty: 1 },
    ]);
    expect(total(r.source) + total(r.target)).toBe(total(o));
  });

  it('a sent line keeps its sent state and time on the new bill', () => {
    const o = bill();
    const r = split(o, [{ lineId: 'beer', qty: 1 }]);
    const l = r.target.lines[0]!;
    expect(l.status).toBe('sent');
    expect(l.sentAt).toBe(o.lines[0]!.sentAt);
  });

  it('refuses an empty pick, a repeated line, too many, an unknown line and a split that would empty the bill', () => {
    const o = bill();
    expect(() => split(o, [])).toThrow(OrderError);
    expect(() => split(o, [{ lineId: 'beer', qty: 0 }])).toThrow(OrderError);
    expect(() =>
      split(o, [
        { lineId: 'beer', qty: 1 },
        { lineId: 'beer', qty: 1 },
      ]),
    ).toThrow(OrderError);
    expect(() => split(o, [{ lineId: 'beer', qty: 4 }])).toThrow(/quantity/);
    expect(() => split(o, [{ lineId: 'ghost', qty: 1 }])).toThrow(/not_found/);
    expect(() =>
      split(o, [
        { lineId: 'beer', qty: 3 },
        { lineId: 'noodles', qty: 1 },
        { lineId: 'tea', qty: 2 },
      ]),
    ).toThrow(/split/);
    expect(() => split({ ...o, status: 'paid' }, [{ lineId: 'tea', qty: 1 }])).toThrow(/closed/);
  });

  it('a voided line cannot be moved', () => {
    const o = bill();
    const voided = {
      ...o,
      lines: o.lines.map((l) => (l.id === 'tea' ? { ...l, status: 'void' as const } : l)),
    };
    expect(() => split(voided, [{ lineId: 'tea', qty: 1 }])).toThrow(/not_found/);
  });
});

describe('seats', () => {
  it('assign a seat to any live line (even a sent one) and split a whole seat off', () => {
    let o = bill();
    o = setSeat(setSeat(setSeat(o, 'beer', 1), 'noodles', 2), 'tea', 2);
    expect(seatsOf(o)).toEqual([1, 2]);
    expect(picksForSeat(o, 2)).toEqual([
      { lineId: 'noodles', qty: 1 },
      { lineId: 'tea', qty: 2 },
    ]);
    const r = split(o, picksForSeat(o, 2));
    expect(liveLines(r.source).map((l) => l.id)).toEqual(['beer']);
    expect(r.target.lines.every((l) => l.seat === 2)).toBe(true);
  });
  it('a seat change is a small update, also for a sent line', () => {
    const o = bill();
    const n = setSeat(o, 'beer', 3);
    expect(diffOrder(o, n)).toEqual([
      { kind: 'update', table: 'order_lines', id: 'beer', values: { seat: 3 } },
    ]);
    expect(() => setSeat(o, 'beer', 0)).toThrow(OrderError);
    expect(() => setSeat(o, 'ghost', 1)).toThrow(OrderError);
    expect(setSeat(n, 'beer', null).lines[0]!.seat).toBeNull();
  });
});

describe('mergeOrders', () => {
  it('everything on the source goes to the target; the source is closed as void', () => {
    const a = bill();
    const b = addLine(
      newOrder({
        id: 'B',
        orgId: 'org',
        storeId: 'st',
        number: 'A002',
        channel: 'dine-in',
        tableId: 't2',
        now: NOW,
      }),
      {
        lineId: 'coffee',
        item: item('coffee', 5000),
        groups: [],
        selected: [],
        quantity: 1,
      },
    );
    const r = mergeOrders(a, b);
    expect(r.target.lines.map((l) => l.id)).toEqual(['coffee', 'beer', 'noodles', 'tea']);
    expect(r.source).toMatchObject({ status: 'void', note: 'merged into A002' });
    expect(liveLines(r.source)).toHaveLength(0);
    expect(r.moves).toEqual([
      { line_id: 'beer', qty: 3 },
      { line_id: 'noodles', qty: 1 },
      { line_id: 'tea', qty: 2 },
    ]);
    expect(total(r.target)).toBe(total(a) + total(b));
  });
  it('refuses closed bills, the same bill, another shop and an empty source', () => {
    const a = bill();
    const b = newOrder({
      id: 'B',
      orgId: 'org',
      storeId: 'st',
      number: 'A002',
      channel: 'dine-in',
      now: NOW,
    });
    expect(() => mergeOrders({ ...a, status: 'paid' }, b)).toThrow(/closed/);
    expect(() => mergeOrders(a, a)).toThrow(OrderError);
    expect(() => mergeOrders(a, { ...b, storeId: 'other' })).toThrow(OrderError);
    expect(() => mergeOrders(b, a)).toThrow(OrderError);
  });
});

describe('movePayload', () => {
  it('is exactly what the server function takes', () => {
    expect(movePayload('A', 'B', [{ line_id: 'x', qty: 1 }], true)).toEqual({
      p: {
        from_order: 'A',
        to_order: 'B',
        moves: [{ line_id: 'x', qty: 1 }],
        void_source_if_empty: true,
      },
    });
  });
});

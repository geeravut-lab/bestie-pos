import { describe, expect, it } from 'vitest';
import {
  OrderError,
  addLine,
  bangkokDate,
  diffOrder,
  formatOrderNumber,
  hasUnsent,
  itemCount,
  liveLines,
  moveToTable,
  newOrder,
  orderBill,
  removeNewLine,
  rowsToOrder,
  lineToRow,
  orderToRow,
  sendNew,
  setNote,
  setQuantity,
  voidSentLine,
} from './orders';
import type { OrderDoc, OrderGroupInput, OrderItemInput } from './orders';

const padThai: OrderItemInput = {
  id: 'i1',
  name: { th: 'ผัดไทย', en: 'Pad Thai' },
  prices: { base: 8000, delivery: 9500 },
  station: 'kitchen',
};
const spice: OrderGroupInput = {
  id: 'g1',
  min: 1,
  max: 1,
  options: [
    { id: 'mild', name: { th: 'เผ็ดน้อย' }, priceDelta: 0 },
    { id: 'egg', name: { th: 'ไข่' }, priceDelta: 1000, channelDelta: { delivery: 1500 } },
  ],
};
const empty = () =>
  newOrder({
    id: 'o1',
    orgId: 'org',
    storeId: 'st',
    number: 'A001',
    channel: 'dine-in',
    tableId: 't1',
    now: Date.UTC(2026, 10, 18, 20, 0),
  });
const add = (o: OrderDoc, id: string, selected: string[], quantity = 1, note?: string) =>
  addLine(o, { lineId: id, item: padThai, groups: [spice], selected, quantity, note });

describe('numbers and dates', () => {
  it('order numbers carry the device code', () => {
    expect(formatOrderNumber('A', 1)).toBe('A001');
    expect(formatOrderNumber('B', 42)).toBe('B042');
    expect(formatOrderNumber('AA', 1234)).toBe('AA1234');
  });
  it('the business date is the Bangkok date, not the tablet zone', () => {
    // 20:00 UTC on 18 Nov = 03:00 on 19 Nov in Bangkok
    expect(bangkokDate(Date.UTC(2026, 10, 18, 20, 0))).toBe('2026-11-19');
    expect(bangkokDate(Date.UTC(2026, 10, 18, 16, 59))).toBe('2026-11-18');
    expect(empty().businessDate).toBe('2026-11-19');
  });
});

describe('addLine', () => {
  it('prices the line from the channel price plus the chosen options', () => {
    const o = add(empty(), 'l1', ['egg'], 2);
    expect(o.lines[0]).toMatchObject({
      unitPrice: 9000,
      quantity: 2,
      status: 'new',
      station: 'kitchen',
    });
    expect(o.lines[0]!.modifiers).toEqual([{ id: 'egg', name: { th: 'ไข่' }, priceDelta: 1000 }]);
  });
  it("uses the delivery price and the option's own delivery price on a delivery order", () => {
    const d = { ...empty(), channel: 'delivery' as const };
    expect(add(d, 'l1', ['egg']).lines[0]!.unitPrice).toBe(9500 + 1500);
  });
  it('refuses a selection that breaks min / max and quantities out of range', () => {
    expect(() => add(empty(), 'l1', [])).toThrow(OrderError); // required group not chosen
    expect(() => add(empty(), 'l1', ['mild', 'egg'])).toThrow(OrderError); // too many
    expect(() => add(empty(), 'l1', ['nope'])).toThrow(OrderError); // unknown option
    expect(() => add(empty(), 'l1', ['mild'], 0)).toThrow(OrderError);
    expect(() => add(empty(), 'l1', ['mild'], 100)).toThrow(OrderError);
  });
  it('an identical unsent line only gets a higher quantity; a different note or option is a new line', () => {
    let o = add(empty(), 'l1', ['mild'], 1);
    o = add(o, 'l2', ['mild'], 2);
    expect(o.lines).toHaveLength(1);
    expect(o.lines[0]!.quantity).toBe(3);
    o = add(o, 'l3', ['mild'], 1, 'no peanuts');
    o = add(o, 'l4', ['egg'], 1);
    expect(o.lines).toHaveLength(3);
  });
  it('does not merge into a line that was already sent', () => {
    let o = add(empty(), 'l1', ['mild']);
    o = sendNew(o, 1).order;
    o = add(o, 'l2', ['mild']);
    expect(o.lines).toHaveLength(2);
  });
  it('a closed order accepts nothing', () => {
    expect(() => add({ ...empty(), status: 'paid' }, 'l1', ['mild'])).toThrow(/closed/);
  });
  it('never lets a price go below zero', () => {
    const cheap: OrderItemInput = { ...padThai, prices: { base: 500 } };
    const neg: OrderGroupInput = {
      id: 'g',
      min: 0,
      max: 1,
      options: [{ id: 'x', name: { th: 'ลด' }, priceDelta: -900 }],
    };
    expect(() =>
      addLine(empty(), { lineId: 'l', item: cheap, groups: [neg], selected: ['x'], quantity: 1 }),
    ).toThrow();
  });
});

describe('editing before and after sending', () => {
  it('quantity and note change only while the line is unsent; 0 removes it', () => {
    let o = add(empty(), 'l1', ['mild'], 2);
    o = setQuantity(o, 'l1', 5);
    o = setNote(o, 'l1', '  extra lime ');
    expect(o.lines[0]).toMatchObject({ quantity: 5, note: 'extra lime' });
    o = setQuantity(o, 'l1', 0);
    expect(liveLines(o)).toHaveLength(0);
    expect(o.lines[0]!.status).toBe('void'); // kept as a void row so the server copy can be closed too
  });
  it('a sent line is history', () => {
    let o = add(empty(), 'l1', ['mild']);
    o = sendNew(o, Date.UTC(2026, 10, 18, 20, 5)).order;
    expect(() => setQuantity(o, 'l1', 2)).toThrow(/sent_locked/);
    expect(() => setNote(o, 'l1', 'x')).toThrow(/sent_locked/);
    expect(() => removeNewLine(o, 'l1')).toThrow(/sent_locked/);
  });
  it('sendNew sends only new lines, once', () => {
    let o = add(empty(), 'l1', ['mild']);
    const first = sendNew(o, 1);
    expect(first.sent).toHaveLength(1);
    expect(first.order.lines[0]!.sentAt).toBeTruthy();
    o = add(first.order, 'l2', ['egg']);
    expect(hasUnsent(o)).toBe(true);
    const second = sendNew(o, 2);
    expect(second.sent.map((l) => l.id)).toEqual(['l2']);
    expect(hasUnsent(second.order)).toBe(false);
  });
  it('voiding a sent line keeps the row with a reason; voiding an unsent one just removes it', () => {
    let o = add(empty(), 'l1', ['mild']);
    o = sendNew(o, 1).order;
    o = add(o, 'l2', ['egg']);
    o = voidSentLine(o, 'l1', ' guest left ');
    o = voidSentLine(o, 'l2', 'changed mind');
    expect(o.lines.map((l) => [l.status, l.voidReason])).toEqual([
      ['void', 'guest left'],
      ['void', 'removed'],
    ]);
    expect(itemCount(o)).toBe(0);
  });
  it('moving a table', () => {
    expect(moveToTable(empty(), 't2').tableId).toBe('t2');
  });
});

describe('orderBill', () => {
  it("computes the bill with the shop's billing options over the lines that still count", () => {
    let o = add(empty(), 'l1', ['mild'], 2); // 160.00
    o = add(o, 'l2', ['egg'], 1); // 90.00
    o = removeNewLine(add(o, 'l3', ['egg'], 1, 'x'), 'l3');
    const bill = orderBill(o, { priceMode: 'inclusive', vatBps: 700, serviceChargeBps: 1000 });
    expect(bill.subtotal).toBe(25000);
    expect(bill.serviceCharge).toBe(2500);
    expect(bill.total).toBe(27500);
  });
  it('a Points discount (reserved by the server) lowers the bill before service charge and VAT', () => {
    const o = { ...add(empty(), 'l1', ['mild'], 2), pointsUsed: 30, pointsDiscount: 3000 }; // 160.00 − 30.00
    const bill = orderBill(o, { priceMode: 'inclusive', vatBps: 700, serviceChargeBps: 1000 });
    expect(bill.pointsDiscount).toBe(3000);
    expect(bill.discountedSubtotal).toBe(13000);
    expect(bill.serviceCharge).toBe(1300);
    expect(bill.total).toBe(14300);
  });
  it('the discount can never exceed what is left on the bill (lines were removed)', () => {
    const o = { ...add(empty(), 'l1', ['mild'], 1), pointsUsed: 500, pointsDiscount: 50000 };
    const bill = orderBill(o, { priceMode: 'inclusive', vatBps: 0, serviceChargeBps: 0 });
    expect(bill.pointsDiscount).toBe(8000);
    expect(bill.total).toBe(0);
  });
  it('the points columns come from the server and are never written back by the till', () => {
    const o = { ...add(empty(), 'l1', ['mild']), pointsUsed: 10, pointsDiscount: 1000 };
    const row = orderToRow(o);
    expect(row).not.toHaveProperty('points_used');
    expect(row).not.toHaveProperty('points_discount');
    expect(row).not.toHaveProperty('customer_id');
    const back = rowsToOrder(
      { ...orderToRow(o), customer_id: 'c1', points_used: 10, points_discount: 1000 },
      [],
    )!;
    expect(back).toMatchObject({ customerId: 'c1', pointsUsed: 10, pointsDiscount: 1000 });
  });
  it('an empty order is zero', () => {
    expect(
      orderBill(empty(), { priceMode: 'inclusive', vatBps: 0, serviceChargeBps: 0 }).total,
    ).toBe(0);
  });
});

describe('diffOrder — what goes to the server', () => {
  it('a brand-new order: the order first, then its lines, in order', () => {
    const o = add(add(empty(), 'l1', ['mild']), 'l2', ['egg']);
    const ops = diffOrder(null, o);
    expect(ops.map((x) => (x.kind === 'insert' ? x.table : '?'))).toEqual([
      'orders',
      'order_lines',
      'order_lines',
    ]);
    const row = (ops[1] as { values: Record<string, unknown> }).values;
    expect(row).toMatchObject({
      order_id: 'o1',
      org_id: 'org',
      store_id: 'st',
      unit_price: 8000,
      status: 'new',
    });
  });
  it('nothing changed = nothing to send', () => {
    const o = add(empty(), 'l1', ['mild']);
    expect(diffOrder(o, o)).toEqual([]);
  });
  it('a quantity change on an unsent line is a small update', () => {
    const a = add(empty(), 'l1', ['mild']);
    const b = setQuantity(a, 'l1', 3);
    expect(diffOrder(a, b)).toEqual([
      { kind: 'update', table: 'order_lines', id: 'l1', values: { quantity: 3 } },
    ]);
  });
  it('sending to the kitchen updates status and time, never price or quantity', () => {
    const a = add(empty(), 'l1', ['mild'], 2);
    const { order: b } = sendNew(a, Date.UTC(2026, 10, 18, 20, 5));
    const ops = diffOrder(a, b);
    expect(ops).toHaveLength(1);
    const v = (ops[0] as { values: Record<string, unknown> }).values;
    expect(Object.keys(v).sort()).toEqual(['sent_at', 'status']);
  });
  it('a void sends status and reason only', () => {
    const a = sendNew(add(empty(), 'l1', ['mild']), 1).order;
    const b = voidSentLine(a, 'l1', 'guest left');
    const v = (diffOrder(a, b)[0] as { values: Record<string, unknown> }).values;
    expect(v).toEqual({ status: 'void', void_reason: 'guest left' });
  });
  it('moving table / covers / note produce an order update', () => {
    const a = empty();
    const b = { ...moveToTable(a, 't9'), covers: 4, note: 'window' };
    expect(diffOrder(a, b)).toEqual([
      {
        kind: 'update',
        table: 'orders',
        id: 'o1',
        values: { table_id: 't9', covers: 4, note: 'window' },
      },
    ]);
  });
});

describe('rows ↔ document', () => {
  it('round-trips through the database shape', () => {
    const o = sendNew(
      add(add(empty(), 'l1', ['mild']), 'l2', ['egg'], 2, 'no ice'),
      Date.UTC(2026, 10, 18, 20, 5),
    ).order;
    const back = rowsToOrder(
      orderToRow(o),
      o.lines.map((l) => lineToRow(o, l)),
    )!;
    const norm = (l: (typeof o.lines)[number]) => ({
      ...l,
      createdBy: null,
      listPrice: l.listPrice ?? null,
      promoId: l.promoId ?? null,
    });
    expect(back.lines.map(norm)).toEqual(o.lines.map(norm));
    expect(back).toMatchObject({
      id: 'o1',
      number: 'A001',
      channel: 'dine-in',
      tableId: 't1',
      status: 'open',
    });
  });
  it('skips damaged rows instead of crashing', () => {
    expect(rowsToOrder({ id: 'x' }, [])).toBeNull();
    const o = add(empty(), 'l1', ['mild']);
    const good = lineToRow(o, o.lines[0]!);
    const back = rowsToOrder(orderToRow(o), [
      good,
      { id: 'bad', unit_price: 'free' },
      { ...good, id: 'l9', status: 'weird' },
    ])!;
    expect(back.lines).toHaveLength(1);
  });
});

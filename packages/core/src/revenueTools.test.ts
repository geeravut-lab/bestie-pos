import { describe, expect, it } from 'vitest';
import { addLine, newOrder, sendNew } from './orders';
import type { OrderDoc } from './orders';
import { classifyMenu, parseProfitReport } from './menuEngineering';
import {
  applyPromotion,
  clearPromotion,
  offerablePromotions,
  parsePromotions,
  promoRunsNow,
} from './promotions';
import type { Promotion } from './promotions';
import { pairConfidence, parsePairStats, parseUpsellRules, suggestUpsells } from './upsell';
import { averageBill, changePct, parseKpi, splitDuration, wasteShareBps } from './kpi';
import { bahtToSatang, mapColumns, parseCsv, parseMenuCsv } from './menuImport';

const item = (id: string, price: number) => ({
  id,
  name: { th: id, en: id },
  prices: { base: price },
  station: null,
});
const bill = (
  lines: [string, number, number][],
  channel: 'dine-in' | 'takeaway' = 'takeaway',
): OrderDoc => {
  let o = newOrder({
    id: 'o1',
    orgId: 'org',
    storeId: 's',
    number: 'A001',
    channel,
    now: Date.now(),
  });
  lines.forEach(([id, price, qty], i) => {
    o = addLine(o, {
      lineId: `l${i}`,
      item: item(id, price),
      groups: [],
      selected: [],
      quantity: qty,
    });
  });
  return o;
};
// Monday 2026-11-23 16:00 Bangkok
const MON_16 = Date.parse('2026-11-23T16:00:00+07:00');
const promo = (over: Partial<Promotion> = {}): Promotion => ({
  id: 'p1',
  name: 'Happy',
  code: null,
  kind: 'percent',
  value: 2000,
  scope: 'bill',
  itemIds: [],
  minSubtotal: 0,
  channels: [],
  weekdays: [],
  fromTime: null,
  toTime: null,
  startsOn: null,
  endsOn: null,
  minMarginBps: 0,
  active: true,
  ...over,
});

describe('menu engineering', () => {
  const rows = parseProfitReport([
    { item_id: 'a', name: { th: 'A' }, qty: 50, revenue: 500000, cost_unit: 4000 }, // price 100, cost 40, margin 60
    { item_id: 'b', name: { th: 'B' }, qty: 40, revenue: 200000, cost_unit: 4500 }, // price 50, cost 45, margin 5
    { item_id: 'c', name: { th: 'C' }, qty: 5, revenue: 100000, cost_unit: 5000 }, // price 200, cost 50, margin 150
    { item_id: 'd', name: { th: 'D' }, qty: 4, revenue: 20000, cost_unit: 4500 }, // price 50, cost 45, margin 5
    { item_id: 'e', name: { th: 'E' }, qty: 10, revenue: 50000, cost_unit: null },
    { bad: true },
  ]);
  it('places every dish in one of the four boxes, and says "unknown" when there is no cost', () => {
    expect(rows).toHaveLength(5);
    const e = classifyMenu(rows);
    const q = Object.fromEntries(e.rows.map((r) => [r.itemId, r.quadrant]));
    expect(q).toEqual({ a: 'star', b: 'plowhorse', c: 'puzzle', d: 'dog', e: 'unknown' });
  });
  it('computes the margin per portion and the share of portions', () => {
    const e = classifyMenu(rows);
    const a = e.rows.find((r) => r.itemId === 'a')!;
    expect(a.unitPrice).toBe(10000);
    expect(a.unitMargin).toBe(6000);
    expect(a.marginBps).toBe(6000);
    expect(a.profit).toBe(300000);
    expect(a.shareBps).toBe(Math.round((50 / 109) * 10000));
    expect(e.costKnownBps).toBe(Math.round((820000 / 870000) * 10000));
  });
  it('an empty report is an empty answer', () => {
    expect(classifyMenu([]).rows).toEqual([]);
  });
});

describe('promotions', () => {
  it('reads the rows of the database and drops damaged ones', () => {
    const ps = parsePromotions([
      {
        id: 'p',
        name: 'X',
        kind: 'percent',
        value: 1000,
        weekdays: [1, 9],
        from_time: '15:00:00',
        to_time: '17:00:00',
        code: 'ABC',
      },
      { id: 'q' },
    ]);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({
      weekdays: [1],
      fromTime: '15:00',
      toTime: '17:00',
      code: 'ABC',
      scope: 'bill',
    });
  });
  it('runs only on its days, hours, dates and channels (Bangkok time)', () => {
    const p = promo({
      weekdays: [1, 2],
      fromTime: '15:00',
      toTime: '17:00',
      startsOn: '2026-11-01',
      endsOn: '2026-12-31',
      channels: ['takeaway'],
    });
    expect(promoRunsNow(p, { now: MON_16, channel: 'takeaway' })).toBe(true);
    expect(promoRunsNow(p, { now: MON_16, channel: 'dine-in' })).toBe(false);
    expect(promoRunsNow(p, { now: MON_16 + 3_600_000, channel: 'takeaway' })).toBe(false); // 17:00 is the end
    expect(
      promoRunsNow(p, { now: Date.parse('2026-11-25T16:00:00+07:00'), channel: 'takeaway' }),
    ).toBe(false); // Wednesday
    expect(promoRunsNow({ ...p, active: false }, { now: MON_16, channel: 'takeaway' })).toBe(false);
    expect(promoRunsNow({ ...p, endsOn: '2026-11-22' }, { now: MON_16, channel: 'takeaway' })).toBe(
      false,
    );
  });
  it('a window that crosses midnight works', () => {
    const p = promo({ fromTime: '22:00', toTime: '02:00' });
    expect(
      promoRunsNow(p, { now: Date.parse('2026-11-23T23:30:00+07:00'), channel: 'takeaway' }),
    ).toBe(true);
    expect(
      promoRunsNow(p, { now: Date.parse('2026-11-24T01:30:00+07:00'), channel: 'takeaway' }),
    ).toBe(true);
    expect(
      promoRunsNow(p, { now: Date.parse('2026-11-24T12:00:00+07:00'), channel: 'takeaway' }),
    ).toBe(false);
  });
  it('percent off the bill lowers the unit price and keeps the list price', () => {
    const r = applyPromotion(
      bill([
        ['a', 10000, 2],
        ['b', 3333, 1],
      ]),
      promo(),
      { now: MON_16 },
    );
    if ('error' in r) throw new Error('should apply');
    expect(r.order.lines.map((l) => [l.unitPrice, l.listPrice, l.promoId])).toEqual([
      [8000, 10000, 'p1'],
      [2666, 3333, 'p1'],
    ]);
    expect(r.given).toBe(2 * 2000 + 667);
  });
  it('an amount off the bill is shared in proportion and never goes below zero', () => {
    const r = applyPromotion(
      bill([
        ['a', 10000, 1],
        ['b', 5000, 1],
      ]),
      promo({ kind: 'amount', value: 3000 }),
      { now: MON_16 },
    );
    if ('error' in r) throw new Error('should apply');
    expect(r.given).toBe(3000);
    expect(r.order.lines.map((l) => l.unitPrice)).toEqual([8000, 4000]);
    const big = applyPromotion(bill([['a', 1000, 1]]), promo({ kind: 'amount', value: 99999 }), {
      now: MON_16,
    });
    if ('error' in big) throw new Error('should apply');
    expect(big.order.lines[0]!.unitPrice).toBe(0);
  });
  it('an item promotion touches only its dishes, an amount per portion', () => {
    const r = applyPromotion(
      bill([
        ['a', 10000, 2],
        ['b', 5000, 1],
      ]),
      promo({ scope: 'item', itemIds: ['a'], kind: 'amount', value: 1500 }),
      { now: MON_16 },
    );
    if ('error' in r) throw new Error('should apply');
    expect(r.order.lines.map((l) => l.unitPrice)).toEqual([8500, 5000]);
    expect(r.given).toBe(3000);
  });
  it('lines already sent are history: they keep their price', () => {
    let o = bill([['a', 10000, 1]]);
    o = sendNew(o, MON_16).order;
    o = addLine(o, { lineId: 'x', item: item('b', 5000), groups: [], selected: [], quantity: 1 });
    const r = applyPromotion(o, promo(), { now: MON_16 });
    if ('error' in r) throw new Error('should apply');
    expect(r.order.lines.map((l) => l.unitPrice)).toEqual([10000, 4000]);
  });
  it('refuses outside its time, under the minimum, or with nothing to discount', () => {
    expect(
      applyPromotion(bill([['a', 10000, 1]]), promo({ weekdays: [3] }), { now: MON_16 }),
    ).toEqual({ error: 'not_running' });
    expect(
      applyPromotion(bill([['a', 10000, 1]]), promo({ minSubtotal: 50000 }), { now: MON_16 }),
    ).toEqual({ error: 'min_subtotal' });
    expect(
      applyPromotion(bill([['a', 10000, 1]]), promo({ scope: 'item', itemIds: ['zzz'] }), {
        now: MON_16,
      }),
    ).toEqual({ error: 'nothing_to_discount' });
  });
  it('changing promotion starts from the full price, and clearing restores it', () => {
    const a = applyPromotion(bill([['a', 10000, 1]]), promo({ value: 2000 }), { now: MON_16 });
    if ('error' in a) throw new Error('x');
    const b = applyPromotion(a.order, promo({ id: 'p2', value: 1000 }), { now: MON_16 });
    if ('error' in b) throw new Error('x');
    expect(b.order.lines[0]).toMatchObject({ unitPrice: 9000, listPrice: 10000, promoId: 'p2' });
    expect(clearPromotion(b.order).lines[0]).toMatchObject({
      unitPrice: 10000,
      listPrice: null,
      promoId: null,
    });
  });
  it('code promotions are offered only with their code', () => {
    const all = [promo({ id: 'a' }), promo({ id: 'b', code: 'VIP' })];
    const o = bill([['a', 10000, 1]]);
    expect(offerablePromotions(all, o, { now: MON_16 }).map((p) => p.id)).toEqual(['a']);
    expect(offerablePromotions(all, o, { now: MON_16, code: ' vip ' }).map((p) => p.id)).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('upsell rules', () => {
  const rules = parseUpsellRules([
    { id: '1', item_id: 'pad', suggest_id: 'tea', sort: 2 },
    { id: '2', item_id: 'soup', suggest_id: 'tea', sort: 1 },
    { id: '3', item_id: 'pad', suggest_id: 'beer', sort: 0 },
    { id: '4', item_id: 'pad', suggest_id: 'cake', sort: 5, active: false },
    { id: '5', item_id: 'pad', suggest_id: 'rice' },
    { nope: 1 },
  ]);
  it('suggests what the bill calls for, most rules first, never what is sold out or already ordered', () => {
    const avail = new Set(['tea', 'beer', 'cake']);
    expect(suggestUpsells(['pad', 'soup'], rules, avail)).toEqual(['tea', 'beer']);
    expect(suggestUpsells(['pad', 'tea'], rules, avail)).toEqual(['beer']);
    expect(suggestUpsells(['pad'], rules, avail, 1)).toEqual(['beer']);
    expect(suggestUpsells(['nothing'], rules, avail)).toEqual([]);
  });
  it('reads pair statistics and gives the confidence', () => {
    const p = parsePairStats([
      { a: 'x', b: 'y', a_name: { th: 'X' }, b_name: { th: 'Y' }, together: 6, a_count: 20 },
      { a: 'x' },
    ]);
    expect(p).toHaveLength(1);
    expect(pairConfidence(p[0]!)).toBe(30);
  });
});

describe('KPI helpers', () => {
  it('reads the report with null for what could not be measured', () => {
    const k = parseKpi({
      bills: 10,
      sales: 250000,
      order_to_kitchen_sec: 95,
      prep_sec: null,
      waste_cost: 5000,
      stockouts: 2,
      noshow_rate_bps: 500,
      repeat_rate_bps: null,
    });
    expect(k).toMatchObject({
      bills: 10,
      orderToKitchenSec: 95,
      prepSec: null,
      noShowRateBps: 500,
      repeatRateBps: null,
    });
    expect(averageBill(k)).toBe(25000);
    expect(wasteShareBps(k)).toBe(200);
    expect(averageBill({ bills: 0, sales: 0 })).toBeNull();
    expect(parseKpi(null).bills).toBe(0);
  });
  it('words nothing itself: durations and changes are plain numbers', () => {
    expect(splitDuration(3725)).toEqual({ h: 1, m: 2, s: 5 });
    expect(changePct(110, 100)).toBe(10);
    expect(changePct(5, 0)).toBeNull();
    expect(changePct(null, 5)).toBeNull();
  });
});

describe('menu import', () => {
  it('reads quotes, doubled quotes, semicolons and a BOM', () => {
    expect(parseCsv('﻿a;b;c\r\n"x;y";"he said ""hi""";3\r\n\r\n')).toEqual([
      ['a', 'b', 'c'],
      ['x;y', 'he said "hi"', '3'],
    ]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
  it('prices: baht with symbols and decimals become satang', () => {
    expect(bahtToSatang('120')).toBe(12000);
    expect(bahtToSatang('฿1,200.50')).toBe(120050);
    expect(bahtToSatang('99 บาท')).toBe(9900);
    expect(bahtToSatang('12.345')).toBeNull();
    expect(bahtToSatang('')).toBeNull();
    expect(bahtToSatang('-5')).toBeNull();
  });
  it('recognises English and Thai headers', () => {
    expect(mapColumns(['Category', 'Item name', 'Price', 'Barcode', 'SKU'])).toEqual({
      category: 0,
      name_th: 1,
      price: 2,
      barcode: 3,
      sku: 4,
    });
    expect(mapColumns(['หมวดหมู่', 'ชื่อสินค้า', 'ราคา'])).toEqual({ category: 0, name_th: 1, price: 2 });
    expect(mapColumns(['name_th', 'name_en', 'price'])).toEqual({
      name_th: 0,
      name_en: 1,
      price: 2,
    });
  });
  it('turns a file into rows and lists what it could not use', () => {
    const csv = [
      'Category,Name,Price,Barcode,SKU',
      'Drinks,Iced tea,35,TEA-0001,T1',
      'Drinks,,40,,',
      'Food,Pad Thai,abc,,',
      'Food,Pad Thai,90.5,,',
      ',Water,10,12,',
    ].join('\n');
    const r = parseMenuCsv(csv);
    expect(r.rows.map((x) => [x.category, x.name_th, x.price, x.barcode, x.sku])).toEqual([
      ['Drinks', 'Iced tea', 3500, 'TEA-0001', 'T1'],
      ['Food', 'Pad Thai', 9050, undefined, undefined],
      ['Imported', 'Water', 1000, undefined, undefined], // barcode "12" is too short and is left out
    ]);
    expect(r.issues).toEqual([
      { line: 3, reason: 'no_name' },
      { line: 4, reason: 'bad_price' },
    ]);
  });
  it('a file without a name and a price column gives nothing', () => {
    expect(parseMenuCsv('foo,bar\n1,2').rows).toEqual([]);
  });
  it('stops at 500 rows', () => {
    const csv = 'name,price\n' + Array.from({ length: 520 }, (_, i) => `Dish ${i},10`).join('\n');
    const r = parseMenuCsv(csv);
    expect(r.rows).toHaveLength(500);
    expect(r.truncated).toBe(true);
  });
});

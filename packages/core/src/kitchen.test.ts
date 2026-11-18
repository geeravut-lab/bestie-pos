import { describe, expect, it } from 'vitest';
import { addLine, newOrder, sendNew } from './orders';
import type { OrderDoc } from './orders';
import {
  ageLevel,
  kitchenTickets,
  pickupList,
  queueBoard,
  setLinesStatus,
  statusPayload,
} from './kitchen';

const T0 = Date.UTC(2026, 10, 18, 5, 0);
const min = (n: number) => T0 + n * 60_000;
const item = (id: string, station: 'kitchen' | 'bar' | null) => ({
  id,
  name: { th: id, en: id },
  prices: { base: 5000 },
  station,
});
const bill = (
  id: string,
  number: string,
  channel: 'dine-in' | 'takeaway',
  lines: [string, 'kitchen' | 'bar' | null, number?][],
  sentAt = T0,
): OrderDoc => {
  let o = newOrder({
    id,
    orgId: 'o',
    storeId: 's',
    number,
    channel,
    tableId: channel === 'dine-in' ? 't1' : null,
    now: T0,
  });
  for (const [name, station, qty] of lines)
    o = addLine(o, {
      lineId: `${id}-${name}`,
      item: item(name, station),
      groups: [],
      selected: [],
      quantity: qty ?? 1,
    });
  return sendNew(o, sentAt).order;
};
const withStatus = (
  o: OrderDoc,
  id: string,
  status: OrderDoc['lines'][number]['status'],
): OrderDoc => ({
  ...o,
  lines: o.lines.map((l) => (l.id === `${o.id}-${id}` ? { ...l, status } : l)),
});

describe('kitchenTickets', () => {
  const a = bill(
    'A',
    'A001',
    'dine-in',
    [
      ['noodles', 'kitchen', 2],
      ['beer', 'bar'],
      ['napkins', null],
    ],
    T0,
  );
  const b = bill('B', 'A002', 'takeaway', [['coffee', 'bar']], min(3));

  it('a station sees only its own lines; lines without a station never reach any screen', () => {
    const k = kitchenTickets([a, b], 'kitchen', min(5));
    expect(k.incoming.map((t) => [t.number, t.lines.map((l) => l.name.th)])).toEqual([
      ['A001', ['noodles']],
    ]);
    const bar = kitchenTickets([a, b], 'bar', min(5));
    expect(bar.incoming.map((t) => [t.number, t.lines.map((l) => l.name.th)])).toEqual([
      ['A001', ['beer']],
      ['A002', ['coffee']],
    ]);
    const expo = kitchenTickets([a, b], null, min(5));
    expect(expo.incoming.flatMap((t) => t.lines.map((l) => l.name.th)).sort()).toEqual([
      'beer',
      'coffee',
      'noodles',
    ]);
  });

  it('oldest first, with age and a warning level that grows', () => {
    const t = kitchenTickets([b, a], 'bar', min(20)).incoming;
    expect(t.map((x) => x.number)).toEqual(['A001', 'A002']);
    expect(t.map((x) => [x.ageMinutes, x.age])).toEqual([
      [20, 'late'],
      [17, 'late'],
    ]);
    expect(kitchenTickets([a], 'kitchen', min(9)).incoming[0]!.age).toBe('warn');
    expect(kitchenTickets([a], 'kitchen', min(2)).incoming[0]!.age).toBe('ok');
    expect([ageLevel(7), ageLevel(8), ageLevel(14), ageLevel(15)]).toEqual([
      'ok',
      'warn',
      'warn',
      'late',
    ]);
  });

  it('ready lines move to the ready list; an order can be in both when more was sent later', () => {
    const half = withStatus(a, 'noodles', 'ready');
    const t = kitchenTickets([half], null, min(4));
    expect(t.incoming.map((x) => x.lines.map((l) => l.name.th))).toEqual([['beer']]);
    expect(t.ready.map((x) => [x.state, x.lines.map((l) => l.name.th)])).toEqual([
      ['ready', ['noodles']],
    ]);
  });

  it('served, cancelled and not-yet-sent lines, and void bills, are not on the screen; quantity, options and notes come along', () => {
    let o = bill('C', 'A003', 'dine-in', [['soup', 'kitchen', 3]]);
    o = {
      ...o,
      lines: o.lines.map((l) => ({
        ...l,
        note: 'no chili',
        modifiers: [{ id: 'm', name: { th: 'ไข่' }, priceDelta: 0 }],
      })),
    };
    const t = kitchenTickets([o], 'kitchen', min(1)).incoming[0]!;
    expect(t.lines[0]).toMatchObject({ quantity: 3, note: 'no chili', options: [{ th: 'ไข่' }] });
    expect(kitchenTickets([withStatus(o, 'soup', 'served')], 'kitchen', min(1))).toEqual({
      incoming: [],
      ready: [],
    });
    expect(kitchenTickets([withStatus(o, 'soup', 'void')], 'kitchen', min(1))).toEqual({
      incoming: [],
      ready: [],
    });
    expect(kitchenTickets([{ ...o, status: 'void' }], 'kitchen', min(1))).toEqual({
      incoming: [],
      ready: [],
    });
    const unsent = addLine(
      newOrder({ id: 'D', orgId: 'o', storeId: 's', number: 'A004', channel: 'dine-in', now: T0 }),
      { lineId: 'x', item: item('x', 'kitchen'), groups: [], selected: [], quantity: 1 },
    );
    expect(kitchenTickets([unsent], 'kitchen', min(1)).incoming).toEqual([]);
  });

  it('the waiter pick-up list is every ready line of every station', () => {
    const o = withStatus(withStatus(a, 'noodles', 'ready'), 'beer', 'ready');
    expect(pickupList([o], min(5)).map((t) => t.lines.map((l) => l.name.th).sort())).toEqual([
      ['beer', 'noodles'],
    ]);
  });
});

describe('queueBoard (cafe)', () => {
  it('counter bills only: preparing while something is being made, ready when everything is, gone once handed over', () => {
    const prep = bill('P', 'A010', 'takeaway', [['latte', 'bar']]);
    const done = withStatus(
      bill('R', 'A011', 'takeaway', [['mocha', 'bar']], min(1)),
      'mocha',
      'ready',
    );
    const mixed = withStatus(
      bill(
        'M',
        'A012',
        'takeaway',
        [
          ['tea', 'bar'],
          ['cake', 'kitchen'],
        ],
        min(2),
      ),
      'tea',
      'ready',
    );
    const handed = withStatus(
      bill('H', 'A013', 'takeaway', [['water', 'bar']], min(3)),
      'water',
      'served',
    );
    const table = bill('T', 'A014', 'dine-in', [['soup', 'kitchen']]);
    const noStation = bill('N', 'A015', 'takeaway', [['bag', null]]);
    const b = queueBoard([prep, done, mixed, handed, table, noStation]);
    expect(b.preparing.map((e) => e.number)).toEqual(['A010', 'A012']);
    expect(b.ready.map((e) => e.number)).toEqual(['A011']);
  });
});

describe('setLinesStatus', () => {
  const a = bill('A', 'A001', 'dine-in', [
    ['x', 'kitchen'],
    ['y', 'bar'],
  ]);
  const ids = a.lines.map((l) => l.id);
  it('moves sent lines forward and returns only the documents that changed', () => {
    const r = setLinesStatus([a, bill('Z', 'A002', 'dine-in', [['q', 'bar']])], [ids[0]!], 'ready');
    expect(r).toHaveLength(1);
    expect(r[0]!.lines.map((l) => l.status)).toEqual(['ready', 'sent']);
  });
  it('allows a one-step undo, refuses a bigger jump back, and leaves unsent / cancelled lines alone', () => {
    const served = setLinesStatus([a], ids, 'served')[0]!;
    expect(setLinesStatus([served], ids, 'ready')[0]!.lines.map((l) => l.status)).toEqual([
      'ready',
      'ready',
    ]);
    expect(setLinesStatus([served], ids, 'sent')).toEqual([]);
    const unsent = { ...a, lines: a.lines.map((l) => ({ ...l, status: 'new' as const })) };
    expect(setLinesStatus([unsent], ids, 'ready')).toEqual([]);
    const voided = { ...a, lines: a.lines.map((l) => ({ ...l, status: 'void' as const })) };
    expect(setLinesStatus([voided], ids, 'ready')).toEqual([]);
  });
  it('the server call carries exactly the ids and status', () => {
    expect(statusPayload(['a', 'b'], 'ready')).toEqual({
      p: { line_ids: ['a', 'b'], status: 'ready' },
    });
  });
});

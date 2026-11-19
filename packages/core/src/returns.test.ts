import { describe, expect, it } from 'vitest';
import { returnableQty, returnAmount, routeAvailable, usableRoutes } from './returns';

const line = (unitPrice: number, quantity: number, returned = 0, now = 0) => ({
  unitPrice,
  quantity,
  returned,
  now,
});

describe('returnAmount', () => {
  it('pays back the share of what the bill took (same numbers as the SQL test)', () => {
    const lines = [line(30000, 2, 0, 1), line(10000, 1)];
    expect(returnAmount({ payable: 70000, lines, refundedBefore: 0 })).toBe(30000);
  });

  it('returning everything refunds exactly what was paid, whatever the rounding', () => {
    // 3 × 33.33 sold for a payable of 100.00 (a discount): partial returns must still add up to 10000
    const first = returnAmount({ payable: 10000, lines: [line(3333, 3, 0, 1)], refundedBefore: 0 });
    const second = returnAmount({
      payable: 10000,
      lines: [line(3333, 3, 1, 1)],
      refundedBefore: first,
    });
    const third = returnAmount({
      payable: 10000,
      lines: [line(3333, 3, 2, 1)],
      refundedBefore: first + second,
    });
    expect(first + second + third).toBe(10000);
  });

  it('service charge, VAT and discounts come back in proportion', () => {
    // 2 lines of 100.00 = 200.00 goods; the bill took 210.00 (10 % service): one line back = 105.00
    expect(returnAmount({ payable: 21000, lines: [line(10000, 2, 0, 1)], refundedBefore: 0 })).toBe(
      10500,
    );
  });

  it('never goes negative and handles a bill of free items', () => {
    expect(returnAmount({ payable: 0, lines: [line(0, 1, 0, 1)], refundedBefore: 0 })).toBe(0);
    expect(returnAmount({ payable: 5000, lines: [line(5000, 1, 0, 0)], refundedBefore: 0 })).toBe(
      0,
    );
  });
});

describe('returnableQty', () => {
  it('is what was sold minus what came back, never below zero', () => {
    expect(returnableQty(3, 1)).toBe(2);
    expect(returnableQty(3, 5)).toBe(0);
  });
});

describe('routes', () => {
  const paid = [
    { tender: 'cash', amount: 50000 },
    { tender: 'promptpay', amount: 20000 },
  ];
  it('a route carries only what that route took', () => {
    expect(routeAvailable('cash', paid, [])).toBe(50000);
    expect(routeAvailable('manual', paid, [])).toBe(20000);
    expect(routeAvailable('credit', paid, [])).toBe(0);
  });
  it('earlier returns on a route use it up', () => {
    expect(routeAvailable('cash', paid, [{ method: 'cash', amount: 30000 }])).toBe(20000);
  });
  it('lists the routes that can carry an amount; Credit only when allowed', () => {
    expect(usableRoutes(25000, paid, [], true)).toEqual(['cash']);
    expect(usableRoutes(10000, paid, [], true)).toEqual(['cash', 'manual']);
    expect(usableRoutes(100, [{ tender: 'credit', amount: 500 }], [], false)).toEqual([]);
    expect(usableRoutes(100, [{ tender: 'credit', amount: 500 }], [], true)).toEqual(['credit']);
  });
});

describe('parseReturnsReport', () => {
  it('reads the server document and survives garbage', async () => {
    const { parseReturnsReport } = await import('./returns');
    expect(parseReturnsReport(null)).toEqual({
      totals: { returns: 0, refunded: 0, units: 0 },
      rows: [],
    });
    const r = parseReturnsReport({
      totals: { returns: 2, refunded: 70000, units: 3 },
      rows: [
        {
          number: 'RT-0001',
          bill: 'A001',
          amount: 30000,
          method: 'cash',
          reason: 'other',
          at: 'x',
        },
      ],
    });
    expect(r.totals.refunded).toBe(70000);
    expect(r.rows[0]?.number).toBe('RT-0001');
  });
});

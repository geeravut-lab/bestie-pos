import { describe, expect, it } from 'vitest';
import { hqRanges, hqSummary, pctChange } from './hq';
import { parseSalesReport } from './reportRead';

const report = (stores: { id: string; bills: number; payable: number }[]) =>
  parseSalesReport({
    totals: {
      bills: stores.reduce((n, s) => n + s.bills, 0),
      payable: stores.reduce((n, s) => n + s.payable, 0),
      average: 0,
    },
    by_store: stores.map((s) => ({
      store_id: s.id,
      name: s.id,
      bills: s.bills,
      payable: s.payable,
    })),
  });
const shops = [
  { id: 'a', name: 'Cafe' },
  { id: 'b', name: 'Spa' },
  { id: 'c', name: 'Kiosk' },
];

describe('hq dashboard', () => {
  it('works out the change in whole percent, half away from zero', () => {
    expect(pctChange(150, 100)).toBe(50);
    expect(pctChange(50, 100)).toBe(-50);
    expect(pctChange(100, 100)).toBe(0);
    expect(pctChange(1005, 1000)).toBe(1); // 0.5 % rounds away from zero
    expect(pctChange(995, 1000)).toBe(-1);
    expect(pctChange(10, 0)).toBeNull();
    expect(pctChange(0, 100)).toBe(-100);
  });
  it('gives one row per shop, including a shop with no sales, biggest first, with shares and change', () => {
    const s = hqSummary(
      shops,
      report([
        { id: 'a', bills: 10, payable: 300000 },
        { id: 'b', bills: 5, payable: 100000 },
      ]),
      report([
        { id: 'a', bills: 8, payable: 200000 },
        { id: 'b', bills: 5, payable: 200000 },
      ]),
    );
    expect(s.rows.map((r) => r.name)).toEqual(['Cafe', 'Spa', 'Kiosk']);
    expect(s.rows[0]).toMatchObject({
      bills: 10,
      payable: 300000,
      average: 30000,
      prevPayable: 200000,
      changePct: 50,
      sharePct: 75,
    });
    expect(s.rows[1]).toMatchObject({ changePct: -50, sharePct: 25 });
    expect(s.rows[2]).toMatchObject({
      bills: 0,
      payable: 0,
      average: 0,
      changePct: null,
      sharePct: 0,
    });
    expect(s.totals).toMatchObject({
      bills: 15,
      payable: 400000,
      prevPayable: 400000,
      changePct: 0,
    });
    expect(s.best).toBe('Cafe');
    expect(s.quiet).toEqual(['Kiosk']);
  });
  it('no sales at all: nothing is best, nobody divides by zero', () => {
    const s = hqSummary(shops, report([]), report([]));
    expect(s.best).toBeNull();
    expect(s.rows.every((r) => r.sharePct === 0 && r.changePct === null)).toBe(true);
    expect(s.quiet).toHaveLength(3);
  });
  it('the periods: today vs yesterday, 7 days vs the 7 before, the month so far vs the same days last month', () => {
    expect(hqRanges('today', '2026-11-21')).toEqual({
      current: { from: '2026-11-21', to: '2026-11-21' },
      previous: { from: '2026-11-20', to: '2026-11-20' },
    });
    expect(hqRanges('week', '2026-11-21')).toEqual({
      current: { from: '2026-11-15', to: '2026-11-21' },
      previous: { from: '2026-11-08', to: '2026-11-14' },
    });
    expect(hqRanges('month', '2026-11-21')).toEqual({
      current: { from: '2026-11-01', to: '2026-11-21' },
      previous: { from: '2026-10-01', to: '2026-10-21' },
    });
    // 31 March vs February: the previous period stops at the end of February
    expect(hqRanges('month', '2026-03-31').previous).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
    expect(hqRanges('month', '2027-01-15').previous).toEqual({
      from: '2026-12-01',
      to: '2026-12-15',
    });
    expect(hqRanges('today', '2026-03-01').previous.from).toBe('2026-02-28');
  });
});

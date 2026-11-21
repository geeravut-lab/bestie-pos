import { describe, expect, it } from 'vitest';
import { unverifiedNumbers } from './askShop';
import { buildShiftPack, parseShiftFigures } from './shiftFigures';

const raw = {
  shop: 'Cafe Nok',
  device: 'Till A',
  opened_at: '2026-11-20T02:00:00Z',
  closed_at: '2026-11-20T10:00:00Z',
  opening_cash: 100000,
  expected_cash: 482550,
  counted_cash: 480050,
  variance: -2500,
  bills: 23,
  sales: 1234567,
  by_tender: { cash: 382550, promptpay: 852017, 'x y': 5 },
};

describe('shift figures', () => {
  it('reads the database answer and drops odd tender names', () => {
    const f = parseShiftFigures(raw)!;
    expect(f.bills).toBe(23);
    expect(Object.keys(f.byTender).sort()).toEqual(['cash', 'promptpay']);
    expect(parseShiftFigures({})).toBeNull();
    expect(parseShiftFigures(null)).toBeNull();
  });
  it('writes the figures in baht with no floating point and lists what may be quoted', () => {
    const pack = buildShiftPack(parseShiftFigures(raw)!);
    expect(pack.text).toContain('Sales (THB, after discounts, including VAT): 12,345.67');
    expect(pack.text).toContain('Paid by cash: THB 3,825.50');
    expect(pack.text).toContain('Cash difference: SHORT by THB 25');
    expect(pack.allowed).toContain(12345.67);
    expect(pack.allowed).toContain(25);
  });
  it('lets the checker find an invented number', () => {
    const pack = buildShiftPack(parseShiftFigures(raw)!);
    expect(
      unverifiedNumbers('Sales were 12,345.67 baht and the till was short by 25.', pack.allowed),
    ).toEqual([]);
    expect(unverifiedNumbers('Sales were 15,000 baht.', pack.allowed)).toEqual(['15,000']);
  });
  it('says there is no difference when the count matches', () => {
    const f = parseShiftFigures({ ...raw, variance: 0, counted_cash: 482550 })!;
    expect(buildShiftPack(f).text).toContain('Cash difference: none');
  });
});

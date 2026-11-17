import { describe, expect, it } from 'vitest';
import { baht } from './money';
import { computeBill, vatFromInclusive } from './tax';

const line = (price: number, quantity = 1, discount?: number) => ({
  unitPrice: baht(price),
  quantity,
  ...(discount ? { discount: baht(discount) } : {}),
});

describe('vatFromInclusive', () => {
  it('extracts 7 % VAT from a gross amount', () => {
    expect(vatFromInclusive(10700, 700)).toEqual({ net: 10000, vat: 700 });
    expect(vatFromInclusive(10000, 700)).toEqual({ net: 9346, vat: 654 }); // 654.2 → 654
  });

  it('net + vat always equals gross', () => {
    for (let g = 0; g < 5000; g += 13) {
      const { net, vat } = vatFromInclusive(g, 700);
      expect(net + vat).toBe(g);
      expect(vat).toBeGreaterThanOrEqual(0);
    }
  });

  it('is a no-op for non-VAT-registered shops', () => {
    expect(vatFromInclusive(10000, 0)).toEqual({ net: 10000, vat: 0 });
  });
});

describe('computeBill — restaurant, VAT-inclusive prices + 10 % service charge', () => {
  const base = { priceMode: 'inclusive' as const, vatBps: 700, serviceChargeBps: 1000 };

  it('adds service charge on top; VAT is the portion contained in the gross', () => {
    const b = computeBill({ ...base, lines: [line(100, 2), line(50)] });
    expect(b.subtotal).toBe(baht(250));
    expect(b.serviceCharge).toBe(baht(25));
    expect(b.total).toBe(baht(275));
    expect(b.vat + b.netBeforeVat).toBe(b.total);
    expect(b.vat).toBe(1799); // 275 × 7/107 = 17.99
  });

  it('applies line discounts, then bill discount, then points, then service charge', () => {
    const b = computeBill({
      ...base,
      lines: [line(100, 2, 20), line(50)], // 250 − 20 = 230
      billDiscount: { type: 'percent', bps: 1000 }, // −23 → 207
      pointsDiscount: baht(7), // → 200
    });
    expect(b.lineDiscounts).toBe(baht(20));
    expect(b.billDiscount).toBe(baht(23));
    expect(b.pointsDiscount).toBe(baht(7));
    expect(b.discountedSubtotal).toBe(baht(200));
    expect(b.serviceCharge).toBe(baht(20));
    expect(b.total).toBe(baht(220));
  });

  it('caps the points discount at what is left on the bill', () => {
    const b = computeBill({ ...base, lines: [line(40)], pointsDiscount: baht(500) });
    expect(b.pointsDiscount).toBe(baht(40));
    expect(b.total).toBe(0);
    expect(b.vat).toBe(0);
  });
});

describe('computeBill — cafe, VAT-exclusive, no service charge', () => {
  it('adds VAT on top', () => {
    const b = computeBill({
      lines: [line(100)],
      priceMode: 'exclusive',
      vatBps: 700,
      serviceChargeBps: 0,
    });
    expect(b).toMatchObject({ vat: baht(7), netBeforeVat: baht(100), total: baht(107) });
  });
});

describe('computeBill — not VAT-registered', () => {
  it('has no VAT at all', () => {
    const b = computeBill({
      lines: [line(100)],
      priceMode: 'inclusive',
      vatBps: 0,
      serviceChargeBps: 0,
    });
    expect(b).toMatchObject({ vat: 0, total: baht(100), netBeforeVat: baht(100) });
  });
});

describe('computeBill — invariants and validation', () => {
  it('total is consistent for many generated bills in both price modes', () => {
    let seed = 42;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 300; i++) {
      const lines = Array.from({ length: 1 + rnd(5) }, () => ({
        unitPrice: 100 + rnd(30000),
        quantity: 1 + rnd(4),
      }));
      for (const priceMode of ['inclusive', 'exclusive'] as const) {
        const b = computeBill({
          lines,
          priceMode,
          vatBps: 700,
          serviceChargeBps: rnd(2) * 1000,
          billDiscount: rnd(3) === 0 ? { type: 'percent', bps: 500 } : undefined,
          pointsDiscount: rnd(4) === 0 ? rnd(2000) : 0,
        });
        expect(b.discountedSubtotal).toBe(
          b.subtotal - b.lineDiscounts - b.billDiscount - b.pointsDiscount,
        );
        expect(b.discountedSubtotal).toBeGreaterThanOrEqual(0);
        const base = b.discountedSubtotal + b.serviceCharge;
        expect(b.total).toBe(priceMode === 'inclusive' ? base : base + b.vat);
        expect(b.netBeforeVat + b.vat).toBe(b.total);
      }
    }
  });

  it('rejects bad input', () => {
    const ok = { priceMode: 'inclusive' as const, vatBps: 700, serviceChargeBps: 0 };
    expect(() => computeBill({ ...ok, lines: [{ unitPrice: 100.5, quantity: 1 }] })).toThrow();
    expect(() => computeBill({ ...ok, lines: [{ unitPrice: 100, quantity: 0 }] })).toThrow();
    expect(() =>
      computeBill({ ...ok, lines: [{ unitPrice: 100, quantity: 1, discount: 200 }] }),
    ).toThrow();
    expect(() => computeBill({ ...ok, vatBps: -1, lines: [] })).toThrow();
  });
});

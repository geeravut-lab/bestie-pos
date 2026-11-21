import { describe, expect, it } from 'vitest';
import {
  deliveryCommission,
  deliveryTotals,
  parseDeliveryInfo,
  parseDeliveryPlatforms,
  parseDeliveryReport,
} from './delivery';

describe('delivery', () => {
  it('works out the commission half up and inside 0–50 percent', () => {
    expect(deliveryCommission(20000, 2500)).toBe(5000);
    expect(deliveryCommission(31000, 3000)).toBe(9300);
    expect(deliveryCommission(10001, 3000)).toBe(3000); // 3000.3 → 3000
    expect(deliveryCommission(10005, 3000)).toBe(3002); // 3001.5 → 3002
    expect(deliveryCommission(10000, 0)).toBe(0);
    expect(deliveryCommission(10000, 9000)).toBe(5000); // capped at 50 %
    expect(deliveryCommission(10000, -5)).toBe(0);
  });
  it('reads platforms and never exposes more than the hint of a token', () => {
    const list = parseDeliveryPlatforms([
      {
        id: 'b',
        code: 'grab',
        name: 'Grab',
        commission_bps: 2500,
        token_hint: 'ab12',
        token_hash: 'x',
      },
      { id: 'a', code: 'lineman', name: 'LINE MAN', commission_bps: 99999, active: false },
      { id: 'c', code: 'uber', name: 'Uber' },
      { code: 'own', name: 'no id' },
    ]);
    expect(list.map((p) => p.name)).toEqual(['Grab', 'LINE MAN']);
    expect(list[0]).toEqual({
      id: 'b',
      code: 'grab',
      name: 'Grab',
      commissionBps: 2500,
      active: true,
      tokenHint: 'ab12',
    });
    expect(list[1]!.commissionBps).toBe(5000);
    expect(list[1]!.active).toBe(false);
    expect(Object.keys(list[0]!)).not.toContain('tokenHash');
  });
  it('reads the report and adds it up', () => {
    const rows = parseDeliveryReport([
      {
        platform_id: 'a',
        name: 'LINE MAN',
        code: 'lineman',
        commission_bps: 3000,
        bills: 1,
        gross: 31000,
        commission: 9300,
        net: 21700,
        paid_out: 0,
        owed: 21700,
      },
      {
        platform_id: 'b',
        name: 'Grab',
        code: 'grab',
        commission_bps: 2500,
        bills: '2',
        gross: 20000,
        commission: 5000,
        net: 15000,
        paid_out: 10000,
        owed: 5000,
      },
      { name: 'broken' },
    ]);
    expect(rows).toHaveLength(2);
    expect(deliveryTotals(rows)).toEqual({
      bills: 3,
      gross: 51000,
      commission: 14300,
      net: 36700,
      paidOut: 10000,
      owed: 26700,
    });
    expect(parseDeliveryReport(null)).toEqual([]);
  });
  it('reads the delivery details of a bill', () => {
    expect(
      parseDeliveryInfo({
        delivery_platform_id: 'p1',
        external_ref: 'GF-77',
        delivery_info: { name: 'Mia', phone: '081', address: 'x' },
      }),
    ).toEqual({ platformId: 'p1', ref: 'GF-77', name: 'Mia', phone: '081', address: 'x' });
    expect(parseDeliveryInfo({})).toEqual({
      platformId: null,
      ref: null,
      name: null,
      phone: null,
      address: null,
    });
  });
});

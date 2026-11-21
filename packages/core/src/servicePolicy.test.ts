import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SERVICE_POLICY,
  parsePackageDeferred,
  parseServicePolicy,
  servicePolicyPayload,
  tipsByPersonMonth,
} from './servicePolicy';

describe('service policy', () => {
  it("defaults to the owner's decisions: before VAT, deposit invoice, fee with VAT, deferred income", () => {
    expect(parseServicePolicy({})).toEqual(DEFAULT_SERVICE_POLICY);
    expect(parseServicePolicy(null)).toEqual(DEFAULT_SERVICE_POLICY);
  });
  it("reads the owner's choices and ignores nonsense", () => {
    const p = parseServicePolicy({
      commission_base: 'as_sold',
      deposit_invoice: false,
      noshow_fee_vat: 'yes',
      package_revenue: 'at_sale',
    });
    expect(p).toEqual({
      commissionBase: 'as_sold',
      depositInvoice: false,
      noshowFeeVat: true,
      packageRevenue: 'at_sale',
    });
    expect(parseServicePolicy(servicePolicyPayload(p))).toEqual(p);
  });
});

describe('deferred package income', () => {
  it('reads the report and keeps good rows only', () => {
    const r = parsePackageDeferred({
      as_of: '2026-11-21',
      policy: 'deferred',
      sold: 800000,
      released_by_visits: 80000,
      released_by_expiry: 0,
      deferred: 720000,
      rows: [
        {
          id: 'a',
          name: { th: 'นวด', en: 'Massage x10' },
          member: 'Anna',
          price: 800000,
          used: 80000,
          valid_until: '2027-01-01',
          expired: false,
          released_by_expiry: 0,
          deferred: 720000,
        },
        { nope: 1 },
      ],
    });
    expect(r?.deferred).toBe(720000);
    expect(r?.rows).toHaveLength(1);
    expect(r?.rows[0]).toMatchObject({ member: 'Anna', validUntil: '2027-01-01' });
    expect(parsePackageDeferred('x')).toBeNull();
  });
});

describe('tips per person per month', () => {
  it('adds up taken, paid out and still owed in Bangkok months, newest first', () => {
    const rows = [
      {
        staffId: 's1',
        name: 'Nok',
        amount: 10000,
        status: 'paid' as const,
        createdAt: '2026-10-31T18:00:00Z',
      }, // 1 Nov 01:00 in Bangkok
      {
        staffId: 's1',
        name: 'Nok',
        amount: 5000,
        status: 'owed' as const,
        createdAt: '2026-11-10T05:00:00Z',
      },
      {
        staffId: 's2',
        name: 'Fon',
        amount: 3000,
        status: 'owed' as const,
        createdAt: '2026-11-12T05:00:00Z',
      },
      {
        staffId: 's1',
        name: 'Nok',
        amount: 2000,
        status: 'paid' as const,
        createdAt: '2026-10-15T05:00:00Z',
      },
    ];
    const r = tipsByPersonMonth(rows);
    expect(r.map((x) => `${x.month} ${x.name}`)).toEqual([
      '2026-11 Fon',
      '2026-11 Nok',
      '2026-10 Nok',
    ]);
    expect(r[1]).toMatchObject({ taken: 15000, paidOut: 10000, owed: 5000 });
    expect(r[2]).toMatchObject({ taken: 2000, paidOut: 2000, owed: 0 });
  });
});

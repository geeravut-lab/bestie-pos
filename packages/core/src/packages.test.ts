import { describe, expect, it } from 'vitest';
import {
  packageSaving,
  packageState,
  parseCustomerPackages,
  parseServicePackages,
  usablePackage,
  visitValue,
} from './packages';
import type { CustomerPackage } from './packages';

const cp = (over: Partial<CustomerPackage> = {}): CustomerPackage => ({
  id: 'p',
  customerId: 'c',
  name: { th: 'นวด 10 ครั้ง' },
  price: 800000,
  visitsTotal: 10,
  visitsLeft: 10,
  validUntil: '2027-05-01',
  status: 'active',
  ...over,
});

describe('package state', () => {
  it('a date that has passed makes an active package expired; the stored status stays otherwise', () => {
    expect(packageState(cp(), '2027-05-01')).toBe('active'); // the last day still counts
    expect(packageState(cp(), '2027-05-02')).toBe('expired');
    expect(packageState(cp({ validUntil: null }), '2099-01-01')).toBe('active');
    expect(packageState(cp({ status: 'used_up' }), '2099-01-01')).toBe('used_up');
    expect(packageState(cp({ status: 'pending' }), '2099-01-01')).toBe('pending');
  });
  it('only an active, in-date package with a visit left can pay for a visit', () => {
    expect(usablePackage(cp(), '2027-01-01')).toBe(true);
    expect(usablePackage(cp({ visitsLeft: 0 }), '2027-01-01')).toBe(false);
    expect(usablePackage(cp(), '2028-01-01')).toBe(false);
    expect(usablePackage(cp({ status: 'pending' }), '2027-01-01')).toBe(false);
    expect(usablePackage(cp({ status: 'cancelled' }), '2027-01-01')).toBe(false);
  });
});

describe('money', () => {
  it('values a visit like the database: price ÷ visits rounded to the satang', () => {
    expect(visitValue(800000, 10)).toBe(80000);
    expect(visitValue(100000, 3)).toBe(33333);
    expect(visitValue(100001, 3)).toBe(33334);
    expect(visitValue(0, 5)).toBe(0);
    expect(visitValue(100, 0)).toBe(0);
  });
  it('shows what a package saves against paying per visit', () => {
    expect(packageSaving({ price: 800000, visits: 10 }, 100000)).toBe(200000);
    expect(packageSaving({ price: 800000, visits: 10 }, 70000)).toBe(0);
  });
});

describe('reading rows', () => {
  it('reads the catalogue and drops broken rows', () => {
    const r = parseServicePackages([
      {
        id: 'a',
        name: { th: 'นวด', en: 'Massage' },
        price: '800000',
        visits: 10,
        valid_days: 180,
        active: true,
      },
      { id: 'b', name: { th: 'สปา' }, price: 500000, visits: 5, valid_days: null, active: false },
      { id: 'c', name: {}, price: 1, visits: 1 },
    ]);
    expect(r).toEqual([
      {
        id: 'a',
        name: { th: 'นวด', en: 'Massage' },
        price: 800000,
        visits: 10,
        validDays: 180,
        active: true,
      },
      { id: 'b', name: { th: 'สปา' }, price: 500000, visits: 5, validDays: null, active: false },
    ]);
  });
  it("reads a member's packages", () => {
    const r = parseCustomerPackages([
      {
        id: 'p',
        customer_id: 'c',
        name: { th: 'นวด' },
        price: 800000,
        visits_total: 10,
        visits_left: '7',
        valid_until: '2027-05-01T00:00:00',
        status: 'active',
      },
      { id: 'q', customer_id: 'c', name: { th: 'x' }, status: 'weird' },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ visitsLeft: 7, validUntil: '2027-05-01', status: 'active' });
  });
});

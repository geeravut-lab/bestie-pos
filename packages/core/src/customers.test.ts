import { describe, expect, it } from 'vitest';
import {
  normalizePhone,
  parseCustomerCard,
  parseCustomerCards,
  parsePointsHistory,
  searchWorthy,
} from './customers';

describe('customers', () => {
  it('reads a member card and a numeric-string balance', () => {
    expect(
      parseCustomerCard({
        id: 'c',
        name: 'Anna',
        phone: '66812345678',
        member_code: 'AB12CD34',
        balance: '12',
      }),
    ).toEqual({ id: 'c', name: 'Anna', phone: '66812345678', memberCode: 'AB12CD34', points: 12 });
    expect(parseCustomerCard({ id: 'c' })).toBeNull();
    expect(parseCustomerCards('nope')).toEqual([]);
    expect(parseCustomerCards([{ id: 'a', name: 'A' }, null, 3])).toHaveLength(1);
  });
  it('keeps only the digits of a phone number', () => {
    expect(normalizePhone('+66 (81) 234-5678')).toBe('66812345678');
  });
  it('does not search for fragments the server would ignore', () => {
    expect(searchWorthy('a')).toBe(false);
    expect(searchWorthy('12')).toBe(false);
    expect(searchWorthy('081-2')).toBe(true);
    expect(searchWorthy('an')).toBe(true);
    expect(searchWorthy('AB12CD34')).toBe(true);
  });
  it('reads history rows and skips broken ones', () => {
    const rows = parsePointsHistory([
      { id: '1', kind: 'earn', points: 8, order_id: 'o', created_at: '2026-11-18T00:00:00Z' },
      { id: '2', kind: 'adjust', points: 'x' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'earn', points: 8, orderId: 'o', reason: null });
  });
});

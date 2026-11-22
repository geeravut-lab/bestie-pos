import { describe, expect, it } from 'vitest';
import { newOrder } from '@bestie/core';
import type { ReceiptDoc } from '@bestie/core';
import { buildReceiptRows } from './rows';

const receipt = (payments: ReceiptDoc['payments']): ReceiptDoc => ({
  number: 'A+000018',
  issuedAt: '2026-11-22T09:18:00.000Z',
  lang: 'en',
  sellerName: 'Acme Co',
  sellerTaxId: '0105560123456',
  branchCode: '00000',
  posId: 'POS-1',
  vatRegistered: true,
  vatBps: 700,
  serviceBps: 0,
  priceMode: 'inclusive',
  subtotal: 24500,
  serviceCharge: 0,
  vat: 1603,
  netBeforeVat: 22897,
  total: 24500,
  rounding: 0,
  payable: 24500,
  staffName: 'Nok',
  payments,
});

describe('buildReceiptRows', () => {
  it('lists a payment made with Bestie Credit, so the payments add up to the total on paper', () => {
    const order = newOrder({
      id: 'o1',
      orgId: 'org',
      storeId: 'store',
      number: 'A011',
      channel: 'takeaway',
      now: Date.now(),
    });
    const rows = buildReceiptRows(
      order,
      receipt([
        {
          id: 'p1',
          tender: 'credit',
          amount: 12250,
          tendered: 12250,
          change: 0,
          createdAt: '2026-11-22T09:18:00Z',
        },
        {
          id: 'p2',
          tender: 'cash',
          amount: 12250,
          tendered: 13000,
          change: 750,
          createdAt: '2026-11-22T09:18:00Z',
        },
      ]),
      'en',
    );
    const labels = rows.flatMap((r) => (r.kind === 'row' ? [r.left] : []));
    expect(labels).toContain('Paid with Bestie Credit');
    expect(labels).toContain('Cash');
    const credit = rows.find((r) => r.kind === 'row' && r.left === 'Paid with Bestie Credit');
    expect(credit && credit.kind === 'row' && credit.right).toMatch(/122\.50/);
  });
});

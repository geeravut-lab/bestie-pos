import { describe, expect, it } from 'vitest';
import { closeShift, cashVariance, openShift, shiftFromRow, summarizeShift } from './shifts';
import { closeOrder, buildCashReceipt } from './payments';
import { addLine, newOrder, orderBill, sendNew } from './orders';
import type { OrderDoc } from './orders';
import type { ReceiptDoc } from './payments';

const T0 = Date.UTC(2026, 10, 18, 3, 0);
const shift = () =>
  openShift({
    id: 's1',
    orgId: 'o',
    storeId: 'st',
    deviceId: 'dev',
    openedBy: 'p',
    openingCash: 100000,
    now: T0,
  });
const cfg = { priceMode: 'inclusive' as const, vatBps: 0, serviceChargeBps: 0 };
const paid = (
  id: string,
  number: string,
  at: number,
  amount: number,
  tender: 'cash' | 'promptpay' | 'gateway' = 'cash',
): OrderDoc => {
  let o = newOrder({ id, orgId: 'o', storeId: 'st', number: 'X', channel: 'takeaway', now: at });
  o = sendNew(
    addLine(o, {
      lineId: id,
      item: { id: 'i', name: { th: 'x' }, prices: { base: amount }, station: null },
      groups: [],
      selected: [],
      quantity: 1,
    }),
    at,
  ).order;
  const r = buildCashReceipt({
    order: o,
    bill: orderBill(o, cfg),
    billConfig: cfg,
    roundingRule: 'none',
    tendered: amount,
    number,
    paymentId: id,
    seller: {
      sellerName: 's',
      sellerTaxId: null,
      branchCode: '00000',
      posId: null,
      vatRegistered: false,
      staffName: null,
    },
    lang: 'th',
    now: at,
  });
  const receipt: ReceiptDoc = { ...r, payments: r.payments.map((p) => ({ ...p, tender })) };
  return closeOrder(o, receipt);
};

describe('shift', () => {
  it('opens with the cash counted into the drawer; negative or fractional amounts are refused', () => {
    expect(shift()).toMatchObject({
      status: 'open',
      openingCash: 100000,
      openedAt: '2026-11-18T03:00:00.000Z',
      closedAt: null,
    });
    expect(() => openShift({ ...shift(), now: T0, openingCash: -1 })).toThrow();
    expect(() => openShift({ ...shift(), now: T0, openingCash: 1.5 })).toThrow();
  });

  it('expected cash = opening + cash taken on THIS device (its own series) inside the shift window; other tenders are listed, not counted', () => {
    const s = shift();
    const orders = [
      paid('a', 'A-000001', T0 + 60_000, 21000),
      paid('b', 'A-000002', T0 + 120_000, 3000),
      paid('c', 'B-000007', T0 + 90_000, 99900), // another device's till
      paid('d', 'A+000001', T0 + 100_000, 9900, 'promptpay'),
      paid('e', 'A+000002', T0 + 110_000, 5000, 'gateway'),
      paid('f', 'A-000000', T0 - 60_000, 7777), // before the shift
    ];
    const sum = summarizeShift(s, 'A', orders, T0 + 3_600_000);
    expect(sum).toMatchObject({
      cash: 24000,
      promptpay: 9900,
      card: 5000,
      cashBills: 2,
      bills: 4,
      expectedCash: 124000,
    });
  });

  it('a bill paid after the shift closed does not belong to it', () => {
    const closed = closeShift(shift(), {
      countedCash: 124000,
      expectedCash: 124000,
      now: T0 + 3_600_000,
    });
    const sum = summarizeShift(
      closed,
      'A',
      [paid('z', 'A-000009', T0 + 7_200_000, 1000)],
      T0 + 9_000_000,
    );
    expect(sum.cash).toBe(0);
  });

  it('closing records counted, expected and the variance (negative = short); a closed shift cannot close again', () => {
    const c = closeShift(shift(), {
      countedCash: 123500,
      expectedCash: 124000,
      now: T0 + 1000,
      note: '  short  ',
    });
    expect(c).toMatchObject({
      status: 'closed',
      countedCash: 123500,
      expectedCash: 124000,
      variance: -500,
      note: 'short',
    });
    expect(() => closeShift(c, { countedCash: 1, expectedCash: 1, now: 1 })).toThrow(
      /already closed/,
    );
    expect(() => closeShift(shift(), { countedCash: -5, expectedCash: 0, now: 1 })).toThrow();
    expect(cashVariance(5000, 4000)).toBe(1000);
  });

  it('reads a server row leniently (bigint as string) and skips a damaged one', () => {
    const row = {
      id: 's1',
      org_id: 'o',
      store_id: 'st',
      device_id: 'dev',
      opened_at: '2026-11-18T03:00:00Z',
      opening_cash: '100000',
      status: 'closed',
      closed_at: '2026-11-18T09:00:00Z',
      counted_cash: 123500,
      expected_cash: 124000,
      variance: '-500',
    };
    expect(shiftFromRow(row)).toMatchObject({
      openingCash: 100000,
      status: 'closed',
      variance: -500,
    });
    expect(shiftFromRow({ id: 'x' })).toBeNull();
  });
});

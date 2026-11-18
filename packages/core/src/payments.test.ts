import { describe, expect, it } from 'vitest';
import {
  buildCashReceipt,
  cashSettlement,
  closeOrder,
  closePayload,
  formatReceiptNumber,
  onlineSnapshot,
  payBlockers,
  quickCashAmounts,
  receiptLines,
  receiptSeq,
} from './payments';
import { receiptFromRows } from './receiptRows';
import { addLine, diffOrder, newOrder, orderBill, sendNew } from './orders';
import type { BillConfig, OrderDoc } from './orders';

const cfg: BillConfig = { priceMode: 'inclusive', vatBps: 700, serviceChargeBps: 0 };
const seller = {
  sellerName: 'Acme Co',
  sellerTaxId: '0105560123456',
  branchCode: '00001',
  posId: 'POS-77',
  vatRegistered: true,
  staffName: 'Nok',
};
const order = (qty = 2): OrderDoc => {
  const o = newOrder({
    id: 'o1',
    orgId: 'org',
    storeId: 'st',
    number: 'A001',
    channel: 'takeaway',
    now: Date.UTC(2026, 10, 18, 5),
  });
  return sendNew(
    addLine(o, {
      lineId: 'l1',
      item: {
        id: 'i',
        name: { th: 'ผัดไทย', en: 'Pad Thai' },
        prices: { base: 9000 },
        station: 'kitchen',
      },
      groups: [],
      selected: [],
      quantity: qty,
    }),
    1,
  ).order;
};
const receiptFor = (
  o: OrderDoc,
  tendered: number,
  rule: Parameters<typeof cashSettlement>[1] = 'none',
) =>
  buildCashReceipt({
    order: o,
    bill: orderBill(o, cfg),
    billConfig: cfg,
    roundingRule: rule,
    tendered,
    number: 'A-000001',
    paymentId: 'p1',
    seller,
    lang: 'th',
    now: Date.UTC(2026, 10, 18, 5, 30),
  });

describe('cashSettlement', () => {
  it('exact cash, change, and what is still missing', () => {
    expect(cashSettlement(21000, 'none', 50000)).toEqual({
      payable: 21000,
      rounding: 0,
      change: 29000,
      short: 0,
    });
    expect(cashSettlement(21000, 'none', 20000)).toMatchObject({ change: 0, short: 1000 });
  });
  it('rounding is its own number: down for 29.90 → 30.00 is +0.10, 30.20 to the nearest baht is −0.20', () => {
    expect(cashSettlement(2990, 'nearest-baht', 5000)).toEqual({
      payable: 3000,
      rounding: 10,
      change: 2000,
      short: 0,
    });
    expect(cashSettlement(3020, 'nearest-baht', 5000)).toMatchObject({
      payable: 3000,
      rounding: -20,
    });
    expect(cashSettlement(3090, 'floor-baht', 3000)).toMatchObject({
      payable: 3000,
      rounding: -90,
      short: 0,
    });
  });
  it('change is computed on the ROUNDED amount', () => {
    expect(cashSettlement(2990, 'nearest-baht', 3000).change).toBe(0);
  });
});

describe('quickCashAmounts', () => {
  it('offers the exact amount then the next notes that cover it, sorted, no more than 5', () => {
    expect(quickCashAmounts(21000)).toEqual([21000, 22000, 25000, 30000, 50000]);
    expect(quickCashAmounts(10000)).toEqual([10000, 50000, 100000]);
    expect(quickCashAmounts(99)).toEqual([99, 2000, 5000, 10000, 50000]);
  });
  it('never offers less than the bill', () => {
    for (const p of [1, 25, 1999, 2000, 123456])
      expect(quickCashAmounts(p).every((a) => a >= p)).toBe(true);
  });
});

describe('receipt numbers', () => {
  it('series per device, consecutive, six digits', () => {
    expect(formatReceiptNumber('A', 1)).toBe('A-000001');
    expect(formatReceiptNumber('AB', 123456)).toBe('AB-123456');
    expect(receiptSeq('A', 'A-000042')).toBe(42);
    expect(receiptSeq('A', 'B-000042')).toBeNull();
    expect(receiptSeq('A', 'A-42')).toBeNull();
  });
});

describe('buildCashReceipt', () => {
  it('snapshots the bill that was on screen, the seller, and the cash given and returned', () => {
    const r = receiptFor(order(), 50000);
    expect(r).toMatchObject({
      number: 'A-000001',
      subtotal: 18000,
      vat: 1178,
      total: 18000,
      rounding: 0,
      payable: 18000,
      sellerName: 'Acme Co',
      posId: 'POS-77',
      branchCode: '00001',
    });
    expect(r.payments).toEqual([
      {
        id: 'p1',
        tender: 'cash',
        amount: 18000,
        tendered: 50000,
        change: 32000,
        createdAt: '2026-11-18T05:30:00.000Z',
      },
    ]);
  });
  it('carries the cash rounding as its own line', () => {
    const o = order(1); // 90.00
    const r = receiptFor(
      { ...o, lines: o.lines.map((l) => ({ ...l, unitPrice: 8990 })) },
      9000,
      'nearest-baht',
    );
    expect(r).toMatchObject({ total: 8990, rounding: 10, payable: 9000 });
    expect(r.payments[0]).toMatchObject({ amount: 9000, change: 0 });
  });
  it('refuses cash that does not cover the bill', () => {
    expect(() => receiptFor(order(), 1000)).toThrow(/does not cover/);
  });
});

describe('closing', () => {
  it('payBlockers: nothing on the bill, unsent lines, already closed', () => {
    const empty = newOrder({
      id: 'o',
      orgId: 'a',
      storeId: 'b',
      number: 'A002',
      channel: 'takeaway',
      now: 1,
    });
    expect(payBlockers(empty)).toEqual(['empty']);
    expect(payBlockers(order())).toEqual([]);
    const unsent = addLine(order(), {
      lineId: 'l9',
      item: { id: 'j', name: { th: 'ชา' }, prices: { base: 3000 }, station: null },
      groups: [],
      selected: [],
      quantity: 1,
    });
    expect(payBlockers(unsent)).toEqual(['unsent']);
    expect(payBlockers({ ...order(), status: 'paid' })).toContain('closed');
  });

  it('closeOrder marks it paid with the receipt, and the till never sends "paid" as a plain update', () => {
    const o = order();
    const paid = closeOrder(o, receiptFor(o, 20000));
    expect(paid).toMatchObject({ status: 'paid', closedAt: '2026-11-18T05:30:00.000Z' });
    expect(diffOrder(o, paid)).toEqual([]); // the payment function (close_order) is the only way to close
  });

  it('the server payload carries exactly what close_order checks', () => {
    const o = order();
    const p = closePayload(o, receiptFor(o, 20000), { deviceId: 'dev', staffId: 'st1' });
    expect(p).toMatchObject({
      order_id: 'o1',
      receipt_number: 'A-000001',
      device_id: 'dev',
      subtotal: 18000,
      total: 18000,
      rounding: 0,
      payable: 18000,
      vat_bps: 700,
    });
    expect((p.payments as { amount: number; tendered: number; change: number }[])[0]).toMatchObject(
      { amount: 18000, tendered: 20000, change: 2000 },
    );
  });

  it('receipt lines skip voided lines and keep option names', () => {
    expect(receiptLines(order(3))).toEqual([
      {
        name: { th: 'ผัดไทย', en: 'Pad Thai' },
        quantity: 3,
        unitPrice: 9000,
        lineTotal: 27000,
        options: [],
      },
    ]);
  });
});

describe('receiptFromRows (what another tablet reads back)', () => {
  const row = {
    number: 'A-000007',
    issued_at: '2026-11-18T05:30:00Z',
    seller_name: 'Acme Co',
    seller_tax_id: '0105560123456',
    branch_code: '00001',
    pos_id: 'POS-77',
    vat_registered: true,
    vat_bps: 700,
    service_bps: 1000,
    price_mode: 'inclusive',
    subtotal: '18000',
    service_charge: 1800,
    vat: 1295,
    net_before_vat: 18505,
    total: 19800,
    rounding: 0,
    payable: 19800,
    lang: 'en',
  };
  it('reads numbers that arrive as strings (bigint) and the payments', () => {
    const r = receiptFromRows(row, [
      {
        id: 'p',
        tender: 'cash',
        amount: '19800',
        tendered: 20000,
        change: 200,
        status: 'confirmed',
      },
    ])!;
    expect(r).toMatchObject({
      number: 'A-000007',
      subtotal: 18000,
      serviceCharge: 1800,
      lang: 'en',
      posId: 'POS-77',
    });
    expect(r.payments).toEqual([
      {
        id: 'p',
        tender: 'cash',
        amount: 19800,
        tendered: 20000,
        change: 200,
        createdAt: '2026-11-18T05:30:00Z',
      },
    ]);
  });
  it('drops failed / voided payments and refuses a damaged receipt', () => {
    expect(
      receiptFromRows(row, [{ id: 'p', tender: 'cash', amount: 1, status: 'failed' }])!.payments,
    ).toEqual([]);
    expect(receiptFromRows({ ...row, total: 'lots' }, [])).toBeNull();
    expect(receiptFromRows({}, [])).toBeNull();
  });
});

describe('onlineSnapshot', () => {
  it("is the bill as shown, exact to the satang (no cash rounding), with the shop's rates", () => {
    const o = order();
    const s = onlineSnapshot({
      order: o,
      bill: orderBill(o, cfg),
      billConfig: cfg,
      tender: 'promptpay',
      deviceId: 'dev',
      staffId: 'st1',
      lang: 'th',
    });
    expect(s).toMatchObject({
      order_id: 'o1',
      tender: 'promptpay',
      subtotal: 18000,
      total: 18000,
      payable: 18000,
      rounding: 0,
      vat_bps: 700,
      service_bps: 0,
      price_mode: 'inclusive',
    });
  });
});

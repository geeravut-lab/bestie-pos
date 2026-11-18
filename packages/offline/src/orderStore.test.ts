import { beforeEach, describe, expect, it } from 'vitest';
import { addLine, buildCashReceipt, closeOrder, newOrder, orderBill, sendNew } from '@bestie/core';
import type { OrderDoc } from '@bestie/core';
import {
  enqueue,
  flush,
  getOrder,
  listOpenOrders,
  listPaidOrders,
  nextOrderNumber,
  nextReceiptNumber,
  outboxCounts,
  payOrder,
  pullOrders,
  resetOfflineDb,
  saveOrder,
  syncReceiptCounter,
} from './index';
import type { RemoteClient } from './index';
import { listOutbox } from './outbox';

beforeEach(async () => {
  await resetOfflineDb();
});

const NOW = Date.UTC(2026, 10, 18, 5, 0); // 12:00 in Bangkok, 18 Nov
const base = (id: string, number = 'A001', storeId = 'st'): OrderDoc =>
  newOrder({ id, orgId: 'org', storeId, number, channel: 'dine-in', tableId: 't1', now: NOW });
const withLine = (o: OrderDoc): OrderDoc =>
  addLine(o, {
    lineId: `${o.id}-l1`,
    item: { id: 'i1', name: { th: 'ผัดไทย' }, prices: { base: 8000 }, station: 'kitchen' },
    groups: [],
    selected: [],
    quantity: 1,
  });

describe('saveOrder', () => {
  it('keeps the working copy and the queued server writes together', async () => {
    const o = withLine(base('o1'));
    expect(await saveOrder(null, o)).toBe(2);
    expect((await getOrder('o1'))?.lines).toHaveLength(1);
    expect(await outboxCounts()).toEqual({ pending: 2, dead: 0 });
  });

  it('two saves in the same millisecond keep their order (timestamps are strictly increasing)', async () => {
    const a = withLine(base('o1'));
    await saveOrder(null, a, () => 5000);
    await saveOrder(a, sendNew(a, 1).order, () => 5000);
    await enqueue({ kind: 'rpc', fn: 'x', args: {} }, () => 1); // a clock that stepped back
    const stamps = (await listOutbox()).map((e) => e.createdAt);
    expect(stamps).toEqual([...stamps].sort((x, y) => x - y));
    expect(new Set(stamps).size).toBe(stamps.length);
  });

  it('queues the order before its lines, even inside the same millisecond', async () => {
    await saveOrder(null, withLine(base('o1')), () => 1000);
    const q = await listOutbox();
    expect(q.map((e) => (e.op.kind === 'insert' ? e.op.table : '?'))).toEqual([
      'orders',
      'order_lines',
    ]);
    expect(q[0]!.createdAt).toBeLessThan(q[1]!.createdAt);
  });

  it('a later change queues only the difference', async () => {
    const a = withLine(base('o1'));
    await saveOrder(null, a);
    const { order: b } = sendNew(a, NOW);
    expect(await saveOrder(a, b)).toBe(1);
    expect((await getOrder('o1'))?.lines[0]!.status).toBe('sent');
  });

  it('works end to end offline → online: nothing is lost and the server sees order then lines in order', async () => {
    const o = withLine(base('o1'));
    await saveOrder(null, o);
    const seen: string[] = [];
    const client = {
      from: (table: string) => ({
        insert: async (v: { id: string }) => {
          seen.push(`${table}:${v.id}`);
          return { error: null };
        },
      }),
      rpc: async () => ({ error: null }),
    } as unknown as RemoteClient;
    const r = await flush(client);
    expect(seen).toEqual(['orders:o1', 'order_lines:o1-l1']);
    expect(r).toMatchObject({ sent: 2, pending: 0 });
  });
});

describe('open orders and numbers', () => {
  it('lists open orders of one shop only, oldest first, never closed ones', async () => {
    const a = base('a', 'A001');
    const b = { ...base('b', 'A002'), createdAt: '2026-11-18T05:01:00.000Z' };
    const paid = { ...base('c', 'A003'), status: 'paid' as const };
    const other = base('d', 'A001', 'other-shop');
    for (const o of [b, a, paid, other]) await saveOrder(null, o);
    expect((await listOpenOrders('st')).map((o) => o.id)).toEqual(['a', 'b']);
  });

  it("numbers continue from this device's orders of the day, per device code", async () => {
    expect(await nextOrderNumber('st', 'A', NOW)).toBe('A001');
    await saveOrder(null, base('o1', 'A001'));
    await saveOrder(null, base('o2', 'A007'));
    await saveOrder(null, base('o3', 'B004'));
    expect(await nextOrderNumber('st', 'A', NOW)).toBe('A008');
    expect(await nextOrderNumber('st', 'B', NOW)).toBe('B005');
    expect(await nextOrderNumber('st', 'A', NOW + 24 * 3600_000)).toBe('A001'); // a new business day starts again
  });
});

describe('pullOrders', () => {
  const serverClient = (
    orders: unknown[],
    lines: unknown[],
    extra: { receipts: unknown[]; payments: unknown[] } = { receipts: [], payments: [] },
  ) =>
    ({
      from: (table: string) => {
        const c: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'or', 'in']) c[m] = () => c;
        c.then = (res: (v: unknown) => unknown) =>
          Promise.resolve({
            data:
              table === 'orders'
                ? orders
                : table === 'order_lines'
                  ? lines
                  : table === 'receipts'
                    ? extra.receipts
                    : extra.payments,
            error: null,
          }).then(res);
        return c;
      },
    }) as unknown as Pick<RemoteClient, 'from'>;

  const serverOrder = {
    id: 's1',
    org_id: 'org',
    store_id: 'st',
    number: 'B001',
    business_date: '2026-11-18',
    channel: 'dine-in',
    status: 'open',
    table_id: null,
    created_at: '2026-11-18T05:00:00Z',
  };
  const serverLine = {
    id: 'sl1',
    order_id: 's1',
    unit_price: 5000,
    quantity: 2,
    name: { th: 'ชา' },
    status: 'ready',
    modifiers: [],
  };

  it('brings the other devices\' orders (and the kitchen\'s "ready") into the working copy', async () => {
    expect(await pullOrders(serverClient([serverOrder], [serverLine]), 'st', NOW)).toBe('ok');
    const doc = await getOrder('s1');
    expect(doc?.number).toBe('B001');
    expect(doc?.lines[0]).toMatchObject({ quantity: 2, status: 'ready' });
  });

  it('does nothing while writes wait to be sent (it must never overwrite unsent work)', async () => {
    const mine = withLine(base('o1'));
    await saveOrder(null, mine);
    expect(
      await pullOrders(serverClient([{ ...serverOrder, id: 'o1', status: 'void' }], []), 'st', NOW),
    ).toBe('skipped');
    expect((await getOrder('o1'))?.status).toBe('open');
  });

  it('skips damaged server rows', async () => {
    await pullOrders(serverClient([serverOrder, { id: 'broken' }], [serverLine]), 'st', NOW);
    expect(await getOrder('broken')).toBeNull();
    expect(await getOrder('s1')).not.toBeNull();
  });

  it('with an unrelated queued entry it still waits (conservative on purpose)', async () => {
    await enqueue({ kind: 'rpc', fn: 'x', args: {} });
    expect(await pullOrders(serverClient([serverOrder], []), 'st', NOW)).toBe('skipped');
  });
});

describe('payOrder (cash)', () => {
  const who = { deviceId: 'dev1', deviceCode: 'A', staffId: 'st1' };
  const cfg = { priceMode: 'inclusive' as const, vatBps: 700, serviceChargeBps: 0 };
  const sentOrder = () => sendNew(withLine(base('o1')), NOW).order;
  const receiptOf = (o: OrderDoc, number: string) =>
    buildCashReceipt({
      order: o,
      bill: orderBill(o, cfg),
      billConfig: cfg,
      roundingRule: 'none',
      tendered: 10000,
      number,
      paymentId: 'pay1',
      seller: {
        sellerName: 'Acme',
        sellerTaxId: null,
        branchCode: '00000',
        posId: null,
        vatRegistered: true,
        staffName: null,
      },
      lang: 'th',
      now: NOW,
    });

  it('stores the paid copy, queues exactly one close_order call, and moves the receipt counter — in one go', async () => {
    const o = sentOrder();
    await saveOrder(null, o);
    await resetQueue();
    const r = receiptOf(o, 'A-000001');
    await payOrder(o, closeOrder(o, r), r, who);
    expect((await getOrder('o1'))?.status).toBe('paid');
    const q = await listOutbox();
    expect(q).toHaveLength(1);
    expect(q[0]!.op).toMatchObject({
      kind: 'rpc',
      fn: 'close_order',
      args: { p: { order_id: 'o1', receipt_number: 'A-000001', device_id: 'dev1' } },
    });
    expect(await nextReceiptNumber('dev1', 'A')).toBe('A-000002');
  });

  it('numbers never repeat: the counter survives clearing local orders, and a paid order on the tablet also counts', async () => {
    expect(await nextReceiptNumber('dev1', 'A')).toBe('A-000001');
    const o = sentOrder();
    await saveOrder(null, o);
    const r = receiptOf(o, 'A-000007');
    await payOrder(o, closeOrder(o, r), r, who);
    expect(await nextReceiptNumber('dev1', 'A')).toBe('A-000008');
    expect(await nextReceiptNumber('other-device', 'B')).toBe('B-000001'); // another device, another series
  });

  it("refuses a receipt number that is not from this device's series", async () => {
    const o = sentOrder();
    await saveOrder(null, o);
    const r = receiptOf(o, 'B-000001');
    await expect(payOrder(o, closeOrder(o, r), r, who)).rejects.toThrow(/not from this device/);
  });

  it('pays offline, then the queue sends order lines first and the close call last', async () => {
    const o = sentOrder();
    await saveOrder(null, o);
    const r = receiptOf(o, 'A-000001');
    await payOrder(o, closeOrder(o, r), r, who);
    const seen: string[] = [];
    const client = {
      from: (table: string) => ({ insert: async () => (seen.push(table), { error: null }) }),
      rpc: async (fn: string) => (seen.push(fn), { error: null }),
    } as unknown as RemoteClient;
    await flush(client);
    expect(seen).toEqual(['orders', 'order_lines', 'close_order']);
  });

  it('lists the paid bills of a day, newest first', async () => {
    const a = sentOrder();
    await saveOrder(null, a);
    const ra = receiptOf(a, 'A-000001');
    await payOrder(a, closeOrder(a, ra), ra, who);
    expect((await listPaidOrders('st', '2026-11-18')).map((o) => o.id)).toEqual(['o1']);
    expect(await listPaidOrders('st', '2026-11-17')).toEqual([]);
  });

  it('syncReceiptCounter raises the counter to what the server saw, never lowers it', async () => {
    const server = (n: string) =>
      ({
        from: () => {
          const c: Record<string, unknown> = {};
          for (const m of ['select', 'eq', 'order', 'limit']) c[m] = () => c;
          c.then = (res: (v: unknown) => unknown) =>
            Promise.resolve({ data: [{ number: n }], error: null }).then(res);
          return c;
        },
      }) as unknown as Pick<RemoteClient, 'from'>;
    await syncReceiptCounter(server('A-000040'), 'dev1', 'A');
    expect(await nextReceiptNumber('dev1', 'A')).toBe('A-000041');
    await syncReceiptCounter(server('A-000010'), 'dev1', 'A');
    expect(await nextReceiptNumber('dev1', 'A')).toBe('A-000041');
  });

  it('pull brings the receipt and payments of paid bills from other tablets', async () => {
    const paid = {
      id: 'p1',
      org_id: 'org',
      store_id: 'st',
      number: 'B001',
      business_date: '2026-11-18',
      channel: 'takeaway',
      status: 'paid',
      closed_at: '2026-11-18T05:00:00Z',
      created_at: '2026-11-18T04:00:00Z',
    };
    const rec = {
      order_id: 'p1',
      number: 'B-000003',
      issued_at: '2026-11-18T05:00:00Z',
      seller_name: 'Acme',
      branch_code: '00000',
      vat_registered: false,
      vat_bps: 0,
      service_bps: 0,
      price_mode: 'inclusive',
      subtotal: 5000,
      service_charge: 0,
      vat: 0,
      net_before_vat: 5000,
      total: 5000,
      rounding: 0,
      payable: 5000,
    };
    const pay = {
      id: 'x',
      order_id: 'p1',
      tender: 'cash',
      amount: 5000,
      tendered: 10000,
      change: 5000,
      status: 'confirmed',
    };
    await pullOrders(
      {
        from: (table: string) => {
          const c: Record<string, unknown> = {};
          for (const m of ['select', 'eq', 'or', 'in']) c[m] = () => c;
          const data =
            table === 'orders'
              ? [paid]
              : table === 'receipts'
                ? [rec]
                : table === 'payments'
                  ? [pay]
                  : [];
          c.then = (res: (v: unknown) => unknown) =>
            Promise.resolve({ data, error: null }).then(res);
          return c;
        },
      } as unknown as Pick<RemoteClient, 'from'>,
      'st',
      NOW,
    );
    expect((await getOrder('p1'))?.receipt).toMatchObject({
      number: 'B-000003',
      total: 5000,
      payments: [{ tender: 'cash', tendered: 10000 }],
    });
  });
});

async function resetQueue() {
  const { db } = await import('./db');
  await db.outbox.clear();
}

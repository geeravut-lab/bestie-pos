import { beforeEach, describe, expect, it } from 'vitest';
import { addLine, newOrder, sendNew } from '@bestie/core';
import type { OrderDoc } from '@bestie/core';
import {
  enqueue,
  flush,
  getOrder,
  listOpenOrders,
  nextOrderNumber,
  outboxCounts,
  pullOrders,
  resetOfflineDb,
  saveOrder,
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
  const serverClient = (orders: unknown[], lines: unknown[]) =>
    ({
      from: (table: string) => {
        const c: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'or', 'in']) c[m] = () => c;
        c.then = (res: (v: unknown) => unknown) =>
          Promise.resolve({ data: table === 'orders' ? orders : lines, error: null }).then(res);
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

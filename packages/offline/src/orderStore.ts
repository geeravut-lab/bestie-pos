import { bangkokDate, diffOrder, formatOrderNumber, isOrderOpen, rowsToOrder } from '@bestie/core';
import type { OrderDoc } from '@bestie/core';
import { db } from './db';
import type { RemoteClient } from './outbox';

/**
 * Save an order change: the local working copy AND the server writes it needs go in ONE local transaction — so a
 * crash or a lost signal can never leave "saved on screen but never queued". Returns how many writes were queued.
 */
export async function saveOrder(
  prev: OrderDoc | null,
  next: OrderDoc,
  now: () => number = Date.now,
): Promise<number> {
  const ops = diffOrder(prev, next);
  await db.transaction('rw', db.orders, db.outbox, async () => {
    await db.orders.put({
      id: next.id,
      storeId: next.storeId,
      status: next.status,
      businessDate: next.businessDate,
      tableId: next.tableId,
      doc: next,
    });
    let t = now();
    for (const op of ops) {
      // one tick apart: the replay order is the creation order, even inside the same millisecond
      await db.outbox.add({
        id: crypto.randomUUID(),
        op,
        createdAt: t++,
        attempts: 0,
        nextTryAt: 0,
        status: 'pending',
      });
    }
  });
  return ops.length;
}

export async function getOrder(id: string): Promise<OrderDoc | null> {
  return (await db.orders.get(id))?.doc ?? null;
}

/** Orders that are still being served or paid for in this shop, oldest first. */
export async function listOpenOrders(storeId: string): Promise<OrderDoc[]> {
  const rows = await db.orders.where('storeId').equals(storeId).toArray();
  return rows
    .map((r) => r.doc)
    .filter(isOrderOpen)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Next order number for this device today: A001, A002 …  The counter is whatever is already in the local orders
 * (so it cannot repeat after a cache wipe) — two devices can never clash because the code differs per device.
 */
export async function nextOrderNumber(
  storeId: string,
  deviceCode: string,
  now: number = Date.now(),
): Promise<string> {
  const date = bangkokDate(now);
  const rows = await db.orders.where('storeId').equals(storeId).toArray();
  let max = 0;
  for (const r of rows) {
    if (r.businessDate !== date) continue;
    const m = new RegExp(`^${deviceCode}(\\d+)$`).exec(r.doc.number);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return formatOrderNumber(deviceCode, max + 1);
}

export type PullResult = 'skipped' | 'ok';

/**
 * Bring the server's view of the shop's open orders (and today's closed ones) into the working copy. Skipped while
 * something is still waiting to be sent — pulling then could overwrite work the server has not seen yet.
 */
export async function pullOrders(
  client: Pick<RemoteClient, 'from'>,
  storeId: string,
  now: number = Date.now(),
): Promise<PullResult> {
  if ((await db.outbox.where('status').equals('pending').count()) > 0) return 'skipped';
  const today = bangkokDate(now);
  const orders = await client
    .from('orders')
    .select('*')
    .eq('store_id', storeId)
    .or(`status.not.in.(paid,void),business_date.eq.${today}`);
  if (orders.error) throw new Error('pull orders');
  const rows = (orders.data ?? []) as Record<string, unknown>[];
  const ids = rows.map((r) => String(r.id));
  const lines = ids.length
    ? await client.from('order_lines').select('*').in('order_id', ids)
    : { data: [], error: null };
  if (lines.error) throw new Error('pull lines');
  const byOrder = new Map<string, Record<string, unknown>[]>();
  for (const l of (lines.data ?? []) as Record<string, unknown>[]) {
    const k = String(l.order_id);
    byOrder.set(k, [...(byOrder.get(k) ?? []), l]);
  }
  // Something may have been queued while we were reading: then do not overwrite anything.
  if ((await db.outbox.where('status').equals('pending').count()) > 0) return 'skipped';
  const docs = rows.flatMap((r) => {
    const d = rowsToOrder(r, byOrder.get(String(r.id)) ?? []);
    return d ? [d] : [];
  });
  await db.transaction('rw', db.orders, db.outbox, async () => {
    if ((await db.outbox.where('status').equals('pending').count()) > 0) return;
    await db.orders.bulkPut(
      docs.map((doc) => ({
        id: doc.id,
        storeId: doc.storeId,
        status: doc.status,
        businessDate: doc.businessDate,
        tableId: doc.tableId,
        doc,
      })),
    );
  });
  return 'ok';
}

import {
  bangkokDate,
  closePayload,
  diffOrder,
  formatOrderNumber,
  formatReceiptNumber,
  isOrderOpen,
  receiptSeq,
  rowsToOrder,
} from '@bestie/core';
import type { OrderDoc, ReceiptDoc } from '@bestie/core';
import { db } from './db';
import { nextStamp } from './outbox';
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
    for (const op of ops) {
      // strictly after everything already queued: the replay order is the creation order
      await db.outbox.add({
        id: crypto.randomUUID(),
        op,
        createdAt: await nextStamp(now),
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

/**
 * Pay a bill: the paid copy of the order and the ONE server call that closes it (`close_order`) are saved in the same local
 * transaction — a cash payment is final the moment the till shows the receipt, signal or not. The receipt counter moves with it.
 */
export async function payOrder(
  prev: OrderDoc,
  paid: OrderDoc,
  receipt: ReceiptDoc,
  who: { deviceId: string; deviceCode: string; staffId: string | null },
  now: () => number = Date.now,
): Promise<void> {
  const seq = receiptSeq(who.deviceCode, receipt.number);
  if (seq === null) throw new Error('receipt number is not from this device');
  const ops = [
    ...diffOrder(prev, paid),
    {
      kind: 'rpc' as const,
      fn: 'close_order',
      args: { p: closePayload(paid, receipt, { deviceId: who.deviceId, staffId: who.staffId }) },
    },
  ];
  await db.transaction('rw', db.orders, db.outbox, db.counters, async () => {
    await db.orders.put({
      id: paid.id,
      storeId: paid.storeId,
      status: paid.status,
      businessDate: paid.businessDate,
      tableId: paid.tableId,
      doc: paid,
    });
    const key = `receipt:${who.deviceId}`;
    const cur = (await db.counters.get(key))?.value ?? 0;
    await db.counters.put({ key, value: Math.max(cur, seq) });
    for (const op of ops) {
      await db.outbox.add({
        id: crypto.randomUUID(),
        op,
        createdAt: await nextStamp(now),
        attempts: 0,
        nextTryAt: 0,
        status: 'pending',
      });
    }
  });
}

/**
 * Next receipt number of this device's series (A-000001, A-000002 … no gaps, never reused): the highest of the counter
 * kept on the tablet, the receipts already stored here, and whatever the server last saw (`syncReceiptCounter`).
 */
export async function nextReceiptNumber(deviceId: string, deviceCode: string): Promise<string> {
  const counter = (await db.counters.get(`receipt:${deviceId}`))?.value ?? 0;
  let max = counter;
  for (const r of await db.orders.toArray()) {
    const s = r.doc.receipt ? receiptSeq(deviceCode, r.doc.receipt.number) : null;
    if (s !== null) max = Math.max(max, s);
  }
  return formatReceiptNumber(deviceCode, max + 1);
}

/** Raise the local counter to what the server already has for this device (after a reinstall, a wiped tablet …). */
export async function syncReceiptCounter(
  client: Pick<RemoteClient, 'from'>,
  deviceId: string,
  deviceCode: string,
): Promise<void> {
  const r = await client
    .from('receipts')
    .select('number')
    .eq('device_id', deviceId)
    .order('number', { ascending: false })
    .limit(1);
  if (r.error) return; // best effort: the server still refuses a repeated number
  const seq = receiptSeq(
    deviceCode,
    String((r.data as { number?: string }[] | null)?.[0]?.number ?? ''),
  );
  if (seq === null) return;
  const key = `receipt:${deviceId}`;
  const cur = (await db.counters.get(key))?.value ?? 0;
  if (seq > cur) await db.counters.put({ key, value: seq });
}

/** Orders that are still being served or paid for in this shop, oldest first. */
export async function listOpenOrders(storeId: string): Promise<OrderDoc[]> {
  const rows = await db.orders.where('storeId').equals(storeId).toArray();
  return rows
    .map((r) => r.doc)
    .filter(isOrderOpen)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Bills paid on a business day, newest first (for the receipts list and reprints). */
export async function listPaidOrders(storeId: string, businessDate: string): Promise<OrderDoc[]> {
  const rows = await db.orders.where('storeId').equals(storeId).toArray();
  return rows
    .map((r) => r.doc)
    .filter((o) => o.status === 'paid' && o.businessDate === businessDate)
    .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));
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
  // receipts + payments of the bills that are paid (so any tablet can show and reprint them)
  const paidIds = rows.filter((r) => r.status === 'paid').map((r) => String(r.id));
  const receipts = paidIds.length
    ? await client.from('receipts').select('*').in('order_id', paidIds)
    : { data: [], error: null };
  const payments = paidIds.length
    ? await client.from('payments').select('*').in('order_id', paidIds)
    : { data: [], error: null };
  if (receipts.error || payments.error) throw new Error('pull receipts');
  const receiptOf = new Map(
    ((receipts.data ?? []) as Record<string, unknown>[]).map((r) => [String(r.order_id), r]),
  );
  const paysOf = new Map<string, Record<string, unknown>[]>();
  for (const p of (payments.data ?? []) as Record<string, unknown>[]) {
    const k = String(p.order_id);
    paysOf.set(k, [...(paysOf.get(k) ?? []), p]);
  }
  // Something may have been queued while we were reading: then do not overwrite anything.
  if ((await db.outbox.where('status').equals('pending').count()) > 0) return 'skipped';
  const docs = rows.flatMap((r) => {
    const id = String(r.id);
    const d = rowsToOrder(r, byOrder.get(id) ?? [], {
      receipt: receiptOf.get(id) ?? null,
      payments: paysOf.get(id) ?? [],
    });
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

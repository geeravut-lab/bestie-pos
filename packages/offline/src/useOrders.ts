import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import type { OrderDoc } from '@bestie/core';
import { db } from './db';
import { listOpenOrders, listPaidOrders, listShopOrders } from './orderStore';

/** Live view of the shop's open orders from this tablet's working copy (works offline, updates when anything changes). */
export function useOpenOrders(storeId: string | null): OrderDoc[] | undefined {
  const [orders, setOrders] = useState<{ storeId: string | null; list: OrderDoc[] } | undefined>();
  useEffect(() => {
    if (!storeId) return;
    const sub = liveQuery(() => listOpenOrders(storeId)).subscribe({
      next: (list) => setOrders({ storeId, list }),
      error: (e: unknown) =>
        console.error('[orders] read failed', e instanceof Error ? e.message : 'unknown'),
    });
    return () => sub.unsubscribe();
  }, [storeId]);
  return orders && orders.storeId === storeId ? orders.list : undefined;
}

/** One order, live. `undefined` = still reading, `null` = no such order on this tablet. */
export function useOrder(id: string | null): OrderDoc | null | undefined {
  const [state, setState] = useState<{ id: string | null; doc: OrderDoc | null } | undefined>();
  useEffect(() => {
    if (!id) return;
    const sub = liveQuery(async () => (await db.orders.get(id))?.doc ?? null).subscribe({
      next: (doc) => setState({ id, doc }),
      error: (e: unknown) =>
        console.error('[orders] read failed', e instanceof Error ? e.message : 'unknown'),
    });
    return () => sub.unsubscribe();
  }, [id]);
  return state && state.id === id ? state.doc : undefined;
}

/** Bills paid on a business day (newest first), live. */
export function usePaidOrders(
  storeId: string | null,
  businessDate: string,
): OrderDoc[] | undefined {
  const [state, setState] = useState<{ key: string; list: OrderDoc[] } | undefined>();
  const key = `${storeId}|${businessDate}`;
  useEffect(() => {
    if (!storeId) return;
    const sub = liveQuery(() => listPaidOrders(storeId, businessDate)).subscribe({
      next: (list) => setState({ key, list }),
      error: (e: unknown) =>
        console.error('[orders] read failed', e instanceof Error ? e.message : 'unknown'),
    });
    return () => sub.unsubscribe();
  }, [storeId, businessDate, key]);
  return state && state.key === key ? state.list : undefined;
}

/** Open bills + recently paid ones of a shop, live — the source for the kitchen display, the pick-up list and the queue board. */
export function useShopOrders(storeId: string | null, sinceDate: string): OrderDoc[] | undefined {
  const [state, setState] = useState<{ key: string; list: OrderDoc[] } | undefined>();
  const key = `${storeId}|${sinceDate}`;
  useEffect(() => {
    if (!storeId) return;
    const sub = liveQuery(() => listShopOrders(storeId, sinceDate)).subscribe({
      next: (list) => setState({ key, list }),
      error: (e: unknown) =>
        console.error('[orders] read failed', e instanceof Error ? e.message : 'unknown'),
    });
    return () => sub.unsubscribe();
  }, [storeId, sinceDate, key]);
  return state && state.key === key ? state.list : undefined;
}

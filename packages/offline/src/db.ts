import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { OrderDoc, OutboxEntry, ShiftDoc } from '@bestie/core';

export type CacheRow = { key: string; data: unknown; savedAt: number };
export type KvRow = { key: string; value: unknown };
/** The working copy of an order on this tablet (the screens read and change THIS; the outbox carries it to the server). */
export type OrderRow = {
  id: string;
  storeId: string;
  status: string;
  businessDate: string;
  tableId: string | null;
  doc: OrderDoc;
};

/** The device's local store. Names are versioned so a later schema change is a new `version()` block, never an edit. */
class OfflineDb extends Dexie {
  outbox!: Table<OutboxEntry, string>;
  cache!: Table<CacheRow, string>;
  kv!: Table<KvRow, string>;
  orders!: Table<OrderRow, string>;
  /** Numbers that must never go backwards (receipt series). NOT cleared at sign-out. */
  counters!: Table<{ key: string; value: number }, string>;
  shifts!: Table<ShiftDoc, string>;
  constructor() {
    super('bestie-offline');
    this.version(1).stores({
      outbox: 'id, status, createdAt',
      cache: 'key',
      kv: 'key',
    });
    this.version(2).stores({
      outbox: 'id, status, createdAt',
      cache: 'key',
      kv: 'key',
      orders: 'id, storeId, status, businessDate, tableId',
    });
    this.version(3).stores({
      outbox: 'id, status, createdAt',
      cache: 'key',
      kv: 'key',
      orders: 'id, storeId, status, businessDate, tableId',
      counters: 'key',
    });
    this.version(4).stores({
      outbox: 'id, status, createdAt',
      cache: 'key',
      kv: 'key',
      orders: 'id, storeId, status, businessDate, tableId',
      counters: 'key',
      shifts: 'id, deviceId, status',
    });
  }
}

export const db = new OfflineDb();

/** Test helper: wipe everything (a real device never does this except at sign-out of the whole tablet). */
export async function resetOfflineDb(): Promise<void> {
  await Promise.all([
    db.outbox.clear(),
    db.cache.clear(),
    db.kv.clear(),
    db.orders.clear(),
    db.counters.clear(),
    db.shifts.clear(),
  ]);
}

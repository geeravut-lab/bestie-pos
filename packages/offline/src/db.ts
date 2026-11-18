import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { OutboxEntry } from '@bestie/core';

export type CacheRow = { key: string; data: unknown; savedAt: number };
export type KvRow = { key: string; value: unknown };

/** The device's local store. Names are versioned so a later schema change is a new `version()` block, never an edit. */
class OfflineDb extends Dexie {
  outbox!: Table<OutboxEntry, string>;
  cache!: Table<CacheRow, string>;
  kv!: Table<KvRow, string>;
  constructor() {
    super('bestie-offline');
    this.version(1).stores({
      outbox: 'id, status, createdAt',
      cache: 'key',
      kv: 'key',
    });
  }
}

export const db = new OfflineDb();

/** Test helper: wipe everything (a real device never does this except at sign-out of the whole tablet). */
export async function resetOfflineDb(): Promise<void> {
  await Promise.all([db.outbox.clear(), db.cache.clear(), db.kv.clear()]);
}

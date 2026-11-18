import { db } from './db';

/** Last good copy of something read from the server (menu, tables, staff list) so the till works with no signal. */
export async function cachePut(
  key: string,
  data: unknown,
  now: () => number = Date.now,
): Promise<void> {
  try {
    await db.cache.put({ key, data, savedAt: now() });
  } catch {
    /* no IndexedDB (private window, old browser): the app still works online, just not offline */
  }
}

export async function cacheGet<T>(key: string): Promise<{ data: T; savedAt: number } | null> {
  try {
    const row = await db.cache.get(key);
    return row ? { data: row.data as T, savedAt: row.savedAt } : null;
  } catch {
    return null;
  }
}

/** Sign-out of the tablet's account: forget every cached read and every remembered PIN. The unsent-writes queue stays. */
export async function clearDeviceCaches(): Promise<void> {
  try {
    await Promise.all([db.cache.clear(), db.kv.clear()]);
  } catch {
    /* nothing stored */
  }
}

/**
 * Network first, cache as the fallback: returns fresh data when the server answers (and remembers it),
 * the last saved copy when it does not, and throws only when there is neither.
 */
export async function cachedRead<T>(
  key: string,
  load: () => Promise<T>,
): Promise<{ data: T; stale: boolean }> {
  try {
    const data = await load();
    await cachePut(key, data);
    return { data, stale: false };
  } catch (e) {
    const saved = await cacheGet<T>(key);
    if (saved) return { data: saved.data, stale: true };
    throw e;
  }
}

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { liveQuery } from 'dexie';
import { syncState } from '@bestie/core';
import type { SyncState } from '@bestie/core';
import { db } from './db';
import { flush } from './outbox';
import type { RemoteClient } from './outbox';
import { getDeviceBinding, subscribeDeviceBinding } from './deviceBinding';
import type { DeviceBinding } from './deviceBinding';

const subscribeOnline = (cb: () => void) => {
  globalThis.addEventListener?.('online', cb);
  globalThis.addEventListener?.('offline', cb);
  return () => {
    globalThis.removeEventListener?.('online', cb);
    globalThis.removeEventListener?.('offline', cb);
  };
};

/** The browser's own "am I online" flag (it only knows about the network card, so a real send can still fail — the outbox copes). */
export const useOnline = (): boolean =>
  useSyncExternalStore(
    subscribeOnline,
    () => globalThis.navigator?.onLine !== false,
    () => true,
  );

/** Live counts from the local queue (also reacts to changes made in another tab). */
export function useOutboxCounts(): { pending: number; dead: number } {
  const [counts, setCounts] = useState({ pending: 0, dead: 0 });
  useEffect(() => {
    const sub = liveQuery(async () => {
      const all = await db.outbox.toArray();
      return {
        pending: all.filter((e) => e.status === 'pending').length,
        dead: all.filter((e) => e.status === 'dead').length,
      };
    }).subscribe({
      next: setCounts,
      error: (e: unknown) =>
        console.error('[offline] queue read failed', e instanceof Error ? e.message : 'unknown'),
    });
    return () => sub.unsubscribe();
  }, []);
  return counts;
}

const TICK_MS = 20_000;

/**
 * Keeps the queue moving: flush now, whenever the network comes back, when the tab becomes visible, every 20 s while
 * something waits, and shortly after a new write lands. Returns what the sync indicator needs.
 */
export function useOutboxSync(client: RemoteClient | null): {
  state: SyncState;
  online: boolean;
  pending: number;
  dead: number;
  syncNow: () => Promise<void>;
} {
  const online = useOnline();
  const { pending, dead } = useOutboxCounts();
  const [syncing, setSyncing] = useState(false);
  const clientRef = useRef(client);
  useEffect(() => {
    clientRef.current = client;
  }, [client]);

  const syncNow = useMemo(
    () => async () => {
      const c = clientRef.current;
      if (!c || globalThis.navigator?.onLine === false) return;
      setSyncing(true);
      try {
        await flush(c);
      } finally {
        setSyncing(false);
      }
    },
    [],
  );

  // flush when something is waiting and we are online (covers: app start, reconnect, a fresh write)
  useEffect(() => {
    if (!client || !online || pending === 0) return;
    const t = setTimeout(() => void syncNow(), 300);
    return () => clearTimeout(t);
  }, [client, online, pending, syncNow]);

  // keep trying while something waits (retry delays are decided by the queue itself)
  useEffect(() => {
    if (!client || pending === 0) return;
    const i = setInterval(() => void syncNow(), TICK_MS);
    const onVisible = () => document.visibilityState === 'visible' && void syncNow();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(i);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [client, pending, syncNow]);

  return { state: syncState({ online, syncing, pending, dead }), online, pending, dead, syncNow };
}

/** The tablet's device binding, live (changes when someone binds / unbinds, also from another tab). */
export function useDeviceBinding(): DeviceBinding | null {
  const raw = useSyncExternalStore(
    subscribeDeviceBinding,
    () => {
      try {
        return globalThis.localStorage?.getItem('bestie-device') ?? '';
      } catch {
        return '';
      }
    },
    () => '',
  );
  // `raw` only changes when the stored text changes, so the parsed object stays the same between renders
  return useMemo(() => (raw === '' ? null : getDeviceBinding()), [raw]);
}

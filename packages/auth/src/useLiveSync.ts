import { useEffect, useRef } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { LiveSyncController, isUserBusy } from './liveSync';

/**
 * Keep a screen fresh without a manual refresh. Subscribes to PRIVATE Realtime channels (the database decides who may
 * listen); every `ping` triggers `refresh`, which must re-read data with the viewer's own rights.
 * Falls back to polling when the socket is down. Safe to call with an empty topic list.
 */
export function useLiveSync(
  client: SupabaseClient | null,
  topics: readonly string[],
  refresh: () => void | Promise<void>,
): void {
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });
  const key = topics.join('|');

  useEffect(() => {
    if (!client || key === '') return;
    const list = key.split('|');
    const controller = new LiveSyncController({
      refresh: () => refreshRef.current(),
      isBusy: () => isUserBusy(),
    });
    const up = new Set<string>();
    const channels = list.map((topic) =>
      client
        .channel(topic, { config: { private: true } })
        .on('broadcast', { event: 'ping' }, () => controller.ping())
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') up.add(topic);
          else up.delete(topic);
          controller.setConnected(up.size === list.length);
        }),
    );
    const onVisibility = () => controller.setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      controller.dispose();
      for (const ch of channels) void client.removeChannel(ch);
    };
  }, [client, key]);
}

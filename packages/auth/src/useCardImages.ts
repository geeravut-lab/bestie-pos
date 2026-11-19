import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cardImageUrls, parseCardImages } from '@bestie/core';
import { useLiveSync } from './useLiveSync';

/** URLs of the admin-uploaded home-card pictures (`platform_settings.card_images`, readable like the brand). Any failure = none. */
export function useCardImages(
  client: SupabaseClient | null,
  signedIn: boolean,
): Record<string, string> | undefined {
  const [urls, setUrls] = useState<Record<string, string> | undefined>(undefined);
  const load = useCallback(async () => {
    if (!client) return;
    try {
      const { data, error } = await client
        .from('platform_settings')
        .select('card_images')
        .maybeSingle();
      if (!error && data)
        setUrls(cardImageUrls(parseCardImages((data as { card_images?: unknown }).card_images)));
    } catch {
      /* keep what we have */
    }
  }, [client]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial read of an EXTERNAL system; state is set after the await
    void load();
  }, [load]);
  useLiveSync(client, signedIn ? ['platform'] : [], load);
  return urls;
}

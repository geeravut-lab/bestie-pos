import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseBrand } from '@bestie/core';
import type { Brand } from '@bestie/core';
import { useLiveSync } from './useLiveSync';

/**
 * The admin's brand from `platform_settings.brand` (readable before sign-in: the login page needs the logo and the name).
 * Any failure means "defaults" — the brand must never be able to break the app. Updates live via the `platform` topic.
 */
export function useBrand(client: SupabaseClient | null, signedIn: boolean): Brand | undefined {
  const [brand, setBrand] = useState<Brand | undefined>(undefined);

  const load = useCallback(async () => {
    if (!client) return;
    try {
      const { data, error } = await client.from('platform_settings').select('brand').maybeSingle();
      if (!error && data) setBrand(parseBrand((data as { brand?: unknown }).brand));
    } catch {
      /* keep what we have */
    }
  }, [client]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial read of an EXTERNAL system; state is set after the await
    void load();
  }, [load]);

  useLiveSync(client, signedIn ? ['platform'] : [], load);
  return brand;
}

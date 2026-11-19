import { useCallback, useEffect, useState } from 'react';
import { allPrinters, parsePrinters, resolvePrinter } from '@bestie/core';
import type { Printer } from '@bestie/core';
import type { PageContext } from '@bestie/auth';

type Saved = { printers: unknown; default_printer: string | null };
const shopKey = (storeId: string) => `bestie-printers:${storeId}`;
const tabletKey = (storeId: string) => `bestie-printer-choice:${storeId}`;
const read = (k: string): string | null => {
  try {
    return globalThis.localStorage?.getItem(k) ?? null;
  } catch {
    return null;
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v === null) globalThis.localStorage?.removeItem(k);
    else globalThis.localStorage?.setItem(k, v);
  } catch {
    /* private mode: the choice just does not stick */
  }
};

/**
 * The shop's printers (data), the shop default and THIS tablet's own choice. The shop's list is kept on the tablet after every good
 * read so a till opened with no signal still knows its printers. With nothing set up everything resolves to the PDF.
 */
export function usePrinters(ctx: PageContext, storeId: string | null) {
  const [saved, setSaved] = useState<Saved | null>(() => {
    const raw = storeId ? read(shopKey(storeId)) : null;
    try {
      return raw ? (JSON.parse(raw) as Saved) : null;
    } catch {
      return null;
    }
  });
  const [tablet, setTablet] = useState<string | null>(() =>
    storeId ? read(tabletKey(storeId)) : null,
  );
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!storeId) return;
    try {
      const r = await ctx.client
        .from('stores')
        .select('printers, default_printer')
        .eq('id', storeId)
        .maybeSingle();
      if (r.error || !r.data) return;
      const row = r.data as unknown as Saved;
      const next: Saved = { printers: row.printers, default_printer: row.default_printer ?? null };
      write(shopKey(storeId), JSON.stringify(next));
      setSaved(next);
    } catch {
      /* offline: keep the last good copy */
    } finally {
      setLoaded(true);
    }
  }, [ctx.client, storeId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async read of an EXTERNAL system (the database); state is set after the await
    void reload();
  }, [reload]);

  const custom = parsePrinters(saved?.printers);
  const shopDefault = saved?.default_printer ?? null;
  const current: Printer = resolvePrinter(custom, tablet, shopDefault);
  const chooseForTablet = useCallback(
    (id: string | null) => {
      if (storeId) write(tabletKey(storeId), id);
      setTablet(id);
    },
    [storeId],
  );
  return {
    custom,
    all: allPrinters(custom),
    shopDefault,
    tablet,
    current,
    chooseForTablet,
    reload,
    loaded,
  };
}

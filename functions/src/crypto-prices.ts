/**
 * USDT/THB reference prices for the crypto top-up request. Two independent PUBLIC sources; they must agree within 1.5 %
 * (core `lockRate`) or no request is issued. Only prices are read here: no exchange trading or payment API is ever used
 * (SEC notification 5/2565 — see docs/CRYPTO_TRANSFER_KNOWLEDGE.md). ⚠️ The URLs and response shapes below must be checked
 * against the live services before the module is switched on; each source can be replaced through the env variables.
 */
export type PriceQuote = { name: string; satangPerUsdt: number; at: string };
export type PriceSource = { name: string; fetch: (f: typeof fetch) => Promise<number> };

const toSatang = (thbPerUsdt: unknown): number => {
  const n = typeof thbPerUsdt === 'string' ? Number(thbPerUsdt) : thbPerUsdt;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 5 || n > 200)
    throw new Error('implausible price');
  return Math.round(n * 100);
};

const getJson = async (f: typeof fetch, url: string): Promise<unknown> => {
  const res = await f(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`price source answered ${res.status}`);
  return res.json();
};

/** CoinGecko public API (no key for low volume). */
export const coingecko = (env: Record<string, string | undefined> = {}): PriceSource => ({
  name: 'coingecko',
  fetch: async (f) => {
    const url =
      env.PRICE_URL_COINGECKO ??
      'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=thb';
    const j = (await getJson(f, url)) as { tether?: { thb?: unknown } };
    return toSatang(j.tether?.thb);
  },
});

/**
 * A Thai exchange's PUBLIC ticker, read for the price only. The URL is configuration (PRICE_URL_THAI_TICKER) because the
 * exchange's public API versions change; the parser accepts the shapes `{ "THB_USDT": { "last": n } }`, `{ "last": n }`
 * and `{ "result": [{ "last": n }] }`.
 */
export const thaiTicker = (env: Record<string, string | undefined> = {}): PriceSource => ({
  name: 'thai-ticker',
  fetch: async (f) => {
    const url =
      env.PRICE_URL_THAI_TICKER ?? 'https://api.bitkub.com/api/market/ticker?sym=THB_USDT';
    const j = (await getJson(f, url)) as Record<string, unknown>;
    const direct =
      (j.THB_USDT as { last?: unknown } | undefined)?.last ??
      j.last ??
      (j.result as { last?: unknown }[] | undefined)?.[0]?.last;
    return toSatang(direct);
  },
});

/** Reads every source; a source that fails is skipped. The caller needs two answers. */
export async function readPrices(
  sources: readonly PriceSource[],
  f: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<PriceQuote[]> {
  const settled = await Promise.allSettled(sources.map((s) => s.fetch(f)));
  const out: PriceQuote[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled')
      out.push({ name: sources[i]!.name, satangPerUsdt: r.value, at: now().toISOString() });
  });
  return out;
}

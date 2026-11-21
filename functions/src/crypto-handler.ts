// Vercel Functions for the crypto top-up of Bestie Credit (module `credit.topup.crypto`, legally gated, off by default).
//   POST /api/crypto/request   staff asks for a payment request (checks, two prices, locked rate, unique amount)
//   POST /api/crypto/check     staff asks for a look at the chain NOW for their request's wallet
//   GET|POST /api/crypto/poll  scheduled watcher (Vercel Cron, CRON_SECRET)
// Nothing here can send money or hold a key. Credit is added by the database function when a transfer is final.
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  CRYPTO_NETWORKS,
  REQUEST_TTL_MS,
  baseUnits,
  formatUnits,
  isCryptoNetwork,
  lockRate,
  paymentQrValue,
  pickSuffix,
} from '../../packages/core/src/crypto.js';
import type { CryptoNetwork } from '../../packages/core/src/crypto.js';
import { readServerEnv } from './env.js';
import { createRateLimiter } from './line.js';
import { ethereumClient, tronClient } from './crypto-chain.js';
import type { ChainClient } from './crypto-chain.js';
import { coingecko, readPrices, thaiTicker } from './crypto-prices.js';
import type { PriceSource } from './crypto-prices.js';

type Env = Record<string, string | undefined>;
const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CryptoDeps = {
  fetchImpl?: typeof fetch;
  prices?: PriceSource[];
  chain?: Partial<Record<CryptoNetwork, ChainClient>>;
  now?: () => number;
};

const allowRequest = createRateLimiter(10, 60_000);
const allowCheck = createRateLimiter(6, 60_000);

type Rpc = { ok: boolean; status: number; code: string | null; data: unknown };
async function rpc(
  f: typeof fetch,
  env: { url: string; apikey: string; bearer: string },
  fn: string,
  args: Record<string, unknown>,
): Promise<Rpc> {
  const res = await f(`${env.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: env.apikey,
      Authorization: `Bearer ${env.bearer}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const data: unknown = await res.json().catch(() => null);
  const code =
    !res.ok && data && typeof data === 'object'
      ? String((data as { code?: unknown }).code ?? '')
      : null;
  return { ok: res.ok, status: res.status, code, data };
}

async function select<T>(
  f: typeof fetch,
  url: string,
  key: string,
  bearer: string,
  path: string,
): Promise<T[]> {
  const res = await f(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${bearer}` },
  });
  return res.ok ? ((await res.json()) as T[]) : [];
}

async function userOf(request: Request, url: string, key: string, f: typeof fetch) {
  const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!token) return null;
  try {
    const res = await f(`${url}/auth/v1/user`, {
      headers: { apikey: key, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const u = (await res.json()) as { id?: string };
    return typeof u.id === 'string' ? { token, userId: u.id } : null;
  } catch {
    return null;
  }
}
const anonKey = (env: Env): string | undefined =>
  (env.SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_ANON_KEY)?.trim();

const refusal = (problem: unknown): Response =>
  reply({ error: 'refused', problem: typeof problem === 'string' ? problem : 'refused' }, 422);

/** POST /api/crypto/request { store_id, customer_id, network, thb (satang) } */
export async function cryptoRequestResponse(
  request: Request,
  env: Env = process.env,
  deps: CryptoDeps = {},
): Promise<Response> {
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
  const f = deps.fetchImpl ?? fetch;
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const who = await userOf(request, supabaseUrl, serviceRoleKey, f);
    if (!who) return reply({ error: 'forbidden' }, 403);
    if (!allowRequest(`req:${who.userId}`)) return reply({ error: 'rate_limited' }, 429);
    const b = (await request.json().catch(() => null)) as {
      store_id?: unknown;
      customer_id?: unknown;
      network?: unknown;
      thb?: unknown;
    } | null;
    if (
      !b ||
      typeof b.store_id !== 'string' ||
      !UUID.test(b.store_id) ||
      typeof b.customer_id !== 'string' ||
      !UUID.test(b.customer_id) ||
      !isCryptoNetwork(b.network) ||
      typeof b.thb !== 'number' ||
      !Number.isSafeInteger(b.thb) ||
      b.thb <= 0
    )
      return reply({ error: 'invalid' }, 422);

    const asUser = { url: supabaseUrl, apikey: anonKey(env) ?? serviceRoleKey, bearer: who.token };
    const svc = { url: supabaseUrl, apikey: serviceRoleKey, bearer: serviceRoleKey };
    const pre = await rpc(f, asUser, 'crypto_request_precheck', {
      p: { store_id: b.store_id, customer_id: b.customer_id, network: b.network, thb: b.thb },
    });
    if (!pre.ok)
      return pre.code === '42501'
        ? reply({ error: 'forbidden' }, 403)
        : reply({ error: 'server_error' }, 502);
    const chk = pre.data as {
      ok?: boolean;
      problem?: string;
      address?: string;
      taken_suffixes?: number[];
      staff_id?: string | null;
    };
    if (!chk.ok || !chk.address) return refusal(chk.problem);

    // two independent reference prices that must agree
    const quotes = await readPrices(deps.prices ?? [coingecko(env), thaiTicker(env)], f);
    if (quotes.length < 2) return reply({ error: 'prices_unavailable' }, 503);
    const lock = lockRate(quotes[0]!.satangPerUsdt, quotes[1]!.satangPerUsdt);
    if (!lock.ok) return reply({ error: lock.reason }, 422);

    const taken = new Set<number>(Array.isArray(chk.taken_suffixes) ? chk.taken_suffixes : []);
    const now = (deps.now ?? Date.now)();
    for (let attempt = 0; attempt < 4; attempt++) {
      const suffix = pickSuffix(taken, now + attempt * 37);
      if (suffix === null) return reply({ error: 'busy' }, 429);
      const units = baseUnits(b.thb, lock.rate) + suffix;
      const made = await rpc(f, svc, 'crypto_create_request', {
        p: {
          store_id: b.store_id,
          customer_id: b.customer_id,
          network: b.network,
          thb: b.thb,
          rate: lock.rate,
          rate_sources: Object.fromEntries(
            quotes.map((q, i) => [
              i === 0 ? 'a' : 'b',
              { name: q.name, price: q.satangPerUsdt, at: q.at },
            ]),
          ),
          amount_units: units,
          staff_id: chk.staff_id ?? null,
        },
      });
      if (made.ok) {
        const row = made.data as { id: string; address: string; expires_at: string };
        const net = CRYPTO_NETWORKS[b.network];
        return reply({
          request_id: row.id,
          network: b.network,
          token_label: net.tokenLabel,
          address: row.address,
          units,
          units_text: formatUnits(units),
          thb: b.thb,
          rate: lock.rate,
          expires_at: row.expires_at,
          qr: paymentQrValue({ network: b.network, address: row.address, units }),
          ttl_ms: REQUEST_TTL_MS,
        });
      }
      if (made.code === '23505') {
        taken.add(units % 1000);
        continue;
      }
      return made.code === '23514' ? refusal('refused') : reply({ error: 'server_error' }, 502);
    }
    return reply({ error: 'busy' }, 429);
  } catch {
    return reply({ error: 'server_error' }, 502);
  }
}

// ── the watcher ─────────────────────────────────────────────────────────────
type WalletRow = { id: string; network: CryptoNetwork; address: string; poll_cursor_ms: number };

export function chainFor(
  env: Env,
  deps: CryptoDeps,
  network: CryptoNetwork,
  f: typeof fetch,
): ChainClient | null {
  const given = deps.chain?.[network];
  if (given) return given;
  // an optional base address lets the SAME code run against a test network (Tron Shasta / Ethereum Sepolia); https only
  const https = (v?: string) =>
    v && /^https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9._/-]*)?$/i.test(v.trim())
      ? v.trim().replace(/\/+$/, '')
      : undefined;
  if (network === 'tron')
    return tronClient({
      apiKey: env.TRONGRID_API_KEY?.trim(),
      baseUrl: https(env.TRONGRID_BASE_URL),
      f,
    });
  const key = env.ETHERSCAN_API_KEY?.trim();
  const chainId = Number(env.ETHERSCAN_CHAIN_ID);
  return key
    ? ethereumClient({
        apiKey: key,
        baseUrl: https(env.ETHERSCAN_BASE_URL),
        chainId: Number.isInteger(chainId) && chainId > 0 ? chainId : undefined,
        f,
      })
    : null;
}

/** Reads one wallet's incoming transfers and reports each to the database; returns what happened. */
export async function pollWallet(
  w: WalletRow,
  env: Env,
  deps: CryptoDeps,
  svc: { url: string; apikey: string; bearer: string },
): Promise<{ read: number; credited: number; review: number; error?: string }> {
  const f = deps.fetchImpl ?? fetch;
  const client = chainFor(env, deps, w.network, f);
  if (!client) return { read: 0, credited: 0, review: 0, error: 'not_configured' };
  const net = CRYPTO_NETWORKS[w.network];
  const now = (deps.now ?? Date.now)();
  const since = w.poll_cursor_ms > 0 ? w.poll_cursor_ms : now - 2 * 86_400_000;
  let transfers;
  try {
    transfers = await client.incoming({
      address: w.address,
      contract: net.contract,
      sinceMs: since,
    });
  } catch {
    return { read: 0, credited: 0, review: 0, error: 'provider_error' };
  }
  let credited = 0;
  let review = 0;
  for (const t of transfers) {
    const r = await rpc(f, svc, 'crypto_record_transfer', {
      p: {
        network: t.network,
        tx_hash: t.txHash,
        log_index: t.logIndex,
        from: t.from,
        to: t.to,
        units: t.units,
        block_time: new Date(t.blockTimeMs || now).toISOString(),
        confirmations: t.confirmations,
        success: t.success,
      },
    });
    const status = (r.data as { status?: string } | null)?.status;
    if (status === 'credited') credited += 1;
    if (status === 'review') review += 1;
  }
  // the cursor stays just before the oldest transfer that is not final yet, so it is read again next time
  const pending = transfers.filter((t) => t.confirmations < net.confirmations);
  const next = pending.length
    ? Math.min(...pending.map((t) => t.blockTimeMs)) - 1
    : Math.max(since, ...transfers.map((t) => t.blockTimeMs));
  if (next > w.poll_cursor_ms)
    await rpc(f, svc, 'crypto_set_cursor', { p_wallet: w.id, p_ms: next });
  return { read: transfers.length, credited, review };
}

const sameSecret = (a: string, b: string): boolean => {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
};

/** Vercel Cron: `Authorization: Bearer <CRON_SECRET>`. */
export async function cryptoPollResponse(
  request: Request,
  env: Env = process.env,
  deps: CryptoDeps = {},
): Promise<Response> {
  const secret = env.CRON_SECRET?.trim();
  const given = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
  if (!secret || !sameSecret(given, secret)) return reply({ error: 'forbidden' }, 403);
  const f = deps.fetchImpl ?? fetch;
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const svc = { url: supabaseUrl, apikey: serviceRoleKey, bearer: serviceRoleKey };
    const wallets = await select<WalletRow>(
      f,
      supabaseUrl,
      serviceRoleKey,
      serviceRoleKey,
      'crypto_wallets?active=eq.true&select=id,network,address,poll_cursor_ms',
    );
    const results = [];
    for (const w of wallets) results.push(await pollWallet(w, env, deps, svc));
    const expired = await rpc(f, svc, 'crypto_expire_requests', {});
    return reply({
      wallets: wallets.length,
      results,
      expired: typeof expired.data === 'number' ? expired.data : 0,
    });
  } catch {
    return reply({ error: 'server_error' }, 502);
  }
}

/** POST /api/crypto/check { request_id } — a person looks at the chain now (rate limited). */
export async function cryptoCheckResponse(
  request: Request,
  env: Env = process.env,
  deps: CryptoDeps = {},
): Promise<Response> {
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
  const f = deps.fetchImpl ?? fetch;
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const who = await userOf(request, supabaseUrl, serviceRoleKey, f);
    if (!who) return reply({ error: 'forbidden' }, 403);
    if (!allowCheck(`check:${who.userId}`)) return reply({ error: 'rate_limited' }, 429);
    const b = (await request.json().catch(() => null)) as { request_id?: unknown } | null;
    if (typeof b?.request_id !== 'string' || !UUID.test(b.request_id))
      return reply({ error: 'invalid' }, 422);
    // RLS decides whether this person may see the request at all
    const key = anonKey(env) ?? serviceRoleKey;
    const rows = await select<{ wallet_id: string; status: string }>(
      f,
      supabaseUrl,
      key,
      who.token,
      `crypto_requests?id=eq.${b.request_id}&select=wallet_id,status`,
    );
    const row = rows[0];
    if (!row) return reply({ error: 'not_found' }, 404);
    const wallets = await select<WalletRow>(
      f,
      supabaseUrl,
      serviceRoleKey,
      serviceRoleKey,
      `crypto_wallets?id=eq.${row.wallet_id}&select=id,network,address,poll_cursor_ms`,
    );
    if (!wallets[0]) return reply({ error: 'not_found' }, 404);
    const res = await pollWallet(wallets[0], env, deps, {
      url: supabaseUrl,
      apikey: serviceRoleKey,
      bearer: serviceRoleKey,
    });
    return reply({ status: row.status, ...res });
  } catch {
    return reply({ error: 'server_error' }, 502);
  }
}

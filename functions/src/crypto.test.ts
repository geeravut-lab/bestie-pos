import { describe, expect, it, vi } from 'vitest';
import {
  cryptoCheckResponse,
  cryptoPollResponse,
  cryptoRequestResponse,
  pollWallet,
} from './crypto-handler.js';
import { coingecko, readPrices, thaiTicker } from './crypto-prices.js';
import { ethereumClient, tronClient } from './crypto-chain.js';
import type { ChainClient } from './crypto-chain.js';

const env = {
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'svc',
  SUPABASE_ANON_KEY: 'anon',
  CRON_SECRET: 'cron-secret-123',
};
const STORE = '10000000-0000-4000-8000-000000000001';
const CUST = '20000000-0000-4000-8000-000000000002';
const REQ = '30000000-0000-4000-8000-000000000003';
const ADDR = 'T' + 'A'.repeat(33);
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function fakeFetch(h: Record<string, Handler>) {
  const calls: { key: string; body: unknown }[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const key = u.includes('/rpc/')
      ? u.split('/rpc/')[1]!
      : u.includes('/auth/v1/user')
        ? 'auth'
        : u.replace('https://x.supabase.co/rest/v1/', 'select:');
    calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : null });
    const handler = h[key] ?? Object.entries(h).find(([k]) => key.startsWith(k))?.[1];
    return handler ? handler(u, init) : json(null, 404);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const post = (body: unknown, token = 'user-jwt') =>
  new Request('https://app.test/api/crypto/request', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
const ask = { store_id: STORE, customer_id: CUST, network: 'tron', thb: 100_000 };
const okPre = { ok: true, address: ADDR, taken_suffixes: [], staff_id: 'staff-1', tier: 'T1' };
const prices = (a: number, b: number) => [
  { name: 'a', fetch: async () => a },
  { name: 'b', fetch: async () => b },
];

describe('POST /api/crypto/request', () => {
  const base = (over: Record<string, Handler> = {}) =>
    fakeFetch({
      auth: () => json({ id: 'u1' }),
      crypto_request_precheck: () => json(okPre),
      crypto_create_request: () =>
        json({ id: REQ, address: ADDR, expires_at: '2026-11-18T10:15:00Z' }),
      ...over,
    });

  it('needs a signed-in person and a valid body', async () => {
    const { f } = fakeFetch({ auth: () => json(null, 401) });
    expect((await cryptoRequestResponse(post(ask), env, { fetchImpl: f })).status).toBe(403);
    const ok = base();
    expect(
      (await cryptoRequestResponse(post({ ...ask, thb: 1.5 }), env, { fetchImpl: ok.f })).status,
    ).toBe(422);
    expect(
      (await cryptoRequestResponse(post({ ...ask, network: 'bitcoin' }), env, { fetchImpl: ok.f }))
        .status,
    ).toBe(422);
    expect(
      (await cryptoRequestResponse(post({ ...ask, store_id: 'x' }), env, { fetchImpl: ok.f }))
        .status,
    ).toBe(422);
  });

  it('issues a request: locked LOWER rate, exact USDT amount with a unique suffix, QR text, 15 minutes', async () => {
    const { f, calls } = base();
    const r = await cryptoRequestResponse(post(ask), env, {
      fetchImpl: f,
      prices: prices(3662, 3650),
      now: () => 40,
    });
    const body = (await r.json()) as Record<string, unknown>;
    expect(r.status).toBe(200);
    expect(body).toMatchObject({
      request_id: REQ,
      network: 'tron',
      token_label: 'USDT on TRON (TRC-20)',
      address: ADDR,
      rate: 3650,
      thb: 100_000,
      qr: ADDR,
    });
    // 1,000 THB / 36.50 = 27.40 USDT + a suffix 1…999 micro-units
    expect(String(body.units_text)).toMatch(/^27\.400\d{3}$/);
    const created = calls.find((c) => c.key === 'crypto_create_request')!.body as {
      p: Record<string, unknown>;
    };
    expect(created.p.rate).toBe(3650);
    expect((created.p.amount_units as number) % 1000).not.toBe(0);
    expect(Object.keys(created.p.rate_sources as object)).toEqual(['a', 'b']);
  });

  it('the pre-check (as the signed-in person) decides: its refusal is passed on and nothing is created', async () => {
    const { f, calls } = base({
      crypto_request_precheck: () => json({ ok: false, problem: 'kyc_required' }),
    });
    const r = await cryptoRequestResponse(post(ask), env, {
      fetchImpl: f,
      prices: prices(3650, 3650),
    });
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: 'refused', problem: 'kyc_required' });
    expect(calls.some((c) => c.key === 'crypto_create_request')).toBe(false);
  });

  it('a person without the right is refused (403) — the check runs with THEIR token, not ours', async () => {
    const { f } = base({
      crypto_request_precheck: () => json({ code: '42501', message: 'x' }, 403),
    });
    expect(
      (await cryptoRequestResponse(post(ask), env, { fetchImpl: f, prices: prices(3650, 3650) }))
        .status,
    ).toBe(403);
    const seen: string[] = [];
    const spy = fakeFetch({
      auth: () => json({ id: 'u1' }),
      crypto_request_precheck: (_u, init) => {
        seen.push(String((init?.headers as Record<string, string>).Authorization));
        return json(okPre);
      },
      crypto_create_request: (_u, init) => {
        seen.push(String((init?.headers as Record<string, string>).Authorization));
        return json({ id: REQ, address: ADDR, expires_at: 'x' });
      },
    });
    await cryptoRequestResponse(post(ask), env, { fetchImpl: spy.f, prices: prices(3650, 3650) });
    expect(seen).toEqual(['Bearer user-jwt', 'Bearer svc']);
  });

  it('no request when the two prices disagree by more than 1.5 %, or only one source answers', async () => {
    const { f, calls } = base();
    const r = await cryptoRequestResponse(post(ask), env, {
      fetchImpl: f,
      prices: prices(3650, 3720),
    });
    expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([
      422,
      'rates_disagree',
    ]);
    const one = await cryptoRequestResponse(post(ask), env, {
      fetchImpl: f,
      prices: [
        { name: 'a', fetch: async () => 3650 },
        {
          name: 'b',
          fetch: async () => {
            throw new Error('down');
          },
        },
      ],
    });
    expect([one.status, ((await one.json()) as { error: string }).error]).toEqual([
      503,
      'prices_unavailable',
    ]);
    expect(calls.some((c) => c.key === 'crypto_create_request')).toBe(false);
  });

  it('picks another suffix when the amount is already taken', async () => {
    let n = 0;
    const { f, calls } = base({
      crypto_create_request: () =>
        ++n === 1
          ? json({ code: '23505', message: 'dup' }, 409)
          : json({ id: REQ, address: ADDR, expires_at: 'x' }),
    });
    const r = await cryptoRequestResponse(post(ask), env, {
      fetchImpl: f,
      prices: prices(3650, 3650),
      now: () => 7,
    });
    expect(r.status).toBe(200);
    const sent = calls
      .filter((c) => c.key === 'crypto_create_request')
      .map((c) => (c.body as { p: { amount_units: number } }).p.amount_units);
    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toBe(sent[1]);
  });
});

describe('price sources', () => {
  const f = (map: Record<string, unknown>) =>
    (async (url: string | URL | Request) => {
      const body = Object.entries(map).find(([k]) => String(url).includes(k))?.[1];
      return body === undefined ? json(null, 500) : json(body);
    }) as unknown as typeof fetch;
  it('reads CoinGecko and a Thai exchange ticker in satang, ignores nonsense', async () => {
    expect(await coingecko().fetch(f({ coingecko: { tether: { thb: 36.51 } } }))).toBe(3651);
    expect(await thaiTicker().fetch(f({ bitkub: { THB_USDT: { last: 36.6 } } }))).toBe(3660);
    expect(
      await thaiTicker({ PRICE_URL_THAI_TICKER: 'https://t.test/x' }).fetch(
        f({ 't.test': { last: '36.2' } }),
      ),
    ).toBe(3620);
    await expect(coingecko().fetch(f({ coingecko: { tether: { thb: 0.5 } } }))).rejects.toThrow();
  });
  it('a source that fails is skipped', async () => {
    const q = await readPrices(
      [
        { name: 'a', fetch: async () => 3650 },
        {
          name: 'b',
          fetch: async () => {
            throw new Error('x');
          },
        },
      ],
      fetch,
      () => new Date('2026-11-18T00:00:00Z'),
    );
    expect(q).toEqual([{ name: 'a', satangPerUsdt: 3650, at: '2026-11-18T00:00:00.000Z' }]);
  });
});

describe('chain clients (fake provider answers)', () => {
  it('Tron: a transfer found by the solidity node is final (20), otherwise 0', async () => {
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/transactions/trc20')) {
        expect(u).toContain('only_to=true');
        expect((init?.headers as Record<string, string>)['TRON-PRO-API-KEY']).toBe('k');
        return json({
          data: [
            {
              transaction_id: 'txfinal0001',
              from: 'TFrom',
              to: ADDR,
              value: '27400317',
              block_timestamp: 1000,
            },
            {
              transaction_id: 'txfresh0002',
              from: 'TFrom',
              to: ADDR,
              value: '5000000',
              block_timestamp: 2000,
            },
            {
              transaction_id: 'txother0003',
              from: 'TFrom',
              to: 'TSomeoneElse',
              value: '1',
              block_timestamp: 3000,
            },
          ],
        });
      }
      const id = JSON.parse(String(init?.body)).value as string;
      return json(id === 'txfinal0001' ? { blockNumber: 99, receipt: { result: 'SUCCESS' } } : {});
    }) as unknown as typeof fetch;
    const out = await tronClient({ apiKey: 'k', f }).incoming({
      address: ADDR,
      contract: 'C',
      sinceMs: 0,
    });
    expect(out.map((t) => [t.txHash, t.confirmations, t.units, t.success])).toEqual([
      ['txfinal0001', 20, 27_400_317, true],
      ['txfresh0002', 0, 5_000_000, true],
    ]);
  });
  it("Ethereum: uses the provider's own confirmation count and only transfers INTO our address", async () => {
    const mine = '0x' + '1'.repeat(40);
    const f = (async () =>
      json({
        status: '1',
        result: [
          {
            hash: '0xaaaaaaaaaa',
            from: '0x' + '2'.repeat(40),
            to: mine.toUpperCase().replace('0X', '0x'),
            value: '27400317',
            timeStamp: '1700000000',
            confirmations: '14',
            transactionIndex: '3',
          },
          {
            hash: '0xbbbbbbbbbb',
            from: mine,
            to: '0x' + '3'.repeat(40),
            value: '1000000',
            timeStamp: '1700000001',
            confirmations: '99',
            transactionIndex: '1',
          },
        ],
      })) as unknown as typeof fetch;
    const out = await ethereumClient({ apiKey: 'e', f }).incoming({
      address: mine,
      contract: 'C',
      sinceMs: 0,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      txHash: '0xaaaaaaaaaa',
      confirmations: 14,
      units: 27_400_317,
      logIndex: 3,
      blockTimeMs: 1_700_000_000_000,
    });
  });
});

describe('the watcher', () => {
  const wallet = { id: 'w1', network: 'tron' as const, address: ADDR, poll_cursor_ms: 0 };
  const chain = (list: ReturnType<ChainClient['incoming']>): ChainClient => ({
    incoming: async () => list,
  });
  const tx = (hash: string, conf: number, ms: number) => ({
    network: 'tron' as const,
    txHash: hash,
    logIndex: 0,
    from: 'TF',
    to: ADDR,
    units: 27_400_317,
    blockTimeMs: ms,
    confirmations: conf,
    success: true,
  });

  it('reports each transfer, counts credits, and moves the cursor only past FINAL transfers', async () => {
    const { f, calls } = fakeFetch({
      crypto_record_transfer: (_u, init) =>
        json({
          status: JSON.parse(String(init?.body)).p.confirmations >= 20 ? 'credited' : 'matched',
        }),
      crypto_set_cursor: () => json(null),
    });
    const res = await pollWallet(
      wallet,
      env,
      {
        fetchImpl: f,
        chain: {
          tron: chain(Promise.resolve([tx('txaaaaaaaa01', 20, 5000), tx('txbbbbbbbb02', 3, 9000)])),
        },
        now: () => 100_000,
      },
      { url: 'https://x.supabase.co', apikey: 'svc', bearer: 'svc' },
    );
    expect(res).toEqual({ read: 2, credited: 1, review: 0 });
    const cursor = calls.find((c) => c.key === 'crypto_set_cursor')!.body as { p_ms: number };
    expect(cursor.p_ms).toBe(8999); // just before the unfinished transfer, so it is read again next time
  });
  it('a provider that is down is reported, nothing is lost', async () => {
    const { f } = fakeFetch({});
    const res = await pollWallet(
      wallet,
      env,
      {
        fetchImpl: f,
        chain: {
          tron: {
            incoming: async () => {
              throw new Error('down');
            },
          },
        },
      },
      { url: 'u', apikey: 'k', bearer: 'k' },
    );
    expect(res.error).toBe('provider_error');
  });
  it('Ethereum without an Etherscan key is "not configured", not a crash', async () => {
    const { f } = fakeFetch({});
    const res = await pollWallet(
      { ...wallet, network: 'ethereum' },
      { ...env },
      { fetchImpl: f },
      { url: 'u', apikey: 'k', bearer: 'k' },
    );
    expect(res.error).toBe('not_configured');
  });
});

describe('cron and check endpoints', () => {
  it('the cron route needs the secret (constant-time compare)', async () => {
    const { f } = fakeFetch({});
    for (const auth of [undefined, 'Bearer wrong', 'Bearer cron-secret-12']) {
      const r = await cryptoPollResponse(
        new Request('https://app.test/api/crypto/poll', {
          headers: auth ? { authorization: auth } : {},
        }),
        env,
        { fetchImpl: f },
      );
      expect(r.status).toBe(403);
    }
    expect(
      (
        await cryptoPollResponse(
          new Request('https://app.test/api/crypto/poll'),
          { ...env, CRON_SECRET: '' },
          { fetchImpl: f },
        )
      ).status,
    ).toBe(403);
  });
  it('the cron route polls every active wallet and expires old requests', async () => {
    const { f, calls } = fakeFetch({
      'select:crypto_wallets': () =>
        json([{ id: 'w1', network: 'tron', address: ADDR, poll_cursor_ms: 0 }]),
      crypto_expire_requests: () => json(2),
      crypto_record_transfer: () => json({ status: 'credited' }),
      crypto_set_cursor: () => json(null),
    });
    const r = await cryptoPollResponse(
      new Request('https://app.test/api/crypto/poll', {
        headers: { authorization: 'Bearer cron-secret-123' },
      }),
      env,
      {
        fetchImpl: f,
        chain: {
          tron: {
            incoming: async () => [
              {
                network: 'tron',
                txHash: 'txaaaaaaaa01',
                logIndex: 0,
                from: 'TF',
                to: ADDR,
                units: 1,
                blockTimeMs: 1,
                confirmations: 20,
                success: true,
              },
            ],
          },
        },
      },
    );
    expect(await r.json()).toMatchObject({
      wallets: 1,
      expired: 2,
      results: [{ read: 1, credited: 1 }],
    });
    expect(calls.some((c) => c.key === 'crypto_expire_requests')).toBe(true);
  });
  it('"check now" reads the request with the person\'s own token (RLS), then polls that wallet', async () => {
    const seen: string[] = [];
    const { f } = fakeFetch({
      auth: () => json({ id: 'u1' }),
      'select:crypto_requests': (_u, init) => {
        seen.push(String((init?.headers as Record<string, string>).Authorization));
        return json([{ wallet_id: 'w1', status: 'open' }]);
      },
      'select:crypto_wallets': () =>
        json([{ id: 'w1', network: 'tron', address: ADDR, poll_cursor_ms: 0 }]),
      crypto_record_transfer: () => json({ status: 'matched' }),
      crypto_set_cursor: () => json(null),
    });
    const r = await cryptoCheckResponse(
      new Request('https://app.test/api/crypto/check', {
        method: 'POST',
        headers: { authorization: 'Bearer user-jwt' },
        body: JSON.stringify({ request_id: REQ }),
      }),
      env,
      { fetchImpl: f, chain: { tron: { incoming: async () => [] } } },
    );
    expect(await r.json()).toMatchObject({ status: 'open', read: 0 });
    expect(seen[0]).toBe('Bearer user-jwt');
  });
  it('"check now" 404s for a request the person cannot see', async () => {
    const { f } = fakeFetch({
      auth: () => json({ id: 'u1' }),
      'select:crypto_requests': () => json([]),
    });
    const r = await cryptoCheckResponse(
      new Request('https://app.test/api/crypto/check', {
        method: 'POST',
        headers: { authorization: 'Bearer user-jwt' },
        body: JSON.stringify({ request_id: REQ }),
      }),
      env,
      { fetchImpl: f },
    );
    expect(r.status).toBe(404);
  });
});

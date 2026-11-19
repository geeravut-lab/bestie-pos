import { describe, expect, it, vi } from 'vitest';
import { askShopResponse } from './ask-shop-handler.js';
import type { ProviderAdapter } from './ai-adapters.js';

const STORE = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const env = {
  SUPABASE_URL: 'https://x.supabase.co',
  VITE_SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'svc',
  ANTHROPIC_API_KEY: 'k',
};
const NOW = Date.parse('2026-11-19T05:00:00Z');
const adapter = (text: string): ProviderAdapter => ({
  id: 'anthropic',
  call: vi.fn(async () => ({
    text,
    provider: 'anthropic' as const,
    model: 'm',
    usage: { inputTokens: 5, outputTokens: 7 },
  })),
});
const report = (payable: number, bills: number, from = '2026-11-13', to = '2026-11-19') => ({
  range: { from, to },
  totals: {
    bills,
    subtotal: payable,
    service_charge: 0,
    vat: 0,
    rounding: 0,
    payable,
    average: bills ? Math.round(payable / bills) : 0,
  },
  by_day: [],
  by_hour: [],
  by_tender: [{ tender: 'cash', amount: payable, bills }],
  by_item: [{ name_th: 'ชา', name_en: 'Tea', quantity: 3, revenue: 9000 }],
  by_staff: [],
  by_store: [],
});
const calls: { fn: string; auth: string; body: unknown }[] = [];
const fakeFetch = (o: { allowed?: boolean; fails?: boolean } = {}) =>
  vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const fn = /\/rpc\/(\w+)$/.exec(u)?.[1];
    if (fn) {
      const body = JSON.parse(String(init?.body)) as { p?: { from?: string } };
      calls.push({
        fn,
        auth: String((init?.headers as Record<string, string>).Authorization),
        body,
      });
      if (fn === 'ask_shop_context_all')
        return Response.json(
          o.allowed === false ? null : { org_id: ORG, store_ids: [STORE, 'x'], count: 2 },
        );
      if (fn === 'ask_shop_context')
        return Response.json(
          o.allowed === false ? null : { org_id: ORG, store_id: STORE, name: 'Acme' },
        );
      if (fn === 'sales_report') {
        if (o.fails) return new Response('x', { status: 500 });
        return Response.json(
          body.p?.from === '2026-11-13'
            ? report(1200000, 12)
            : report(1000000, 10, '2026-11-06', '2026-11-12'),
        );
      }
      return Response.json(null);
    }
    return Response.json([]);
  }) as unknown as typeof fetch;

let n = 0;
const ask = (
  body: unknown,
  fetchImpl: typeof fetch,
  text: string,
  headers: Record<string, string> = { authorization: `Bearer jwt-${(n += 1)}-aaaaaaaaaaaa` },
) => {
  const a = adapter(text);
  return askShopResponse(
    new Request('https://x/api/ask/shop', { method: 'POST', headers, body: JSON.stringify(body) }),
    env,
    { fetchImpl, adapters: { anthropic: a, google: a }, now: () => NOW },
  );
};
const good = { store_id: STORE, preset: 'last7', question: 'How are sales this week?' };

describe('POST /api/ask/shop', () => {
  it('reads the figures by SQL with the person’s own token and returns the explanation with its figures', async () => {
    calls.length = 0;
    const res = await ask(
      good,
      fakeFetch(),
      'Sales were 12,000 THB from 12 bills, up 2,000 THB (20.0%).',
    );
    const b = (await res.json()) as {
      available: boolean;
      answer: string;
      unverified: string[];
      figures: string;
      range: { from: string; to: string };
    };
    expect(res.status).toBe(200);
    expect(b.available).toBe(true);
    expect(b.unverified).toEqual([]);
    expect(b.figures).toContain('total 12,000 THB from 12 bills');
    expect(b.range).toEqual({ from: '2026-11-13', to: '2026-11-19' });
    const reports = calls.filter((c) => c.fn === 'sales_report');
    expect(reports).toHaveLength(2); // this period and the one before
    expect(reports.every((c) => c.auth.startsWith('Bearer jwt-'))).toBe(true);
    expect(calls.find((c) => c.fn === 'log_ai_usage')!.auth).toBe('Bearer svc');
    expect(JSON.stringify(calls.find((c) => c.fn === 'log_ai_usage')!.body)).not.toContain('sales');
  });

  it('all shops together: asks the all-shops gate, reads the report with no shop filter, names the group', async () => {
    calls.length = 0;
    const res = await ask(
      { org_id: ORG, preset: 'last7', question: 'How is the whole business doing?' },
      fakeFetch(),
      'Sales were 12,000 THB.',
    );
    const b = (await res.json()) as { available: boolean; figures: string };
    expect(b.available).toBe(true);
    expect(b.figures).toContain('Shop: All 2 shops together');
    expect(calls.some((c) => c.fn === 'ask_shop_context_all')).toBe(true);
    const reports = calls.filter((c) => c.fn === 'sales_report');
    expect(reports.every((c) => (c.body as { p: { store_id: unknown } }).p.store_id === null)).toBe(
      true,
    );
    expect(
      (calls.find((c) => c.fn === 'log_ai_usage')!.body as { p: { store_id: string } }).p.store_id,
    ).toBe(STORE);
    expect(
      (
        await ask(
          { org_id: ORG, preset: 'last7', question: 'sales?' },
          fakeFetch({ allowed: false }),
          'x',
        )
      ).status,
    ).toBe(403);
    expect((await ask({ preset: 'last7', question: 'sales?' }, fakeFetch(), 'x')).status).toBe(422);
  });

  it('lists a number the figures do not contain instead of trusting it', async () => {
    const res = await ask(good, fakeFetch(), 'Sales were 15,500 THB, a rise of 55.5%.');
    const b = (await res.json()) as { unverified: string[] };
    expect(b.unverified).toEqual(['15,500', '55.5%']);
  });

  it('refuses without a login, with bad input, or when the database says no (module off / no report.view / other shop)', async () => {
    expect((await ask(good, fakeFetch(), 'x', {})).status).toBe(403);
    expect((await ask({ ...good, preset: 'forever' }, fakeFetch(), 'x')).status).toBe(422);
    expect((await ask({ ...good, question: 'a' }, fakeFetch(), 'x')).status).toBe(422);
    expect((await ask({ ...good, store_id: 'nope' }, fakeFetch(), 'x')).status).toBe(422);
    const before = calls.filter((c) => c.fn === 'sales_report').length;
    const f = fakeFetch({ allowed: false });
    expect((await ask(good, f, 'x')).status).toBe(403);
    expect(calls.filter((c) => c.fn === 'sales_report').length).toBe(before); // nothing was read for the refused one
  });

  it('works without any AI key', async () => {
    const a = adapter('never');
    const res = await askShopResponse(
      new Request('https://x/api/ask/shop', {
        method: 'POST',
        headers: { authorization: 'Bearer jwt-nokey-aaaaaaaaaaaa' },
        body: JSON.stringify(good),
      }),
      { ...env, ANTHROPIC_API_KEY: undefined },
      { fetchImpl: fakeFetch(), adapters: { anthropic: a, google: a } },
    );
    expect(await res.json()).toEqual({ available: false });
    expect(a.call).not.toHaveBeenCalled();
  });

  it('a failing report is an error, never an invented answer', async () => {
    const res = await ask(good, fakeFetch({ fails: true }), 'whatever');
    expect(res.status).toBe(502);
  });
});

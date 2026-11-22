import { describe, expect, it, vi } from 'vitest';
import { budgetAllows, budgetSpent } from './ai-budget.js';
import { EVAL_CASES, FIGURE_NUMBERS, evalSummary, runEval } from './ai-eval.js';
import { runAiWith } from './ai-run.js';
import { receiptSendResponse } from './receipt-handler.js';
import type { ProviderAdapter } from './ai-adapters.js';
import { parseAiSettings } from '../../packages/core/src/ai.js';

const env = {
  SUPABASE_URL: 'https://x.supabase.co',
  VITE_SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'svc',
  SUPABASE_ANON_KEY: 'anon',
};

describe('AI budget', () => {
  it('has no limit without a cap, and a cap of 0 means no AI at all', () => {
    expect(budgetSpent({ cap: null, usage: [] })).toBe(false);
    expect(budgetSpent(null)).toBe(false);
    expect(budgetSpent({ cap: 0, usage: [] })).toBe(true);
  });
  it("prices the month's tokens like the usage page and compares with the cap", () => {
    // haiku-5-5: $0.1 in / $0.5 out per 1M tokens; 36 THB per USD → 1M in + 1M out = $0.6 = 21.60 THB = 2160 satang
    const usage = [{ model: 'claude-haiku-5-5', input: 1_000_000, output: 1_000_000 }];
    expect(budgetSpent({ cap: 2161, usd_thb: 36, usage })).toBe(false);
    expect(budgetSpent({ cap: 2160, usd_thb: 36, usage })).toBe(true);
    expect(
      budgetSpent({
        cap: 5000,
        usd_thb: 36,
        usage: [{ model: 'unknown-model', input: 9e9, output: 9e9 }],
      }),
    ).toBe(false); // no price = counts as 0
    expect(
      budgetSpent({
        cap: 100,
        usd_thb: 36,
        prices: { 'claude-haiku-5-5': { in: 100, out: 100 } },
        usage,
      }),
    ).toBe(true); // a corrected price counts
  });
  it('fails open when the database cannot answer, and blocks when spent', async () => {
    const down = vi.fn(async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    expect(
      await budgetAllows(down, 'https://x', 'svc', '11111111-1111-4111-8111-111111111111'),
    ).toBe(true);
    const spent = vi.fn(async () =>
      Response.json({ cap: 0, usage: [] }),
    ) as unknown as typeof fetch;
    expect(
      await budgetAllows(spent, 'https://x', 'svc', '11111111-1111-4111-8111-111111111111'),
    ).toBe(false);
    expect(await budgetAllows(spent, 'https://x', 'svc', 'not-a-store')).toBe(true);
  });
  it('a spent budget makes the call "not configured" before any provider is touched', async () => {
    const call = vi.fn();
    const adapters = { anthropic: { call }, google: { call } } as unknown as Record<
      'anthropic' | 'google',
      ProviderAdapter
    >;
    await expect(
      runAiWith({
        task: 'summary',
        request: { prompt: 'x', maxTokens: 10 },
        settings: parseAiSettings(null, null),
        keys: { anthropic: 'k' },
        adapters,
        guard: async () => false,
      }),
    ).rejects.toMatchObject({ code: 'not_configured' });
    expect(call).not.toHaveBeenCalled();
  });
});

describe('AI evaluation', () => {
  const settings = parseAiSettings(null, null);
  /** A well-behaved model: answers every golden case correctly. */
  const good = (req: { prompt: string }): string => {
    const p = req.prompt;
    if (p.includes('allergic to peanuts')) return '{"exclude":["contains_pork","contains_peanut"]}';
    if (p.includes('vegan please')) return '{"require":["vegan"],"max_spice":0}';
    if (p.includes('ทะเล')) return '{"exclude":["contains_seafood"]}';
    if (p.includes('write a poem')) return '{"exclude":["contains_egg"]}';
    if (p.includes('wifi')) return '{"ids":[1]}';
    if (p.includes('motorbike')) return '{"ids":[]}';
    if (p.includes('Target language: Thai')) return 'กรุณานำใบเช็คบิลไปที่โต๊ะ 4';
    return `Sales were ${FIGURE_NUMBERS[0]!.toLocaleString('en-US')} baht across ${FIGURE_NUMBERS[1]} bills, up 25% on the period before.`;
  };
  const adaptersWith = (answer: (r: { prompt: string }) => string) => {
    const a = {
      call: vi.fn(async (r: { prompt: string }) => ({
        text: answer(r),
        usage: { inputTokens: 10, outputTokens: 5 },
        provider: 'anthropic',
        model: 'm',
      })),
    };
    return { anthropic: a, google: a } as unknown as Record<
      'anthropic' | 'google',
      ProviderAdapter
    >;
  };
  it('a good model passes every case', async () => {
    const results = await runEval({
      settings,
      keys: { anthropic: 'k', google: 'k' },
      adapters: adaptersWith(good),
    });
    expect(results.map((r) => [r.id, r.ok, r.reason])).toEqual(
      EVAL_CASES.map((c) => [c.id, true, null]),
    );
    expect(evalSummary(results).reduce((a, s) => a + s.passed, 0)).toBe(EVAL_CASES.length);
  });
  it('catches a model that chats, obeys the injection, picks a wrong card or invents a number', async () => {
    const bad = (r: { prompt: string }) => {
      if (r.prompt.includes('write a poem'))
        return 'Roses are red, prices are low, {"exclude":[]} and here is a long poem about all of our prices';
      if (r.prompt.includes('wifi')) return '{"ids":[2]}';
      if (r.prompt.includes('motorbike')) return '{"ids":[1,2,3]}';
      if (r.prompt.includes('Target language: Thai')) return 'Translation: "Please bring the bill"';
      if (r.prompt.includes('Figures of one')) return 'Sales were 99,999 baht.';
      return good(r);
    };
    const results = await runEval({
      settings,
      keys: { anthropic: 'k', google: 'k' },
      adapters: adaptersWith(bad),
    });
    const failed = results.filter((r) => !r.ok).map((r) => r.id);
    expect(failed).toEqual([
      'diet_injection',
      'concierge_wifi',
      'concierge_unrelated',
      'translate_th',
      'summary_numbers',
    ]);
    expect(results.find((r) => r.id === 'summary_numbers')!.reason).toMatch(
      /numbers not in the figures/,
    );
  });
  it('a missing key fails each case with that reason and never throws', async () => {
    const results = await runEval({
      settings,
      keys: {},
      adapters: adaptersWith(good),
      only: ['concierge_wifi'],
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: false, reason: 'no key for this task' });
  });
});

describe('POST /api/receipt/send', () => {
  const ORDER = '33333333-3333-4333-8333-333333333333';
  const data = {
    receipt: {
      number: 'A+000007',
      issued_at: '2026-11-22T05:30:00Z',
      seller_name: 'Acme Co',
      seller_tax_id: '1234567890123',
      branch: '00000',
      vat_registered: true,
      subtotal: 10000,
      service_charge: 0,
      vat: 654,
      total: 10000,
      rounding: 0,
      payable: 10000,
    },
    lines: [{ name: { th: 'x', en: 'Pad Thai' }, qty: 2, unit_price: 5000 }],
    payments: [{ tender: 'cash', amount: 10000 }],
    member_line: true,
  };
  const req = (body: unknown, auth: string | null = 'Bearer user-jwt') =>
    new Request('https://x/api/receipt/send', {
      method: 'POST',
      headers: auth ? { authorization: auth } : {},
      body: JSON.stringify(body),
    });
  const mock = (over: Record<string, () => Response> = {}) => {
    const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const f = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      calls.push({
        url: u,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      for (const [k, v] of Object.entries(over)) if (u.includes(k)) return v();
      if (u.includes('receipt_send_data')) return Response.json(data);
      if (u.includes('receipt_line_target')) return Response.json('Unoi00000001');
      if (u.includes('api.resend.com')) return new Response('{}', { status: 200 });
      if (u.includes('api.line.me')) return new Response('{}', { status: 200 });
      return Response.json(null);
    }) as unknown as typeof fetch;
    return { f, calls };
  };
  it('needs a token and a valid request', async () => {
    expect(
      (await receiptSendResponse(req({ order_id: ORDER, via: 'email' }, null), env)).status,
    ).toBe(403);
    expect((await receiptSendResponse(req({ order_id: 'x', via: 'email' }), env)).status).toBe(422);
    expect((await receiptSendResponse(req({ order_id: ORDER, via: 'sms' }), env)).status).toBe(422);
    expect(
      (await receiptSendResponse(new Request('https://x', { method: 'GET' }), env)).status,
    ).toBe(405);
  });
  it('asks the database as the person, then e-mails the frozen receipt', async () => {
    const { f, calls } = mock();
    const res = await receiptSendResponse(
      req({ order_id: ORDER, via: 'email', email: 'Buyer@Example.com', lang: 'en' }),
      { ...env, RESEND_API_KEY: 'rk', EMAIL_FROM: 'Shop <s@example.com>' },
      { fetchImpl: f },
    );
    expect(await res.json()).toEqual({ ok: true, outcome: 'sent' });
    expect(calls[0]!.url).toContain('receipt_send_data');
    expect(calls[0]!.headers.Authorization).toBe('Bearer user-jwt');
    const mail = calls.find((c) => c.url.includes('resend'))!.body as {
      to: string[];
      subject: string;
      text: string;
    };
    expect(mail.to).toEqual(['buyer@example.com']);
    expect(mail.subject).toBe('Acme Co · A+000007');
    expect(mail.text).toContain('2 x Pad Thai  100.00 THB');
  });
  it('refuses somebody without the right, says when no receipt exists, and when e-mail is not set up', async () => {
    const { f } = mock({
      receipt_send_data: () => Response.json({ code: '42501' }, { status: 403 }),
    });
    expect(
      (
        await receiptSendResponse(req({ order_id: ORDER, via: 'email', email: 'a@b.co' }), env, {
          fetchImpl: f,
        })
      ).status,
    ).toBe(403);
    const none = mock({ receipt_send_data: () => Response.json(null) });
    expect(
      (
        await receiptSendResponse(req({ order_id: ORDER, via: 'email', email: 'a@b.co' }), env, {
          fetchImpl: none.f,
        })
      ).status,
    ).toBe(409);
    const ok = mock();
    const r = await receiptSendResponse(
      req({ order_id: ORDER, via: 'email', email: 'a@b.co' }),
      env,
      { fetchImpl: ok.f },
    );
    expect(await r.json()).toEqual({ ok: false, outcome: 'not_configured' });
  });
  it('rejects a bad e-mail address with 422', async () => {
    const { f } = mock();
    const r = await receiptSendResponse(
      req({ order_id: ORDER, via: 'email', email: 'nope' }),
      { ...env, RESEND_API_KEY: 'rk', EMAIL_FROM: 's@example.com' },
      { fetchImpl: f },
    );
    expect(r.status).toBe(422);
  });
  it("LINE goes to the member's address; no address or no LINE setup says so", async () => {
    const lineEnv = {
      ...env,
      LINE_CHANNEL_SECRET: 's',
      LINE_CHANNEL_ACCESS_TOKEN: 't',
      LINE_CODE_SECRET: 'c',
      LINE_BASIC_ID: '@b',
    };
    const { f, calls } = mock();
    const r = await receiptSendResponse(req({ order_id: ORDER, via: 'line' }), lineEnv, {
      fetchImpl: f,
    });
    expect(await r.json()).toEqual({ ok: true, outcome: 'sent' });
    expect((calls.find((c) => c.url.includes('api.line.me'))!.body as { to: string }).to).toBe(
      'Unoi00000001',
    );
    const none = mock({ receipt_line_target: () => Response.json(null) });
    expect(
      await (
        await receiptSendResponse(req({ order_id: ORDER, via: 'line' }), lineEnv, {
          fetchImpl: none.f,
        })
      ).json(),
    ).toEqual({ ok: false, outcome: 'no_channel' });
    expect(
      await (
        await receiptSendResponse(req({ order_id: ORDER, via: 'line' }), env, {
          fetchImpl: mock().f,
        })
      ).json(),
    ).toEqual({ ok: false, outcome: 'not_configured' });
  });
});

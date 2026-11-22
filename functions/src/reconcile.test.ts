import { describe, expect, it, vi } from 'vitest';
import { reconcileResponse, refundResponse } from './reconcile-handler.js';
import { stripeGateway } from './gateway.js';
import type { PaymentGateway } from './gateway.js';

const env = {
  SUPABASE_URL: 'https://x.supabase.co',
  VITE_SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'svc',
  SUPABASE_ANON_KEY: 'anon',
};
const STORE = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-222222222222';
const gw = (over: Partial<PaymentGateway> = {}): PaymentGateway =>
  ({
    id: 'stripe',
    startPromptPay: vi.fn(),
    startReader: vi.fn(),
    cancel: vi.fn(),
    readWebhook: () => null,
    listSucceeded: async () => [
      { providerRef: 'pi_1', amount: 10000, currency: 'thb', createdMs: 0 },
      { providerRef: 'pi_9', amount: 300, currency: 'thb', createdMs: 0 },
    ],
    refund: async () => ({ refundRef: 're_1' }),
    ...over,
  }) as PaymentGateway;
const db = (answers: Record<string, unknown>, fail: string[] = []) =>
  vi.fn(async (url: unknown) => {
    const fn = /\/rpc\/(\w+)$/.exec(String(url))?.[1] ?? '';
    return fail.includes(fn)
      ? new Response('{}', { status: 403 })
      : Response.json(answers[fn] ?? null);
  }) as unknown as typeof fetch;
const get = (qs: string, auth: string | null = 'Bearer jwt') =>
  new Request(`https://x/api/payments/reconcile?${qs}`, {
    headers: auth ? { authorization: auth } : {},
  });
let n = 0;
const post = (body: unknown) =>
  new Request('https://x/api/payments/refund', {
    method: 'POST',
    headers: { authorization: 'Bearer jwt', 'x-forwarded-for': `9.9.9.${(n += 1)}` },
    body: JSON.stringify(body),
  });

describe('GET /api/payments/reconcile', () => {
  const rows = {
    reconcile_rows: {
      attempts: [
        {
          provider: 'stripe',
          provider_ref: 'pi_1',
          amount: 10000,
          status: 'succeeded',
          order_number: 'A001',
        },
        {
          provider: 'stripe',
          provider_ref: 'pi_2',
          amount: 5000,
          status: 'succeeded',
          order_number: 'A002',
        },
      ],
      disputes: [
        { dispute_ref: 'dp_1', payment_ref: 'pi_1', amount: 10000, status: 'needs_response' },
      ],
      refunds: [],
    },
  };
  it('needs a token and a valid period', async () => {
    expect(
      (await reconcileResponse(get(`store=${STORE}&from=2026-11-01&to=2026-11-02`, null), env))
        .status,
    ).toBe(422);
    expect(
      (await reconcileResponse(get('store=x&from=2026-11-01&to=2026-11-02'), env)).status,
    ).toBe(422);
    expect(
      (await reconcileResponse(get(`store=${STORE}&from=2026-11-05&to=2026-11-01`), env)).status,
    ).toBe(422);
    expect(
      (await reconcileResponse(get(`store=${STORE}&from=2026-01-01&to=2026-12-31`), env)).status,
    ).toBe(422);
  });
  it('asks the database as the person, then compares with the provider', async () => {
    const res = await reconcileResponse(get(`store=${STORE}&from=2026-11-01&to=2026-11-02`), env, {
      fetchImpl: db(rows),
      gateway: gw(),
    });
    const j = await res.json();
    expect(j.available).toBe(true);
    expect(j.result.matched).toBe(1);
    expect(j.result.missingAtProvider.map((b: { providerRef: string }) => b.providerRef)).toEqual([
      'pi_2',
    ]);
    expect(j.result.missingInBestie.map((p: { providerRef: string }) => p.providerRef)).toEqual([
      'pi_9',
    ]);
    expect(j.disputes).toHaveLength(1);
  });
  it('refuses when the database refuses, and still shows disputes when the provider cannot list', async () => {
    expect(
      (
        await reconcileResponse(get(`store=${STORE}&from=2026-11-01&to=2026-11-02`), env, {
          fetchImpl: db({}, ['reconcile_rows']),
          gateway: gw(),
        })
      ).status,
    ).toBe(403);
    const j = await (
      await reconcileResponse(get(`store=${STORE}&from=2026-11-01&to=2026-11-02`), env, {
        fetchImpl: db(rows),
        gateway: gw({ listSucceeded: undefined }),
      })
    ).json();
    expect(j.available).toBe(false);
    expect(j.disputes).toHaveLength(1);
  });
  it('a provider that is down is a 502, not a crash', async () => {
    const res = await reconcileResponse(get(`store=${STORE}&from=2026-11-01&to=2026-11-02`), env, {
      fetchImpl: db(rows),
      gateway: gw({
        listSucceeded: async () => {
          throw new Error('down');
        },
      }),
    });
    expect(res.status).toBe(502);
  });
});

describe('POST /api/payments/refund', () => {
  const ctx = {
    refund_context: {
      provider: 'stripe',
      provider_ref: 'pi_1',
      attempt_id: 'att-1',
      max: 10000,
      count: 1,
    },
    record_provider_refund: 'rid',
  };
  it('checks with the database first, refunds with an idempotency key, then records it', async () => {
    const refund = vi.fn(async () => ({ refundRef: 're_7' }));
    const res = await refundResponse(
      post({ order_id: ORDER, amount: 2500, reason: 'wrong dish' }),
      env,
      { fetchImpl: db(ctx), gateway: gw({ refund }) },
    );
    expect(await res.json()).toEqual({ ok: true, refund_ref: 're_7', recorded: true });
    expect(refund).toHaveBeenCalledWith({
      providerRef: 'pi_1',
      amount: 2500,
      key: `refund:${ORDER}:2:2500`,
    });
  });
  it('does nothing at the provider when the database says no', async () => {
    const refund = vi.fn();
    const res = await refundResponse(post({ order_id: ORDER, amount: 2500 }), env, {
      fetchImpl: db({}, ['refund_context']),
      gateway: gw({ refund: refund as never }),
    });
    expect(res.status).toBe(403);
    expect(refund).not.toHaveBeenCalled();
  });
  it('a provider that cannot refund, or another provider than the payment\'s, is "not supported"', async () => {
    expect(
      (
        await refundResponse(post({ order_id: ORDER, amount: 100 }), env, {
          fetchImpl: db(ctx),
          gateway: gw({ refund: undefined }),
        })
      ).status,
    ).toBe(501);
    expect(
      (
        await refundResponse(post({ order_id: ORDER, amount: 100 }), env, {
          fetchImpl: db({ refund_context: { ...ctx.refund_context, provider: 'omise' } }),
          gateway: gw(),
        })
      ).status,
    ).toBe(501);
  });
  it('validates the body', async () => {
    expect((await refundResponse(post({ order_id: 'x', amount: 1 }), env)).status).toBe(422);
    expect((await refundResponse(post({ order_id: ORDER, amount: 1.5 }), env)).status).toBe(422);
    expect((await refundResponse(post({ order_id: ORDER, amount: 0 }), env)).status).toBe(422);
  });
});

describe('the Stripe adapter', () => {
  it('lists succeeded payment intents page by page and refunds with the key', async () => {
    const calls: string[] = [];
    const client = {
      post: vi.fn(async (path: string, params?: Record<string, unknown>, key?: string) => {
        calls.push(`POST ${path} ${JSON.stringify(params)} ${key}`);
        return { id: 're_1' };
      }),
      get: vi.fn(async (_p: string, q?: Record<string, string | number>) =>
        q?.starting_after
          ? {
              data: [{ id: 'pi_3', status: 'succeeded', amount: 700, currency: 'thb', created: 3 }],
              has_more: false,
            }
          : {
              data: [
                {
                  id: 'pi_1',
                  status: 'succeeded',
                  amount_received: 1000,
                  currency: 'thb',
                  created: 1,
                },
                { id: 'pi_2', status: 'canceled', amount: 5, currency: 'thb', created: 2 },
              ],
              has_more: true,
            },
      ),
    };
    const g = stripeGateway(client, { webhookSecret: 's', siteHost: 'x' });
    expect(await g.listSucceeded!({ fromMs: 0, toMs: 10_000 })).toEqual([
      { providerRef: 'pi_1', amount: 1000, currency: 'thb', createdMs: 1000 },
      { providerRef: 'pi_3', amount: 700, currency: 'thb', createdMs: 3000 },
    ]);
    expect(await g.refund!({ providerRef: 'pi_1', amount: 300, key: 'k' })).toEqual({
      refundRef: 're_1',
    });
    expect(calls[0]).toBe('POST /v1/refunds {"payment_intent":"pi_1","amount":300} k');
  });
});

describe('Stripe dispute webhook', () => {
  it('turns charge.dispute.created into a dispute event (signed), and refuses a bad signature', async () => {
    const { createHmac } = await import('node:crypto');
    const secret = 'whsec_test';
    const body = JSON.stringify({
      id: 'evt_1',
      type: 'charge.dispute.created',
      data: {
        object: {
          id: 'dp_1',
          payment_intent: 'pi_1',
          amount: 10000,
          currency: 'thb',
          reason: 'fraudulent',
          status: 'needs_response',
        },
      },
    });
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    const g = stripeGateway({ post: vi.fn() }, { webhookSecret: secret, siteHost: 'x' });
    const ok = g.readWebhook({
      rawBody: body,
      headers: new Headers({ 'stripe-signature': `t=${t},v1=${sig}` }),
    });
    expect(ok).toMatchObject({
      kind: 'dispute',
      disputeRef: 'dp_1',
      providerRef: 'pi_1',
      amount: 10000,
      reason: 'fraudulent',
    });
    expect(
      g.readWebhook({
        rawBody: body,
        headers: new Headers({ 'stripe-signature': `t=${t},v1=deadbeef` }),
      }),
    ).toBeNull();
  });
});

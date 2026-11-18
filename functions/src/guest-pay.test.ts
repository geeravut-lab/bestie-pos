import { describe, expect, it, vi } from 'vitest';
import {
  guestMenuResponse,
  guestPayCancelResponse,
  guestPayResponse,
  guestPayStatusResponse,
} from './guest-handler.js';
import type { StripeClient } from './stripe.js';
// the till's own arithmetic: the guest handler must produce the very same numbers
import { orderBill } from '../../packages/core/src/orders.js';
import { onlineSnapshot } from '../../packages/core/src/payments.js';
import type { OrderDoc } from '../../packages/core/src/orders.js';

const TOKEN = 'b'.repeat(32);
const ATTEMPT = '40000000-0000-4000-8000-000000000001';
const env = {
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'svc',
  STRIPE_SECRET_KEY: 'sk_test_123',
  STRIPE_WEBHOOK_SECRET: 'whsec_123',
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const ctxOf = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  device_id: 'dev-1',
  order_id: 'ord-1',
  config: { vat_bps: 700, service_bps: 1000, price_mode: 'inclusive', bill_options: {} },
  unsent: false,
  lines: [
    { unit_price: 9000, quantity: 2 },
    { unit_price: 3000, quantity: 1 },
  ],
  live: null,
  ...over,
});

function fakeFetch(answers: Record<string, (args: Record<string, unknown>) => Response>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const fn = String(url).split('/rpc/')[1] ?? '';
    const args = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ fn, args });
    return (answers[fn] ?? (() => json(null)))(args);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const fakeStripe = (): {
  stripe: StripeClient;
  posts: { path: string; params?: Record<string, unknown> }[];
} => {
  const posts: { path: string; params?: Record<string, unknown> }[] = [];
  return {
    posts,
    stripe: {
      post: async (path, params) => {
        posts.push({ path, params: params as Record<string, unknown> });
        return path === '/v1/payment_intents'
          ? {
              id: 'pi_1',
              next_action: {
                promptpay_display_qr_code: { image_url_png: 'https://q.example/qr.png', data: 'x' },
              },
            }
          : {};
      },
    },
  };
};
const post = (path: string, body: unknown, ip: string) =>
  new Request(`https://app.test/api/guest/${path}`, {
    method: 'POST',
    headers: { 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });

describe('the guest bill is the till’s bill', () => {
  it('same total, VAT and service charge as orderBill / onlineSnapshot for the same lines', async () => {
    const { f, calls } = fakeFetch({
      guest_pay_context: () => json(ctxOf()),
      guest_begin_payment: () => json(ATTEMPT),
      attach_payment_intent: () => json(null),
    });
    const { stripe } = fakeStripe();
    const r = await guestPayResponse(post('pay', { token: TOKEN, lang: 'en' }, '5.0.0.1'), env, {
      fetchImpl: f,
      stripe,
    });
    expect(r.status).toBe(200);
    const snap = calls.find((c) => c.fn === 'guest_begin_payment')!.args.p as Record<
      string,
      unknown
    >;

    const order = {
      id: 'ord-1',
      lines: [
        { status: 'sent', unitPrice: 9000, quantity: 2 },
        { status: 'sent', unitPrice: 3000, quantity: 1 },
      ],
    } as unknown as OrderDoc;
    const cfg = {
      priceMode: 'inclusive' as const,
      vatBps: 700,
      serviceChargeBps: 1000,
      options: {},
    };
    const till = onlineSnapshot({
      order,
      bill: orderBill(order, cfg),
      billConfig: cfg,
      tender: 'promptpay',
      deviceId: 'dev-1',
      staffId: null,
      lang: 'en',
    });
    expect(snap).toEqual(till);
  });
});

describe('POST /api/guest/pay', () => {
  it('starts a PromptPay QR for the amount the SERVER computed, never one from the phone', async () => {
    const { f, calls } = fakeFetch({
      guest_pay_context: () => json(ctxOf()),
      guest_begin_payment: () => json(ATTEMPT),
      attach_payment_intent: () => json(null),
    });
    const { stripe, posts } = fakeStripe();
    const r = await guestPayResponse(
      post('pay', { token: TOKEN, lang: 'th', amount: 1, total: 1 }, '5.0.0.2'),
      env,
      { fetchImpl: f, stripe },
    );
    const body = (await r.json()) as { attempt_id: string; amount: number; qr_image_url: string };
    expect(body).toMatchObject({ attempt_id: ATTEMPT, qr_image_url: 'https://q.example/qr.png' });
    expect(body.amount).toBeGreaterThan(1);
    expect(posts[0]!.params).toMatchObject({ amount: body.amount, currency: 'thb' });
    expect(calls.find((c) => c.fn === 'attach_payment_intent')!.args).toMatchObject({
      p_attempt: ATTEMPT,
      p_ref: 'pi_1',
    });
  });

  it('refuses when the shop has not switched it on, when lines are unconfirmed, and when there is nothing to pay', async () => {
    const stripe = fakeStripe().stripe;
    for (const [over, status, error] of [
      [{ enabled: false }, 403, 'pay_off'],
      [{ unsent: true }, 409, 'unconfirmed'],
      [{ lines: [], order_id: null }, 422, 'empty'],
    ] as const) {
      const { f } = fakeFetch({ guest_pay_context: () => json(ctxOf(over)) });
      const r = await guestPayResponse(
        post('pay', { token: TOKEN }, `5.0.1.${status}${error.length}`),
        env,
        { fetchImpl: f, stripe },
      );
      expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([status, error]);
    }
  });

  it('503 without Stripe keys, 404 for an unknown table, 422 for a bad token', async () => {
    const { f } = fakeFetch({ guest_pay_context: () => json(null) });
    expect(
      (
        await guestPayResponse(
          post('pay', { token: TOKEN }, '5.0.2.1'),
          { ...env, STRIPE_SECRET_KEY: '' },
          { fetchImpl: f },
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await guestPayResponse(post('pay', { token: TOKEN }, '5.0.2.2'), env, {
          fetchImpl: f,
          stripe: fakeStripe().stripe,
        })
      ).status,
    ).toBe(404);
    expect(
      (await guestPayResponse(post('pay', { token: 'x' }, '5.0.2.3'), env, { fetchImpl: f }))
        .status,
    ).toBe(422);
  });

  it('shows the QR that is already live for the same amount instead of starting a second one', async () => {
    const live = {
      id: ATTEMPT,
      amount: 14520,
      qr_url: 'https://q.example/live.png',
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      status: 'pending',
      provider_ref: 'pi_live',
    };
    const { f, calls } = fakeFetch({
      guest_pay_context: () => json(ctxOf({ live })),
      guest_cancel_payment: () => json({ status: 'canceled', provider_ref: 'pi_live' }),
      guest_begin_payment: () => json(ATTEMPT),
      attach_payment_intent: () => json(null),
    });
    const { stripe, posts } = fakeStripe();
    const r = await guestPayResponse(post('pay', { token: TOKEN }, '5.0.3.1'), env, {
      fetchImpl: f,
      stripe,
    });
    const body = (await r.json()) as { amount: number; qr_image_url: string };
    // 12.0 baht lines: 2×90 + 30 = 210.00 + 10 % service = 231.00 (VAT is inside the prices)
    expect(body.amount).toBe(23100);
    // amount differs from the live attempt (14520) → the old one is cancelled, a new one started
    expect(calls.map((c) => c.fn)).toContain('guest_cancel_payment');
    expect(posts.some((p) => p.path === '/v1/payment_intents')).toBe(true);
  });

  it('resumes a live QR whose amount still matches', async () => {
    const live = {
      id: ATTEMPT,
      amount: 23100,
      qr_url: 'https://q.example/live.png',
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      status: 'pending',
      provider_ref: 'pi_live',
    };
    const { f, calls } = fakeFetch({ guest_pay_context: () => json(ctxOf({ live })) });
    const { stripe, posts } = fakeStripe();
    const r = await guestPayResponse(post('pay', { token: TOKEN }, '5.0.3.2'), env, {
      fetchImpl: f,
      stripe,
    });
    expect(await r.json()).toMatchObject({
      attempt_id: ATTEMPT,
      qr_image_url: 'https://q.example/live.png',
    });
    expect(calls.map((c) => c.fn)).toEqual(['guest_pay_context']);
    expect(posts).toHaveLength(0);
  });

  it('a provider failure marks the attempt failed and tells the guest', async () => {
    const { f, calls } = fakeFetch({
      guest_pay_context: () => json(ctxOf()),
      guest_begin_payment: () => json(ATTEMPT),
      fail_payment_attempt: () => json(null),
    });
    const stripe: StripeClient = {
      post: async () => {
        throw new Error('boom');
      },
    };
    const r = await guestPayResponse(post('pay', { token: TOKEN }, '5.0.4.1'), env, {
      fetchImpl: f,
      stripe,
    });
    expect(r.status).toBe(502);
    expect(calls.find((c) => c.fn === 'fail_payment_attempt')!.args).toMatchObject({
      p_attempt: ATTEMPT,
      p_status: 'failed',
    });
  });

  it('maps database refusals', async () => {
    const stripe = fakeStripe().stripe;
    for (const [code, status, error] of [
      ['23505', 409, 'attempt_pending'],
      ['55000', 409, 'unconfirmed'],
      ['0A000', 403, 'pay_off'],
    ] as const) {
      const { f } = fakeFetch({
        guest_pay_context: () => json(ctxOf()),
        guest_begin_payment: () => json({ code }, 400),
      });
      const r = await guestPayResponse(
        post('pay', { token: TOKEN }, `5.0.5.${status}${code.length}${error.length}`),
        env,
        { fetchImpl: f, stripe },
      );
      expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([status, error]);
    }
  });
});

describe('status and cancel', () => {
  it('status passes the database answer through and 404s for another table', async () => {
    const ok = fakeFetch({
      guest_payment_status: () => json({ status: 'succeeded', amount: 23100, receipt: 'A+000001' }),
    });
    const r = await guestPayStatusResponse(
      new Request(`https://app.test/api/guest/pay?t=${TOKEN}&a=${ATTEMPT}`, {
        headers: { 'x-forwarded-for': '6.0.0.1' },
      }),
      env,
      { fetchImpl: ok.f },
    );
    expect(await r.json()).toMatchObject({ status: 'succeeded', receipt: 'A+000001' });
    const none = fakeFetch({ guest_payment_status: () => json(null) });
    expect(
      (
        await guestPayStatusResponse(
          new Request(`https://app.test/api/guest/pay?t=${TOKEN}&a=${ATTEMPT}`, {
            headers: { 'x-forwarded-for': '6.0.0.2' },
          }),
          env,
          { fetchImpl: none.f },
        )
      ).status,
    ).toBe(404);
    expect(
      (await guestPayStatusResponse(new Request('https://app.test/api/guest/pay?t=bad&a=bad'), env))
        .status,
    ).toBe(404);
  });

  it('cancel stops the waiting QR at the provider too', async () => {
    const { f } = fakeFetch({
      guest_cancel_payment: () => json({ status: 'canceled', provider_ref: 'pi_9' }),
    });
    const { stripe, posts } = fakeStripe();
    const r = await guestPayCancelResponse(
      post('pay-cancel', { token: TOKEN, attemptId: ATTEMPT }, '6.0.1.1'),
      env,
      { fetchImpl: f, stripe },
    );
    expect(await r.json()).toEqual({ status: 'canceled' });
    expect(posts[0]!.path).toBe('/v1/payment_intents/pi_9/cancel');
  });

  it('cancel of a payment that already succeeded does not call the provider', async () => {
    const { f } = fakeFetch({
      guest_cancel_payment: () => json({ status: 'succeeded', provider_ref: 'pi_9' }),
    });
    const { stripe, posts } = fakeStripe();
    await guestPayCancelResponse(
      post('pay-cancel', { token: TOKEN, attemptId: ATTEMPT }, '6.0.1.2'),
      env,
      { fetchImpl: f, stripe },
    );
    expect(posts).toHaveLength(0);
  });
});

describe('GET /api/guest/menu carries the pay info', () => {
  it('offers payment with the server-computed total, and never the device id or config', async () => {
    const { f } = fakeFetch({
      guest_table: () =>
        json({ store_name: 'Acme', table_name: 'T1', qr_enabled: true, auto_send: false }),
      guest_menu: () => json({ categories: [], items: [], groups: [] }),
      guest_bill: () => json({ order_id: 'ord-1', lines: [] }),
      guest_pay_context: () => json(ctxOf()),
    });
    const r = await guestMenuResponse(
      new Request(`https://app.test/api/guest/menu?t=${TOKEN}`, {
        headers: { 'x-forwarded-for': '7.0.0.1' },
      }),
      env,
      { fetchImpl: f },
    );
    const body = (await r.json()) as { pay: Record<string, unknown> };
    expect(body.pay).toMatchObject({ enabled: true, total: 23100, unconfirmed: false, live: null });
    expect(JSON.stringify(body)).not.toMatch(/dev-1|vat_bps|device/);
  });
  it('payment is not offered without Stripe keys', async () => {
    const { f } = fakeFetch({
      guest_table: () => json({ store_name: 'Acme', table_name: 'T1', qr_enabled: true }),
      guest_menu: () => json({}),
      guest_bill: () => json({}),
      guest_pay_context: () => json(ctxOf()),
    });
    const r = await guestMenuResponse(
      new Request(`https://app.test/api/guest/menu?t=${TOKEN}`, {
        headers: { 'x-forwarded-for': '7.0.0.2' },
      }),
      { ...env, STRIPE_SECRET_KEY: '' },
      { fetchImpl: f },
    );
    expect(((await r.json()) as { pay: { enabled: boolean } }).pay.enabled).toBe(false);
  });
});

describe("a Points discount on the guest's bill", () => {
  it('lowers the amount the guest pays, exactly as the till computes it, and is told to the page', async () => {
    const withPoints = ctxOf({ points_discount: 3000 });
    const { f, calls } = fakeFetch({
      guest_pay_context: () => json(withPoints),
      guest_begin_payment: () => json(ATTEMPT),
      attach_payment_intent: () => json(null),
    });
    const { stripe, posts } = fakeStripe();
    const r = await guestPayResponse(post('pay', { token: TOKEN, lang: 'th' }, '8.0.0.1'), env, {
      fetchImpl: f,
      stripe,
    });
    const body = (await r.json()) as { amount: number };
    // lines 210.00, − 30.00 points → 180.00, + 10 % service → 198.00
    expect(body.amount).toBe(19800);
    expect(posts[0]!.params).toMatchObject({ amount: 19800 });
    const snap = calls.find((c) => c.fn === 'guest_begin_payment')!.args.p as Record<
      string,
      unknown
    >;
    expect(snap).toMatchObject({
      subtotal: 21000,
      points_discount: 3000,
      total: 19800,
      payable: 19800,
    });
  });
  it('the menu answer carries the discount and the reduced total', async () => {
    const { f } = fakeFetch({
      guest_table: () => json({ store_name: 'Acme', table_name: 'T1', qr_enabled: true }),
      guest_menu: () => json({}),
      guest_bill: () => json({}),
      guest_pay_context: () => json(ctxOf({ points_discount: 3000 })),
    });
    const r = await guestMenuResponse(
      new Request(`https://app.test/api/guest/menu?t=${TOKEN}`, {
        headers: { 'x-forwarded-for': '8.0.0.2' },
      }),
      env,
      { fetchImpl: f },
    );
    expect(((await r.json()) as { pay: Record<string, unknown> }).pay).toMatchObject({
      pointsDiscount: 3000,
      total: 19800,
    });
  });
});

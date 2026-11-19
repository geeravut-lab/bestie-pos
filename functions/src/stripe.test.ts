import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  StripeError,
  cancelProviderPayment,
  createStripeClient,
  startPromptPay,
  startReaderPayment,
  stripeConfig,
  stripeForm,
  verifyStripeSignature,
} from './stripe.js';
import type { StripeClient } from './stripe.js';
import {
  stripeCancelResponse,
  stripeChargeResponse,
  stripeWebhookResponse,
} from './payment-handler.js';

const SECRET = 'whsec_test_secret';
const NOW = 1_800_000_000_000;
const sign = (body: string, t = NOW / 1000, secret = SECRET) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

describe('verifyStripeSignature', () => {
  const body = '{"id":"evt_1"}';
  const ok = (header: string | null, rawBody = body, nowMs = NOW) =>
    verifyStripeSignature({ rawBody, header, secret: SECRET, nowMs });
  it('accepts a genuine signature', () => expect(ok(sign(body))).toBe(true));
  it('refuses a changed body, a wrong secret, a missing or garbled header', () => {
    expect(ok(sign(body), '{"id":"evt_2"}')).toBe(false);
    expect(ok(sign(body, NOW / 1000, 'whsec_other'))).toBe(false);
    expect(ok(null)).toBe(false);
    expect(ok('garbage')).toBe(false);
    expect(ok('t=abc,v1=00')).toBe(false);
    expect(ok(`t=${NOW / 1000}`)).toBe(false);
    expect(ok(`t=${NOW / 1000},v1=zz`)).toBe(false);
  });
  it('refuses an old signature (replay) but allows a small clock difference', () => {
    expect(ok(sign(body, NOW / 1000 - 600))).toBe(false);
    expect(ok(sign(body, NOW / 1000 + 600))).toBe(false);
    expect(ok(sign(body, NOW / 1000 - 120))).toBe(true);
  });
  it('accepts when any one of several v1 signatures matches (secret rotation)', () => {
    const good = sign(body);
    expect(ok(`${good},v1=${'0'.repeat(64)}`)).toBe(true);
    expect(ok(`t=${NOW / 1000},v1=${'0'.repeat(64)},${good.split(',')[1]}`)).toBe(true);
  });
});

describe('config and form encoding', () => {
  it('needs a SECRET key (never a publishable one) and the webhook secret', () => {
    expect(stripeConfig({})).toBeNull();
    expect(
      stripeConfig({ STRIPE_SECRET_KEY: 'pk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' }),
    ).toBeNull();
    expect(stripeConfig({ STRIPE_SECRET_KEY: 'sk_test_x' })).toBeNull();
    expect(
      stripeConfig({
        STRIPE_SECRET_KEY: 'sk_live_x',
        STRIPE_WEBHOOK_SECRET: 'whsec_x',
        VITE_SITE_URL: 'https://shop.example/',
      })?.siteHost,
    ).toBe('shop.example');
    expect(
      stripeConfig({ STRIPE_SECRET_KEY: 'rk_live_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' }),
    ).not.toBeNull();
  });
  it('flattens nested objects and arrays the way Stripe expects, and escapes values', () => {
    expect(
      stripeForm({
        amount: 100,
        payment_method_types: ['promptpay'],
        metadata: { a: 'x y', b: 'ก' },
        skip: undefined,
        n: null,
      }),
    ).toBe(
      'amount=100&payment_method_types%5B%5D=promptpay&metadata%5Ba%5D=x%20y&metadata%5Bb%5D=%E0%B8%81',
    );
  });
});

describe('createStripeClient', () => {
  const res = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  it('sends the key as a bearer token, a form body and an idempotency key', async () => {
    const fetchImpl = vi.fn(async () => res(200, { id: 'pi_1' }));
    const c = createStripeClient('sk_test_abc', fetchImpl as never);
    await c.post('/v1/payment_intents', { amount: 5 }, 'key-1');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/payment_intents');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer sk_test_abc',
      'Idempotency-Key': 'key-1',
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(init.body).toBe('amount=5');
  });
  it('turns an error answer into a StripeError that carries only the machine code, never the message', async () => {
    const c = createStripeClient('sk_test_abc', (async () =>
      res(402, {
        error: { code: 'card_declined', message: 'Your card 4242… was declined' },
      })) as never);
    const e = await c.post('/v1/x').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StripeError);
    expect((e as StripeError).code).toBe('card_declined');
    expect((e as StripeError).message).not.toContain('4242');
  });
});

describe('starting payments', () => {
  const stub = (answers: Record<string, unknown>[]) => {
    const calls: { path: string; params: Record<string, unknown>; key?: string }[] = [];
    const client: StripeClient = {
      post: async (path, params = {}, key) => {
        calls.push({ path, params, key });
        return answers.shift() ?? {};
      },
    };
    return { client, calls };
  };

  it('PromptPay: confirmed PaymentIntent in THB with our attempt id as metadata and idempotency key; returns the QR', async () => {
    const { client, calls } = stub([
      {
        id: 'pi_9',
        next_action: {
          promptpay_display_qr_code: { image_url_png: 'https://qr/1.png', data: '0002...' },
        },
      },
    ]);
    const r = await startPromptPay(client, {
      attemptId: '11111111-2222-4333-8444-555555555555',
      orderId: 'o1',
      amount: 21000,
      siteHost: 'bestie-pos.vercel.app',
    });
    expect(r).toEqual({ providerRef: 'pi_9', qrImageUrl: 'https://qr/1.png', qrData: '0002...' });
    expect(calls[0]).toMatchObject({
      path: '/v1/payment_intents',
      key: 'bestie-attempt-11111111-2222-4333-8444-555555555555',
    });
    expect(calls[0]!.params).toMatchObject({
      amount: 21000,
      currency: 'thb',
      payment_method_types: ['promptpay'],
      confirm: 'true',
      metadata: { attempt_id: '11111111-2222-4333-8444-555555555555', order_id: 'o1' },
    });
    expect(JSON.stringify(calls[0]!.params)).toContain('@bestie-pos.vercel.app');
  });
  it('PromptPay without a QR in the answer is an error (never show an empty screen)', async () => {
    const { client } = stub([{ id: 'pi_9' }]);
    await expect(
      startPromptPay(client, { attemptId: 'a'.repeat(36), orderId: 'o', amount: 1, siteHost: 'x' }),
    ).rejects.toMatchObject({ code: 'no_qr' });
  });
  it("card reader: card_present intent, then handed to THIS device's reader", async () => {
    const { client, calls } = stub([{ id: 'pi_c' }, {}]);
    const r = await startReaderPayment(client, {
      attemptId: 'a'.repeat(36),
      orderId: 'o1',
      amount: 3000,
      readerId: 'tmr_ABC123xyz',
    });
    expect(r.providerRef).toBe('pi_c');
    expect(calls.map((c) => c.path)).toEqual([
      '/v1/payment_intents',
      '/v1/terminal/readers/tmr_ABC123xyz/process_payment_intent',
    ]);
    expect(calls[0]!.params).toMatchObject({
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      currency: 'thb',
    });
    expect(calls[1]!.params).toEqual({ payment_intent: 'pi_c' });
  });
  it('cancel: stops the reader first, then the intent; an "already done" answer is swallowed, other failures are not', async () => {
    const order: string[] = [];
    const ok: StripeClient = { post: async (p) => (order.push(p), {}) };
    await cancelProviderPayment(ok, { providerRef: 'pi_1', readerId: 'tmr_ABC123xyz' });
    expect(order).toEqual([
      '/v1/terminal/readers/tmr_ABC123xyz/cancel_action',
      '/v1/payment_intents/pi_1/cancel',
    ]);
    const done: StripeClient = {
      post: async () => {
        throw new StripeError(400, 'payment_intent_unexpected_state');
      },
    };
    await expect(
      cancelProviderPayment(done, { providerRef: 'pi_1', readerId: null }),
    ).resolves.toBeUndefined();
    const boom: StripeClient = {
      post: async () => {
        throw new TypeError('network');
      },
    };
    await expect(
      cancelProviderPayment(boom, { providerRef: 'pi_1', readerId: null }),
    ).rejects.toThrow('network');
  });
});

// ── HTTP handlers against a fake Supabase + fake Stripe ──────────────────────
const ENV = {
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  VITE_SUPABASE_ANON_KEY: 'anon-key',
  STRIPE_SECRET_KEY: 'sk_test_123',
  STRIPE_WEBHOOK_SECRET: SECRET,
};
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function backend(
  over: {
    user?: string | null;
    rpc?: Record<string, { status?: number; body: unknown }>;
    attempt?: unknown;
    reader?: string | null;
  } = {},
) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body =
      typeof init.body === 'string' && init.body
        ? headers['Content-Type']?.includes('json')
          ? JSON.parse(init.body)
          : init.body
        : null;
    calls.push({ url, method: init.method ?? 'GET', headers, body });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
    if (url.endsWith('/auth/v1/user'))
      return over.user === null ? json(401, {}) : json(200, { id: over.user ?? 'user-1' });
    const rpcName = /\/rest\/v1\/rpc\/(\w+)/.exec(url)?.[1];
    if (rpcName) {
      const r = over.rpc?.[rpcName] ?? { body: null };
      return json(r.status ?? 200, r.body);
    }
    if (url.includes('/rest/v1/payment_attempts'))
      return json(200, [
        over.attempt ?? {
          amount: 21000,
          tender: 'promptpay',
          order_id: 'o1',
          device_id: 'd1',
          provider: 'stripe',
        },
      ]);
    if (url.includes('/rest/v1/devices'))
      return json(200, [
        { stripe_reader_id: over.reader === undefined ? 'tmr_ABC123xyz' : over.reader },
      ]);
    return json(404, {});
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    calls,
    rpcCalls: (n: string) => calls.filter((c) => c.url.endsWith(`/rpc/${n}`)),
  };
}
const stripeOk = (answers: Record<string, unknown>[] = []) => {
  const calls: string[] = [];
  const stripe: StripeClient = { post: async (p) => (calls.push(p), answers.shift() ?? {}) };
  return { stripe, calls };
};
const SNAP = { order_id: 'o1', device_id: 'd1', tender: 'promptpay', payable: 21000 };
const ATTEMPT = '11111111-2222-4333-8444-555555555555';
const post = (
  path: string,
  body: unknown,
  headers: Record<string, string> = { authorization: 'Bearer user-jwt' },
) =>
  new Request(`https://x/api/stripe/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('POST /api/stripe/charge — Bestie Credit top-up', () => {
  const TOPUP = {
    customer_id: 'c1',
    store_id: 's1',
    device_id: 'd1',
    tender: 'promptpay',
    amount: 50000,
  };

  it('asks the database function for top-ups as the user, then Stripe with NO bill and NO customer data', async () => {
    const be = backend({
      rpc: { begin_credit_topup_attempt: { body: ATTEMPT }, attach_payment_intent: { body: null } },
      attempt: { amount: 50000, tender: 'promptpay', order_id: null, device_id: 'd1' },
    });
    let sent: Record<string, unknown> = {};
    const stripe: StripeClient = {
      post: async (_p, params) => {
        sent = params ?? {};
        return {
          id: 'pi_t1',
          next_action: { promptpay_display_qr_code: { image_url_png: 'https://qr/t.png' } },
        };
      },
    };
    const r = await stripeChargeResponse(post('charge', { topup: TOPUP }), ENV, {
      fetchImpl: be.fetchImpl,
      stripe,
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      attempt_id: ATTEMPT,
      amount: 50000,
      qr_image_url: 'https://qr/t.png',
    });
    const begin = be.rpcCalls('begin_credit_topup_attempt')[0]!;
    expect(begin.headers).toMatchObject({ apikey: 'anon-key', Authorization: 'Bearer user-jwt' });
    expect(begin.body).toEqual({ p: TOPUP });
    expect(be.rpcCalls('begin_payment_attempt')).toHaveLength(0);
    expect(sent.metadata).toEqual({ attempt_id: ATTEMPT, kind: 'credit_topup' });
    expect(JSON.stringify(sent)).not.toContain('c1');
  });

  it('a bill and a top-up in the same request, or neither, is refused', async () => {
    const be = backend();
    const call = (b: unknown) =>
      stripeChargeResponse(post('charge', b), ENV, { fetchImpl: be.fetchImpl });
    expect((await call({ snapshot: SNAP, topup: TOPUP })).status).toBe(422);
    expect((await call({})).status).toBe(422);
  });

  it('Credit switched off in the shop → 403 module_off, and Stripe is never called', async () => {
    const be = backend({
      rpc: { begin_credit_topup_attempt: { status: 400, body: { code: '0A000' } } },
    });
    const { stripe, calls } = stripeOk();
    const r = await stripeChargeResponse(post('charge', { topup: TOPUP }), ENV, {
      fetchImpl: be.fetchImpl,
      stripe,
    });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'module_off' });
    expect(calls).toHaveLength(0);
  });

  it('amount out of range / balance cap (22023) → 422; a second live top-up (23505) → 409', async () => {
    const run = async (code: string) => {
      const be = backend({ rpc: { begin_credit_topup_attempt: { status: 400, body: { code } } } });
      return (
        await stripeChargeResponse(post('charge', { topup: TOPUP }), ENV, {
          fetchImpl: be.fetchImpl,
          stripe: stripeOk().stripe,
        })
      ).status;
    };
    expect(await run('22023')).toBe(422);
    expect(await run('23505')).toBe(409);
  });
});

describe('POST /api/stripe/charge', () => {
  it('is closed without keys, without a signed-in user, with a bad body, and for other methods', async () => {
    expect((await stripeChargeResponse(post('charge', {}), {})).status).toBe(503);
    expect(
      (
        await stripeChargeResponse(post('charge', { snapshot: SNAP }, {}), ENV, {
          fetchImpl: backend().fetchImpl,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await stripeChargeResponse(post('charge', { snapshot: SNAP }), ENV, {
          fetchImpl: backend({ user: null }).fetchImpl,
        })
      ).status,
    ).toBe(403);
    expect(
      (await stripeChargeResponse(post('charge', 'nope'), ENV, { fetchImpl: backend().fetchImpl }))
        .status,
    ).toBe(422);
    expect(
      (await stripeChargeResponse(new Request('https://x/api/stripe/charge'), ENV)).status,
    ).toBe(405);
  });

  it('PromptPay: asks the database as THE USER (anon key + their token), then Stripe, then records the reference, and returns the QR', async () => {
    const be = backend({
      rpc: { begin_payment_attempt: { body: ATTEMPT }, attach_payment_intent: { body: null } },
    });
    const { stripe, calls } = stripeOk([
      {
        id: 'pi_9',
        next_action: { promptpay_display_qr_code: { image_url_png: 'https://qr/1.png' } },
      },
    ]);
    const r = await stripeChargeResponse(post('charge', { snapshot: SNAP }), ENV, {
      fetchImpl: be.fetchImpl,
      stripe,
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({
      attempt_id: ATTEMPT,
      tender: 'promptpay',
      amount: 21000,
      qr_image_url: 'https://qr/1.png',
    });
    const begin = be.rpcCalls('begin_payment_attempt')[0]!;
    expect(begin.headers).toMatchObject({ apikey: 'anon-key', Authorization: 'Bearer user-jwt' });
    expect(begin.body).toEqual({ p: SNAP });
    expect(calls).toEqual(['/v1/payment_intents']);
    expect(be.rpcCalls('attach_payment_intent')[0]!.body).toMatchObject({
      p_attempt: ATTEMPT,
      p_ref: 'pi_9',
    });
    expect(be.rpcCalls('attach_payment_intent')[0]!.headers.Authorization).toBe(
      'Bearer service-key',
    ); // server-only function
    expect(JSON.stringify(body)).not.toContain('sk_test');
  });

  it("card: uses THIS device's reader from the database, never an id sent by the till", async () => {
    const be = backend({
      rpc: { begin_payment_attempt: { body: ATTEMPT } },
      attempt: { amount: 3000, tender: 'gateway', order_id: 'o1', device_id: 'd1' },
    });
    const { stripe, calls } = stripeOk([{ id: 'pi_c' }, {}]);
    const r = await stripeChargeResponse(
      post('charge', { snapshot: { ...SNAP, tender: 'gateway', reader_id: 'tmr_EVIL000000' } }),
      ENV,
      { fetchImpl: be.fetchImpl, stripe },
    );
    expect(r.status).toBe(200);
    expect(calls).toEqual([
      '/v1/payment_intents',
      '/v1/terminal/readers/tmr_ABC123xyz/process_payment_intent',
    ]);
  });

  it("maps the database's refusals to clear answers and never calls Stripe", async () => {
    for (const [code, status, error] of [
      ['42501', 403, 'forbidden'],
      ['23505', 409, 'attempt_pending'],
      ['23514', 422, 'invalid'],
      ['P0002', 404, 'not_found'],
    ] as const) {
      const be = backend({ rpc: { begin_payment_attempt: { status: 400, body: { code } } } });
      const { stripe, calls } = stripeOk();
      const r = await stripeChargeResponse(post('charge', { snapshot: SNAP }), ENV, {
        fetchImpl: be.fetchImpl,
        stripe,
      });
      expect([r.status, (await r.json()).error]).toEqual([status, error]);
      expect(calls).toEqual([]);
    }
  });

  it('a Stripe failure marks the attempt failed and answers 502 with only a code', async () => {
    const be = backend({ rpc: { begin_payment_attempt: { body: ATTEMPT } } });
    const stripe: StripeClient = {
      post: async () => {
        throw new StripeError(402, 'amount_too_small');
      },
    };
    const r = await stripeChargeResponse(post('charge', { snapshot: SNAP }), ENV, {
      fetchImpl: be.fetchImpl,
      stripe,
    });
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: 'provider_error', code: 'amount_too_small' });
    expect(be.rpcCalls('fail_payment_attempt')[0]!.body).toMatchObject({
      p_attempt: ATTEMPT,
      p_status: 'failed',
      p_error: 'amount_too_small',
    });
  });

  it('a card payment on a device without a reader fails cleanly', async () => {
    const be = backend({
      rpc: { begin_payment_attempt: { body: ATTEMPT } },
      attempt: { amount: 3000, tender: 'gateway', order_id: 'o1', device_id: 'd1' },
      reader: null,
    });
    const { stripe, calls } = stripeOk();
    const r = await stripeChargeResponse(
      post('charge', { snapshot: { ...SNAP, tender: 'gateway' } }),
      ENV,
      { fetchImpl: be.fetchImpl, stripe },
    );
    expect(r.status).toBe(502);
    expect(calls).toEqual([]);
    expect(be.rpcCalls('fail_payment_attempt')).toHaveLength(1);
  });
});

describe('POST /api/stripe/cancel', () => {
  it('cancels in the database as the user, then at Stripe', async () => {
    const be = backend({
      rpc: {
        cancel_payment_attempt: {
          body: { status: 'canceled', provider_ref: 'pi_9', tender: 'promptpay', reader_id: null },
        },
      },
    });
    const { stripe, calls } = stripeOk();
    const r = await stripeCancelResponse(post('cancel', { attempt_id: ATTEMPT }), ENV, {
      fetchImpl: be.fetchImpl,
      stripe,
    });
    expect(await r.json()).toEqual({ status: 'canceled' });
    expect(calls).toEqual(['/v1/payment_intents/pi_9/cancel']);
    expect(be.rpcCalls('cancel_payment_attempt')[0]!.headers.Authorization).toBe('Bearer user-jwt');
  });
  it('a payment that already went through is not touched at Stripe', async () => {
    const be = backend({
      rpc: {
        cancel_payment_attempt: {
          body: { status: 'succeeded', provider_ref: 'pi_9', tender: 'promptpay', reader_id: null },
        },
      },
    });
    const { stripe, calls } = stripeOk();
    const r = await stripeCancelResponse(post('cancel', { attempt_id: ATTEMPT }), ENV, {
      fetchImpl: be.fetchImpl,
      stripe,
    });
    expect(await r.json()).toEqual({ status: 'succeeded' });
    expect(calls).toEqual([]);
  });
  it('refuses bad ids, anonymous callers and forbidden users', async () => {
    expect(
      (
        await stripeCancelResponse(post('cancel', { attempt_id: 'x' }), ENV, {
          fetchImpl: backend().fetchImpl,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await stripeCancelResponse(post('cancel', { attempt_id: ATTEMPT }, {}), ENV, {
          fetchImpl: backend().fetchImpl,
        })
      ).status,
    ).toBe(403);
    const be = backend({
      rpc: { cancel_payment_attempt: { status: 400, body: { code: '42501' } } },
    });
    expect(
      (
        await stripeCancelResponse(post('cancel', { attempt_id: ATTEMPT }), ENV, {
          fetchImpl: be.fetchImpl,
        })
      ).status,
    ).toBe(403);
  });
});

describe('POST /api/stripe/webhook', () => {
  const event = (type: string, object: Record<string, unknown>, id = 'evt_1') =>
    JSON.stringify({ id, type, data: { object } });
  const hook = (body: string, header: string | null = sign(body, Math.floor(Date.now() / 1000))) =>
    new Request('https://x/api/stripe/webhook', {
      method: 'POST',
      headers: header ? { 'stripe-signature': header } : {},
      body,
    });
  const pi = {
    id: 'pi_9',
    amount: 21000,
    amount_received: 21000,
    currency: 'thb',
    metadata: { attempt_id: ATTEMPT },
  };

  it('refuses a bad signature without touching the database', async () => {
    const be = backend();
    const body = event('payment_intent.succeeded', pi);
    expect(
      (
        await stripeWebhookResponse(hook(body, 't=1,v1=' + '0'.repeat(64)), ENV, {
          fetchImpl: be.fetchImpl,
        })
      ).status,
    ).toBe(400);
    expect(
      (await stripeWebhookResponse(hook(body, null), ENV, { fetchImpl: be.fetchImpl })).status,
    ).toBe(400);
    expect(be.calls).toEqual([]);
  });

  it('a succeeded payment confirms the attempt with the amount and currency STRIPE reports', async () => {
    const be = backend({ rpc: { confirm_payment_attempt: { body: 'paid' } } });
    const r = await stripeWebhookResponse(hook(event('payment_intent.succeeded', pi)), ENV, {
      fetchImpl: be.fetchImpl,
    });
    expect(r.status).toBe(200);
    expect(be.rpcCalls('confirm_payment_attempt')[0]!.body).toEqual({
      p_attempt: ATTEMPT,
      p_ref: 'pi_9',
      p_amount: 21000,
      p_currency: 'thb',
    });
    expect(be.rpcCalls('confirm_payment_attempt')[0]!.headers.Authorization).toBe(
      'Bearer service-key',
    );
    expect(be.rpcCalls('record_stripe_event')[0]!.body).toEqual({
      p_id: 'evt_1',
      p_type: 'payment_intent.succeeded',
    });
  });

  it('when the database cannot confirm, answer 500 so Stripe retries (and do NOT mark the event as handled)', async () => {
    const be = backend({
      rpc: { confirm_payment_attempt: { status: 500, body: { code: 'XX000' } } },
    });
    const r = await stripeWebhookResponse(hook(event('payment_intent.succeeded', pi)), ENV, {
      fetchImpl: be.fetchImpl,
    });
    expect(r.status).toBe(500);
    expect(be.rpcCalls('record_stripe_event')).toHaveLength(0);
  });

  it('a payment that needs review still answers 200 (Stripe must not retry it forever)', async () => {
    const be = backend({ rpc: { confirm_payment_attempt: { body: 'needs_review' } } });
    expect(
      (
        await stripeWebhookResponse(hook(event('payment_intent.succeeded', pi)), ENV, {
          fetchImpl: be.fetchImpl,
        })
      ).status,
    ).toBe(200);
  });

  it('failed and canceled payments close the attempt; unrelated events and foreign intents are ignored', async () => {
    const be = backend();
    await stripeWebhookResponse(
      hook(
        event(
          'payment_intent.payment_failed',
          { ...pi, last_payment_error: { code: 'card_declined' } },
          'evt_2',
        ),
      ),
      ENV,
      { fetchImpl: be.fetchImpl },
    );
    await stripeWebhookResponse(hook(event('payment_intent.canceled', pi, 'evt_3')), ENV, {
      fetchImpl: be.fetchImpl,
    });
    expect(be.rpcCalls('fail_payment_attempt').map((c) => c.body)).toEqual([
      { p_attempt: ATTEMPT, p_status: 'failed', p_error: 'card_declined' },
      { p_attempt: ATTEMPT, p_status: 'canceled', p_error: 'payment_intent.canceled' },
    ]);
    const other = backend();
    expect(
      (
        await stripeWebhookResponse(hook(event('charge.refunded', pi)), ENV, {
          fetchImpl: other.fetchImpl,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await stripeWebhookResponse(
          hook(
            event('payment_intent.succeeded', {
              id: 'pi_x',
              amount: 1,
              currency: 'thb',
              metadata: {},
            }),
          ),
          ENV,
          { fetchImpl: other.fetchImpl },
        )
      ).status,
    ).toBe(200);
    expect(other.rpcCalls('confirm_payment_attempt')).toHaveLength(0);
  });

  it('only POST, and only when configured', async () => {
    expect(
      (await stripeWebhookResponse(new Request('https://x/api/stripe/webhook'), ENV)).status,
    ).toBe(405);
    expect((await stripeWebhookResponse(hook('{}'), {})).status).toBe(503);
  });
});

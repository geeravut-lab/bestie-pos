import { describe, expect, it, vi } from 'vitest';
import {
  GATEWAYS,
  activeGatewayId,
  gatewayFromEnv,
  gatewayReady,
  stripeGateway,
} from './gateway.js';
import type { GatewayEvent, PaymentGateway } from './gateway.js';
import {
  paymentCancelResponse,
  paymentChargeResponse,
  paymentWebhookResponse,
} from './payment-handler.js';

const ATTEMPT = '11111111-2222-4333-8444-555555555555';
const ENV = {
  SUPABASE_URL: 'https://db.example.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  VITE_SUPABASE_ANON_KEY: 'anon',
};
const STRIPE_ENV = {
  ...ENV,
  STRIPE_SECRET_KEY: 'sk_test_abc',
  STRIPE_WEBHOOK_SECRET: 'whsec_abc',
};

/** A second provider, written only against the interface: it has its own webhook signature scheme ("x-acme-sig"). */
function acme(events: Record<string, GatewayEvent> = {}) {
  const calls: string[] = [];
  const gw: PaymentGateway = {
    id: 'acme',
    async startPromptPay(p) {
      calls.push(`qr:${p.amount}`);
      return { providerRef: 'acme_1', qrImageUrl: 'https://acme.example/qr.png', qrData: null };
    },
    async startReader(p) {
      calls.push(`reader:${p.readerId}`);
      return { providerRef: 'acme_2', qrImageUrl: null, qrData: null };
    },
    async cancel(p) {
      calls.push(`cancel:${p.providerRef}`);
    },
    readWebhook({ rawBody, headers }) {
      if (headers.get('x-acme-sig') !== 'good') return null;
      return events[rawBody] ?? { kind: 'ignored', eventId: null, type: 'noop' };
    },
  };
  return { gw, calls };
}

type Call = { fn: string; body: Record<string, unknown> };
function backend(over: { attemptProvider?: string; rpc?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url.endsWith('/auth/v1/user')) return json({ id: 'user-1' });
    const fn = /\/rest\/v1\/rpc\/(\w+)/.exec(url)?.[1];
    if (fn) {
      calls.push({ fn, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> });
      return json(over.rpc?.[fn] ?? null);
    }
    if (url.includes('/rest/v1/payment_attempts'))
      return json([
        {
          amount: 21000,
          tender: 'promptpay',
          order_id: 'o1',
          device_id: 'd1',
          provider: over.attemptProvider ?? 'acme',
        },
      ]);
    if (url.includes('/rest/v1/devices')) return json([{ stripe_reader_id: 'rd_1' }]);
    return json({}, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, of: (fn: string) => calls.filter((c) => c.fn === fn) };
}

describe('the gateway registry', () => {
  it('uses Stripe by default and only when its secrets are set', () => {
    expect(activeGatewayId({})).toBe('stripe');
    expect(gatewayFromEnv(ENV)).toBeNull();
    expect(gatewayReady(ENV)).toBe(false);
    expect(gatewayFromEnv(STRIPE_ENV)?.id).toBe('stripe');
    expect(gatewayReady(STRIPE_ENV)).toBe(true);
  });

  it('PAYMENT_GATEWAY picks the provider; an unknown name is refused, never replaced by another provider', () => {
    expect(activeGatewayId({ PAYMENT_GATEWAY: ' Acme ' })).toBe('acme');
    expect(gatewayFromEnv({ ...STRIPE_ENV, PAYMENT_GATEWAY: 'acme' })).toBeNull();
    expect(gatewayReady({ ...STRIPE_ENV, PAYMENT_GATEWAY: 'nope' })).toBe(false);
  });

  it('a new provider is one registry line', () => {
    const { gw } = acme();
    GATEWAYS.acme = () => gw;
    try {
      expect(gatewayFromEnv({ PAYMENT_GATEWAY: 'acme' })?.id).toBe('acme');
      expect(gatewayReady({ PAYMENT_GATEWAY: 'acme' })).toBe(true);
    } finally {
      delete GATEWAYS.acme;
    }
  });

  it('a gateway handed in (a test, a second provider) wins over the environment', () => {
    const { gw } = acme();
    expect(gatewayFromEnv({}, { gateway: gw })).toBe(gw);
  });
});

describe('the Stripe adapter', () => {
  const gw = stripeGateway(
    { post: vi.fn() },
    { webhookSecret: 'whsec_abc', siteHost: 'x.example' },
  );
  it('refuses an unsigned or badly signed webhook (null = answer 400)', () => {
    expect(gw.readWebhook({ rawBody: '{}', headers: new Headers() })).toBeNull();
    expect(
      gw.readWebhook({
        rawBody: '{}',
        headers: new Headers({ 'stripe-signature': `t=1,v1=${'0'.repeat(64)}` }),
      }),
    ).toBeNull();
  });
});

describe('the handlers with a different provider', () => {
  const till = (body: unknown) =>
    new Request('https://x/api/pay/charge', {
      method: 'POST',
      headers: { authorization: 'Bearer tok' },
      body: JSON.stringify(body),
    });

  it('start the QR through the provider and record which provider it was', async () => {
    const { gw, calls } = acme();
    const be = backend({ rpc: { begin_payment_attempt: ATTEMPT } });
    const r = await paymentChargeResponse(till({ snapshot: { order_id: 'o1' } }), ENV, {
      fetchImpl: be.fetchImpl,
      gateway: gw,
    });
    expect(r.status).toBe(200);
    expect(calls).toEqual(['qr:21000']);
    expect(await r.json()).toMatchObject({ qr_image_url: 'https://acme.example/qr.png' });
    expect(be.of('attach_payment_intent')[0]!.body).toMatchObject({
      p_ref: 'acme_1',
      p_provider: 'acme',
    });
  });

  it('say "not configured" when no provider is set up', async () => {
    const r = await paymentChargeResponse(till({ snapshot: {} }), ENV, {
      fetchImpl: backend().fetchImpl,
    });
    expect(r.status).toBe(503);
  });

  it('cancel through the provider', async () => {
    const { gw, calls } = acme();
    const be = backend({
      rpc: {
        cancel_payment_attempt: { status: 'canceled', provider_ref: 'acme_1', tender: 'promptpay' },
      },
    });
    const r = await paymentCancelResponse(till({ attempt_id: ATTEMPT }), ENV, {
      fetchImpl: be.fetchImpl,
      gateway: gw,
    });
    expect(r.status).toBe(200);
    expect(calls).toEqual(['cancel:acme_1']);
  });

  const hook = (raw: string, sig: string | null) =>
    new Request('https://x/api/acme/webhook', {
      method: 'POST',
      headers: sig ? { 'x-acme-sig': sig } : {},
      body: raw,
    });
  const paid: GatewayEvent = {
    kind: 'succeeded',
    eventId: 'ev_1',
    type: 'charge.paid',
    attemptId: ATTEMPT,
    providerRef: 'acme_1',
    amount: 21000,
    currency: 'thb',
  };

  it('a webhook with a wrong signature is refused before the database is touched', async () => {
    const { gw } = acme({ paid: paid });
    const be = backend();
    const r = await paymentWebhookResponse(hook('paid', 'bad'), ENV, {
      fetchImpl: be.fetchImpl,
      gateway: gw,
    });
    expect(r.status).toBe(400);
    expect(be.calls).toEqual([]);
  });

  it("the provider's own signed 'paid' confirms the attempt (amount and currency from the provider)", async () => {
    const { gw } = acme({ paid });
    const be = backend({ rpc: { confirm_payment_attempt: 'paid' } });
    const r = await paymentWebhookResponse(hook('paid', 'good'), ENV, {
      fetchImpl: be.fetchImpl,
      gateway: gw,
    });
    expect(r.status).toBe(200);
    expect(be.of('confirm_payment_attempt')[0]!.body).toEqual({
      p_attempt: ATTEMPT,
      p_ref: 'acme_1',
      p_amount: 21000,
      p_currency: 'thb',
    });
    expect(be.of('record_stripe_event')[0]!.body).toEqual({ p_id: 'ev_1', p_type: 'charge.paid' });
  });

  it('a provider can never settle an attempt that another provider started', async () => {
    const { gw } = acme({ paid });
    const be = backend({ attemptProvider: 'stripe' });
    const r = await paymentWebhookResponse(hook('paid', 'good'), ENV, {
      fetchImpl: be.fetchImpl,
      gateway: gw,
    });
    expect(r.status).toBe(200);
    expect(be.of('confirm_payment_attempt')).toEqual([]);
  });

  it('failed / canceled events close the attempt; events Bestie does not care about change nothing', async () => {
    const { gw } = acme({
      f: {
        kind: 'failed',
        eventId: null,
        type: 'charge.failed',
        attemptId: ATTEMPT,
        error: 'declined',
      },
      c: {
        kind: 'canceled',
        eventId: null,
        type: 'charge.canceled',
        attemptId: ATTEMPT,
        error: 'x',
      },
    });
    const be = backend();
    for (const raw of ['f', 'c', 'other'])
      await paymentWebhookResponse(hook(raw, 'good'), ENV, {
        fetchImpl: be.fetchImpl,
        gateway: gw,
      });
    expect(be.of('fail_payment_attempt').map((c) => c.body)).toEqual([
      { p_attempt: ATTEMPT, p_status: 'failed', p_error: 'declined' },
      { p_attempt: ATTEMPT, p_status: 'canceled', p_error: 'x' },
    ]);
    expect(be.of('confirm_payment_attempt')).toEqual([]);
  });
});

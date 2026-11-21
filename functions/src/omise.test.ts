import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GatewayError } from './gateway-error.js';
import { activeGatewayId, gatewayFromEnv } from './gateway.js';
import { createOmiseClient, omiseConfig, omiseGateway, verifyOmiseSignature } from './omise.js';

const SECRET = Buffer.from('endpoint-secret').toString('base64');
const ATT = '11111111-2222-4333-8444-555555555555';
const sign = (body: string, ts: string) =>
  createHmac('sha256', Buffer.from(SECRET, 'base64')).update(`${ts}.${body}`).digest('hex');
const now = () => String(Math.floor(Date.now() / 1000));
const hdr = (body: string, ts = now(), sig = sign(body, ts)) =>
  new Headers({ 'omise-signature': sig, 'omise-signature-timestamp': ts });
const cfg = { secretKey: 'skey_test_abc', webhookSecret: SECRET };
const charge = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'evnt_1',
    key: 'charge.complete',
    data: {
      id: 'chrg_1',
      amount: 12000,
      currency: 'THB',
      status: 'successful',
      metadata: { attempt_id: ATT },
      ...over,
    },
  });

describe('omiseConfig', () => {
  it('needs a secret key (never a public key) and the webhook secret', () => {
    expect(omiseConfig({ OMISE_SECRET_KEY: 'skey_test_abc', OMISE_WEBHOOK_SECRET: 'x' })).toEqual({
      secretKey: 'skey_test_abc',
      webhookSecret: 'x',
    });
    expect(
      omiseConfig({ OMISE_SECRET_KEY: 'pkey_test_abc', OMISE_WEBHOOK_SECRET: 'x' }),
    ).toBeNull();
    expect(omiseConfig({ OMISE_SECRET_KEY: 'skey_test_abc' })).toBeNull();
  });
});

describe('Omise webhook signature', () => {
  it('accepts the genuine signature, any one of several, and refuses a wrong body, secret or an old timestamp', () => {
    const body = charge();
    const ts = now();
    const base = { rawBody: body, timestamp: ts, secret: SECRET };
    expect(verifyOmiseSignature({ ...base, signature: sign(body, ts) })).toBe(true);
    expect(
      verifyOmiseSignature({ ...base, signature: `${'0'.repeat(64)}, ${sign(body, ts)}` }),
    ).toBe(true);
    expect(verifyOmiseSignature({ ...base, signature: sign(body + ' ', ts) })).toBe(false);
    expect(
      verifyOmiseSignature({
        ...base,
        signature: sign(body, ts),
        secret: Buffer.from('other').toString('base64'),
      }),
    ).toBe(false);
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect(verifyOmiseSignature({ ...base, timestamp: old, signature: sign(body, old) })).toBe(
      false,
    );
    expect(verifyOmiseSignature({ ...base, signature: null })).toBe(false);
  });
});

describe('Omise gateway', () => {
  const gw = omiseGateway({ post: vi.fn() }, cfg);
  it('a successful charge is "succeeded" with the amount in satang and the currency in lower case', () => {
    const body = charge();
    expect(gw.readWebhook({ rawBody: body, headers: hdr(body) })).toEqual({
      kind: 'succeeded',
      eventId: 'evnt_1',
      type: 'charge.complete',
      attemptId: ATT,
      providerRef: 'chrg_1',
      amount: 12000,
      currency: 'thb',
    });
  });
  it('a bad signature is null (answer 400); other events and foreign charges are ignored; failures and expiries are told apart', () => {
    const body = charge();
    expect(gw.readWebhook({ rawBody: body, headers: hdr(body, now(), '0'.repeat(64)) })).toBeNull();
    const other = JSON.stringify({ id: 'e2', key: 'customer.create', data: {} });
    expect(gw.readWebhook({ rawBody: other, headers: hdr(other) })?.kind).toBe('ignored');
    const noAttempt = charge({ metadata: {} });
    expect(gw.readWebhook({ rawBody: noAttempt, headers: hdr(noAttempt) })?.kind).toBe('ignored');
    const failed = charge({ status: 'failed', failure_code: 'insufficient_fund' });
    expect(gw.readWebhook({ rawBody: failed, headers: hdr(failed) })).toMatchObject({
      kind: 'failed',
      error: 'insufficient_fund',
    });
    const expired = charge({ status: 'expired' });
    expect(gw.readWebhook({ rawBody: expired, headers: hdr(expired) })).toMatchObject({
      kind: 'canceled',
      error: 'expired',
    });
    const pending = charge({ status: 'pending' });
    expect(gw.readWebhook({ rawBody: pending, headers: hdr(pending) })?.kind).toBe('ignored');
  });
  it('starts a PromptPay charge with our attempt id, the exact amount and nothing about the customer; returns the QR', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return Response.json({
        object: 'charge',
        id: 'chrg_9',
        status: 'pending',
        source: { scannable_code: { image: { download_uri: 'https://qr.example/x.png' } } },
      });
    }) as unknown as typeof fetch;
    const g = omiseGateway(createOmiseClient('skey_test_abc', fetchImpl), cfg);
    const r = await g.startPromptPay({ attemptId: ATT, orderId: 'o-1', amount: 12000 });
    expect(r).toEqual({
      providerRef: 'chrg_9',
      qrImageUrl: 'https://qr.example/x.png',
      qrData: null,
    });
    expect(calls[0]!.url).toBe('https://api.omise.co/charges');
    const body = new URLSearchParams(String(calls[0]!.init.body));
    expect(body.get('amount')).toBe('12000');
    expect(body.get('currency')).toBe('thb');
    expect(body.get('source[type]')).toBe('promptpay');
    expect(body.get('metadata[attempt_id]')).toBe(ATT);
    expect([...body.keys()].some((k) => /name|phone|email|customer/i.test(k))).toBe(false);
    expect((calls[0]!.init.headers as Record<string, string>)['Idempotency-Key']).toBe(
      `bestie-attempt-${ATT}`,
    );
  });
  it('a card reader is refused with a clear code, and an error from Omise is a GatewayError', async () => {
    await expect(
      gw.startReader({ attemptId: ATT, orderId: null, amount: 1000, readerId: 'r' }),
    ).rejects.toMatchObject({
      status: 501,
      code: 'reader_not_supported',
    });
    const bad = vi.fn(async () =>
      Response.json({ object: 'error', code: 'invalid_charge', message: 'x' }, { status: 400 }),
    ) as unknown as typeof fetch;
    await expect(
      omiseGateway(createOmiseClient('skey_test_abc', bad), cfg).startPromptPay({
        attemptId: ATT,
        orderId: null,
        amount: 1000,
      }),
    ).rejects.toBeInstanceOf(GatewayError);
  });
});

describe('the registry', () => {
  it('omise is chosen only by PAYMENT_GATEWAY, needs both secrets, and never falls back to Stripe', () => {
    expect(activeGatewayId({ PAYMENT_GATEWAY: 'Omise' })).toBe('omise');
    expect(gatewayFromEnv({ PAYMENT_GATEWAY: 'omise' })).toBeNull();
    const g = gatewayFromEnv({
      PAYMENT_GATEWAY: 'omise',
      OMISE_SECRET_KEY: 'skey_test_abc',
      OMISE_WEBHOOK_SECRET: SECRET,
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_WEBHOOK_SECRET: 'whsec',
    });
    expect(g?.id).toBe('omise');
  });
});

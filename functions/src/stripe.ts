/**
 * Stripe, the small part Bestie needs: PromptPay QR + card reader payments (server-driven Terminal), confirmed by a SIGNED
 * webhook. No SDK: a form-encoded REST call per step keeps the function small and the behaviour visible.
 *
 * Secrets: STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET live only in Vercel env. They are never logged and never returned.
 * Card data never touches Bestie (the reader / Stripe handle it); we store Stripe's ids and amounts only.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { GatewayError } from './gateway-error.js';

export type StripeConfig = { secretKey: string; webhookSecret: string; siteHost: string };

export function stripeConfig(env: Record<string, string | undefined>): StripeConfig | null {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim();
  // a publishable key (pk_) must never be accepted here: it cannot create charges and its use would be a mix-up
  if (!secretKey || !/^(sk|rk)_(test|live)_/.test(secretKey) || !webhookSecret) return null;
  let siteHost = 'bestie-pos.vercel.app';
  try {
    siteHost = new URL(env.VITE_SITE_URL?.trim() || `https://${siteHost}`).host;
  } catch {
    /* keep the default */
  }
  return { secretKey, webhookSecret, siteHost };
}

// ── webhook signature ───────────────────────────────────────────────────────
/**
 * `Stripe-Signature: t=<unix>,v1=<hex hmac>[,v1=…]` — the HMAC-SHA256 is over `<t>.<raw body>` with the endpoint secret.
 * A timestamp older than `toleranceSec` is refused (replay protection). Constant-time comparison.
 */
export function verifyStripeSignature(p: {
  rawBody: string;
  header: string | null;
  secret: string;
  nowMs?: number;
  toleranceSec?: number;
}): boolean {
  if (!p.header) return false;
  const parts = p.header.split(',').map((s) => s.trim().split('=') as [string, string]);
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
  if (!t || !/^\d{1,12}$/.test(t) || sigs.length === 0) return false;
  const ageSec = Math.abs((p.nowMs ?? Date.now()) / 1000 - Number(t));
  if (ageSec > (p.toleranceSec ?? 300)) return false;
  const expected = createHmac('sha256', p.secret).update(`${t}.${p.rawBody}`).digest();
  return sigs.some((s) => {
    if (!/^[0-9a-f]{64}$/i.test(s)) return false;
    const given = Buffer.from(s, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

// ── REST client ─────────────────────────────────────────────────────────────
/** Stripe wants `a[b][c]=v` and `a[]=v` forms; nested objects and arrays are flattened. */
export function stripeForm(params: Record<string, unknown>): string {
  const out: string[] = [];
  const add = (key: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x) => add(`${key}[]`, x));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) add(`${key}[${k}]`, x);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  return out.join('&');
}

export class StripeError extends GatewayError {
  constructor(status: number, code: string) {
    super(status, code);
    this.name = 'StripeError';
  }
}

export type StripeClient = {
  /** Read (reconciliation); optional so a test double with only `post` still fits. */
  get?: (path: string, query?: Record<string, string | number>) => Promise<Record<string, unknown>>;
  post: (
    path: string,
    params?: Record<string, unknown>,
    idempotencyKey?: string,
  ) => Promise<Record<string, unknown>>;
};

export function createStripeClient(
  secretKey: string,
  fetchImpl: typeof fetch = fetch,
): StripeClient {
  return {
    async get(path, query = {}) {
      const qs = new URLSearchParams(
        Object.entries(query).map(([k, v]) => [k, String(v)]),
      ).toString();
      const res = await fetchImpl(`https://api.stripe.com${path}${qs ? `?${qs}` : ''}`, {
        headers: { Authorization: `Bearer ${secretKey}` },
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
        error?: { code?: string; type?: string };
      };
      if (!res.ok)
        throw new StripeError(res.status, json.error?.code ?? json.error?.type ?? 'unknown');
      return json;
    },
    async post(path, params = {}, idempotencyKey) {
      const res = await fetchImpl(`https://api.stripe.com${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: stripeForm(params),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
        error?: { code?: string; type?: string };
      };
      if (!res.ok)
        throw new StripeError(res.status, json.error?.code ?? json.error?.type ?? 'unknown');
      return json;
    },
  };
}

/** What we tell Stripe about a payment: our attempt id (the webhook's key) and, for a bill, the bill — nothing about the customer. */
const metadataFor = (p: { attemptId: string; orderId: string | null }): Record<string, string> =>
  p.orderId
    ? { attempt_id: p.attemptId, order_id: p.orderId }
    : { attempt_id: p.attemptId, kind: 'credit_topup' };

// ── starting a payment ──────────────────────────────────────────────────────
export type StartedPayment = {
  providerRef: string;
  /** PromptPay only: what the guest scans. */
  qrImageUrl: string | null;
  qrData: string | null;
};

/**
 * PromptPay: a PaymentIntent confirmed straight away; Stripe answers with the QR the guest scans.
 * Stripe requires an e-mail for PromptPay; a walk-in guest has none, so a neutral address on OUR host is used and no
 * receipt e-mail is requested (docs/DECISIONS.md — to be verified with a Stripe test key).
 */
export async function startPromptPay(
  stripe: StripeClient,
  p: { attemptId: string; orderId: string | null; amount: number; siteHost: string },
): Promise<StartedPayment> {
  const pi = await stripe.post(
    '/v1/payment_intents',
    {
      amount: p.amount,
      currency: 'thb',
      payment_method_types: ['promptpay'],
      payment_method_data: {
        type: 'promptpay',
        billing_details: { email: `pos-${p.attemptId.slice(0, 8)}@${p.siteHost}` },
      },
      confirm: 'true',
      description: `Bestie POS ${p.attemptId.slice(0, 8)}`,
      metadata: metadataFor(p),
    },
    `bestie-attempt-${p.attemptId}`,
  );
  const qr = (
    pi.next_action as {
      promptpay_display_qr_code?: { image_url_png?: string; data?: string };
    } | null
  )?.promptpay_display_qr_code;
  if (typeof pi.id !== 'string' || !qr) throw new StripeError(502, 'no_qr');
  return { providerRef: pi.id, qrImageUrl: qr.image_url_png ?? null, qrData: qr.data ?? null };
}

/** Card: a card_present PaymentIntent handed to the shop's own reader (server-driven Terminal — no SDK in the browser). */
export async function startReaderPayment(
  stripe: StripeClient,
  p: { attemptId: string; orderId: string | null; amount: number; readerId: string },
): Promise<StartedPayment> {
  const pi = await stripe.post(
    '/v1/payment_intents',
    {
      amount: p.amount,
      currency: 'thb',
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      description: `Bestie POS ${p.attemptId.slice(0, 8)}`,
      metadata: metadataFor(p),
    },
    `bestie-attempt-${p.attemptId}`,
  );
  if (typeof pi.id !== 'string') throw new StripeError(502, 'no_intent');
  await stripe.post(
    `/v1/terminal/readers/${encodeURIComponent(p.readerId)}/process_payment_intent`,
    { payment_intent: pi.id },
  );
  return { providerRef: pi.id, qrImageUrl: null, qrData: null };
}

/** Best effort: stop the reader and cancel the intent. A payment that already went through is NOT undone by this. */
export async function cancelProviderPayment(
  stripe: StripeClient,
  p: { providerRef: string; readerId: string | null },
): Promise<void> {
  if (p.readerId) {
    try {
      await stripe.post(`/v1/terminal/readers/${encodeURIComponent(p.readerId)}/cancel_action`);
    } catch {
      /* the reader may be idle already */
    }
  }
  try {
    await stripe.post(`/v1/payment_intents/${encodeURIComponent(p.providerRef)}/cancel`);
  } catch (e) {
    // already succeeded / already canceled: the webhook (or the earlier cancel) is the source of truth
    if (!(e instanceof StripeError)) throw e;
  }
}

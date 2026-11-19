import { readServerEnv } from './env.js';
import { createRateLimiter } from './line.js';
import {
  StripeError,
  cancelProviderPayment,
  createStripeClient,
  startPromptPay,
  startReaderPayment,
  stripeConfig,
  verifyStripeSignature,
} from './stripe.js';
import type { StripeClient } from './stripe.js';

type Env = Record<string, string | undefined>;
const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });

export type StripeDeps = { fetchImpl?: typeof fetch; stripe?: StripeClient };

const allowCharge = createRateLimiter(30, 60_000); // per signed-in user: a till does not need more

/** Calls a Postgres function through Supabase REST. `bearer` = a user's JWT (RLS applies) or the service key. */
type Rpc = { ok: boolean; status: number; code: string | null; data: unknown };
async function rpc(
  fetchImpl: typeof fetch,
  env: { url: string; apikey: string; bearer: string },
  fn: string,
  args: Record<string, unknown>,
): Promise<Rpc> {
  const res = await fetchImpl(`${env.url}/rest/v1/rpc/${fn}`, {
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

async function selectOne<T>(
  fetchImpl: typeof fetch,
  url: string,
  serviceKey: string,
  path: string,
): Promise<T | null> {
  const res = await fetchImpl(`${url}/rest/v1/${path}`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  if (!res.ok) return null;
  const rows = (await res.json()) as T[];
  return rows[0] ?? null;
}

async function bearerOf(
  request: Request,
  url: string,
  serviceKey: string,
  fetchImpl: typeof fetch,
) {
  const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!token) return null;
  try {
    const res = await fetchImpl(`${url}/auth/v1/user`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${token}` },
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

/** A refusal from the database function → the HTTP answer the till understands. */
function refusal(r: Rpc): Response {
  if (r.code === '42501') return reply({ error: 'forbidden' }, 403);
  if (r.code === '23505') return reply({ error: 'attempt_pending' }, 409);
  if (r.code === 'P0002') return reply({ error: 'not_found' }, 404);
  if (r.code === '0A000') return reply({ error: 'module_off' }, 403);
  if (r.code === '23514' || r.code === '22023') return reply({ error: 'invalid' }, 422);
  return reply({ error: 'server_error' }, 502);
}

/**
 * POST /api/stripe/charge — the till asks for a PromptPay QR or a card-reader payment for ONE bill.
 *   body: { snapshot: { order_id, device_id, staff_id, tender, subtotal, … payable } }   (what the till showed the guest)
 * The database function checks permission and the bill; only then is Stripe called. Nothing is "paid" here.
 */
export async function stripeChargeResponse(
  request: Request,
  env: Env = process.env,
  deps: StripeDeps = {},
): Promise<Response> {
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
  const cfg = stripeConfig(env);
  if (!cfg) return reply({ error: 'not_configured' }, 503);
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const who = await bearerOf(request, supabaseUrl, serviceRoleKey, fetchImpl);
    if (!who) return reply({ error: 'forbidden' }, 403);
    if (!allowCharge(`charge:${who.userId}`)) return reply({ error: 'rate_limited' }, 429);
    const body = (await request.json().catch(() => null)) as {
      snapshot?: Record<string, unknown>;
      topup?: Record<string, unknown>;
    } | null;
    const isObj = (v: unknown): v is Record<string, unknown> =>
      !!v && typeof v === 'object' && !Array.isArray(v);
    // a bill (snapshot) or a Bestie Credit top-up (customer + amount): the database function decides, with the person's own token
    if (isObj(body?.snapshot) === isObj(body?.topup)) return reply({ error: 'invalid' }, 422);

    const asUser = { url: supabaseUrl, apikey: anonKey(env) ?? serviceRoleKey, bearer: who.token };
    const begun = isObj(body?.snapshot)
      ? await rpc(fetchImpl, asUser, 'begin_payment_attempt', { p: body.snapshot })
      : await rpc(fetchImpl, asUser, 'begin_credit_topup_attempt', { p: body?.topup });
    if (!begun.ok || typeof begun.data !== 'string') return refusal(begun);
    const attemptId = begun.data;

    const svc = { url: supabaseUrl, apikey: serviceRoleKey, bearer: serviceRoleKey };
    const attempt = await selectOne<{
      amount: number;
      tender: 'promptpay' | 'gateway';
      order_id: string | null;
      device_id: string;
    }>(
      fetchImpl,
      supabaseUrl,
      serviceRoleKey,
      `payment_attempts?id=eq.${attemptId}&select=amount,tender,order_id,device_id`,
    );
    if (!attempt) return reply({ error: 'server_error' }, 502);
    // 0A000 = Credit switched off in this shop (refusal() maps the other codes)
    const stripe = deps.stripe ?? createStripeClient(cfg.secretKey, fetchImpl);

    try {
      let started;
      if (attempt.tender === 'promptpay') {
        started = await startPromptPay(stripe, {
          attemptId,
          orderId: attempt.order_id,
          amount: attempt.amount,
          siteHost: cfg.siteHost,
        });
      } else {
        const dev = await selectOne<{ stripe_reader_id: string | null }>(
          fetchImpl,
          supabaseUrl,
          serviceRoleKey,
          `devices?id=eq.${attempt.device_id}&select=stripe_reader_id`,
        );
        if (!dev?.stripe_reader_id) throw new StripeError(422, 'no_reader');
        started = await startReaderPayment(stripe, {
          attemptId,
          orderId: attempt.order_id,
          amount: attempt.amount,
          readerId: dev.stripe_reader_id,
        });
      }
      const expires = new Date(Date.now() + 15 * 60_000).toISOString();
      await rpc(fetchImpl, svc, 'attach_payment_intent', {
        p_attempt: attemptId,
        p_ref: started.providerRef,
        p_qr: started.qrImageUrl,
        p_expires: expires,
      });
      return reply({
        attempt_id: attemptId,
        tender: attempt.tender,
        amount: attempt.amount,
        qr_image_url: started.qrImageUrl,
        expires_at: expires,
      });
    } catch (e) {
      const code = e instanceof StripeError ? e.code : 'provider_error';
      console.error('[stripe] start failed', code);
      await rpc(fetchImpl, svc, 'fail_payment_attempt', {
        p_attempt: attemptId,
        p_status: 'failed',
        p_error: code,
      });
      return reply({ error: 'provider_error', code }, 502);
    }
  } catch (e) {
    console.error('[stripe] charge failed', e instanceof Error ? e.message : 'unknown');
    return reply({ error: 'server_error' }, 500);
  }
}

/** POST /api/stripe/cancel  { attempt_id } — stop waiting: cancels at Stripe too. A payment that already went through still closes the bill via the webhook. */
export async function stripeCancelResponse(
  request: Request,
  env: Env = process.env,
  deps: StripeDeps = {},
): Promise<Response> {
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
  const cfg = stripeConfig(env);
  if (!cfg) return reply({ error: 'not_configured' }, 503);
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const who = await bearerOf(request, supabaseUrl, serviceRoleKey, fetchImpl);
    if (!who) return reply({ error: 'forbidden' }, 403);
    const body = (await request.json().catch(() => null)) as { attempt_id?: unknown } | null;
    if (typeof body?.attempt_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.attempt_id))
      return reply({ error: 'invalid' }, 422);
    const asUser = { url: supabaseUrl, apikey: anonKey(env) ?? serviceRoleKey, bearer: who.token };
    const r = await rpc(fetchImpl, asUser, 'cancel_payment_attempt', {
      p_attempt: body.attempt_id,
    });
    if (!r.ok) return refusal(r);
    const out = r.data as {
      status?: string;
      provider_ref?: string | null;
      reader_id?: string | null;
      tender?: string;
    };
    if (out.status === 'canceled' && out.provider_ref) {
      const stripe = deps.stripe ?? createStripeClient(cfg.secretKey, fetchImpl);
      await cancelProviderPayment(stripe, {
        providerRef: out.provider_ref,
        readerId: out.tender === 'gateway' ? (out.reader_id ?? null) : null,
      });
    }
    return reply({ status: out.status ?? 'unknown' });
  } catch (e) {
    console.error('[stripe] cancel failed', e instanceof Error ? e.message : 'unknown');
    return reply({ error: 'server_error' }, 500);
  }
}

type StripeEvent = {
  id?: string;
  type?: string;
  data?: {
    object?: {
      id?: string;
      amount?: number;
      amount_received?: number;
      currency?: string;
      metadata?: Record<string, string>;
      last_payment_error?: { code?: string };
    };
  };
};

/**
 * POST /api/stripe/webhook — Stripe → us. Raw body first, signature second, JSON last.
 * `payment_intent.succeeded` is the ONLY thing that closes a bill here. Answers: 400 bad signature · 200 handled / ignored ·
 * 500 we could not process it (Stripe retries — the database functions are safe to repeat).
 */
export async function stripeWebhookResponse(
  request: Request,
  env: Env = process.env,
  deps: StripeDeps = {},
): Promise<Response> {
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
  const cfg = stripeConfig(env);
  if (!cfg) return reply({ error: 'not_configured' }, 503);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const rawBody = await request.text(); // BEFORE any JSON parsing: the signature is over the exact bytes
  if (
    !verifyStripeSignature({
      rawBody,
      header: request.headers.get('stripe-signature'),
      secret: cfg.webhookSecret,
    })
  )
    return reply({ error: 'bad_signature' }, 400);
  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return reply({ error: 'bad_payload' }, 400);
  }
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const svc = { url: supabaseUrl, apikey: serviceRoleKey, bearer: serviceRoleKey };
    const obj = event.data?.object;
    const attemptId = obj?.metadata?.attempt_id;
    const known = typeof attemptId === 'string' && /^[0-9a-f-]{36}$/i.test(attemptId);

    if (event.type === 'payment_intent.succeeded' && known && typeof obj?.id === 'string') {
      const r = await rpc(fetchImpl, svc, 'confirm_payment_attempt', {
        p_attempt: attemptId,
        p_ref: obj.id,
        p_amount: obj.amount_received ?? obj.amount ?? 0,
        p_currency: obj.currency ?? '',
      });
      if (!r.ok) {
        console.error('[stripe] confirm failed', r.code ?? r.status);
        return reply({ error: 'confirm_failed' }, 500);
      }
      if (r.data === 'needs_review') console.error('[stripe] payment needs review', attemptId);
    } else if (
      (event.type === 'payment_intent.payment_failed' ||
        event.type === 'payment_intent.canceled') &&
      known
    ) {
      await rpc(fetchImpl, svc, 'fail_payment_attempt', {
        p_attempt: attemptId,
        p_status: event.type === 'payment_intent.canceled' ? 'canceled' : 'failed',
        p_error: obj?.last_payment_error?.code ?? event.type,
      });
    }
    if (typeof event.id === 'string')
      await rpc(fetchImpl, svc, 'record_stripe_event', {
        p_id: event.id,
        p_type: event.type ?? '',
      });
    return reply({ received: true });
  } catch (e) {
    console.error('[stripe] webhook failed', e instanceof Error ? e.message : 'unknown');
    return reply({ error: 'server_error' }, 500);
  }
}

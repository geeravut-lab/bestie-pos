import { readServerEnv } from './env.js';
import { createRateLimiter } from './line.js';
import { GatewayError, gatewayFromEnv } from './gateway.js';
import type { PaymentGateway } from './gateway.js';
import type { StripeClient } from './stripe.js';

type Env = Record<string, string | undefined>;
const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });

/** `gateway` replaces the configured provider (tests, or a second provider); `stripe` is the Stripe client a test may fake. */
export type PaymentDeps = {
  fetchImpl?: typeof fetch;
  stripe?: StripeClient;
  gateway?: PaymentGateway;
};
export type StripeDeps = PaymentDeps;

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
 * POST /api/<provider>/charge — the till asks for a PromptPay QR or a card-reader payment for ONE bill.
 *   body: { snapshot: { order_id, device_id, staff_id, tender, subtotal, … payable } }   (what the till showed the guest)
 * The database function checks permission and the bill; only then is the provider called. Nothing is "paid" here.
 */
export async function paymentChargeResponse(
  request: Request,
  env: Env = process.env,
  deps: PaymentDeps = {},
): Promise<Response> {
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
  const gateway = gatewayFromEnv(env, deps);
  if (!gateway) return reply({ error: 'not_configured' }, 503);
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

    try {
      let started;
      if (attempt.tender === 'promptpay') {
        started = await gateway.startPromptPay({
          attemptId,
          orderId: attempt.order_id,
          amount: attempt.amount,
        });
      } else {
        const dev = await selectOne<{ reader_id: string | null }>(
          fetchImpl,
          supabaseUrl,
          serviceRoleKey,
          `devices?id=eq.${attempt.device_id}&select=reader_id`,
        );
        if (!dev?.reader_id) throw new GatewayError(422, 'no_reader');
        started = await gateway.startReader({
          attemptId,
          orderId: attempt.order_id,
          amount: attempt.amount,
          readerId: dev.reader_id,
        });
      }
      const expires = new Date(Date.now() + 15 * 60_000).toISOString();
      await rpc(fetchImpl, svc, 'attach_payment_intent', {
        p_attempt: attemptId,
        p_ref: started.providerRef,
        p_qr: started.qrImageUrl,
        p_expires: expires,
        p_provider: gateway.id,
      });
      return reply({
        attempt_id: attemptId,
        tender: attempt.tender,
        amount: attempt.amount,
        qr_image_url: started.qrImageUrl,
        expires_at: expires,
      });
    } catch (e) {
      // a provider's own error code (Stripe: "resource_missing" …) is safe to log and show; anything else is "provider_error"
      const code = e instanceof GatewayError ? e.code : 'provider_error';
      console.error(`[${gateway.id}] start failed`, code);
      await rpc(fetchImpl, svc, 'fail_payment_attempt', {
        p_attempt: attemptId,
        p_status: 'failed',
        p_error: code,
      });
      return reply({ error: 'provider_error', code }, 502);
    }
  } catch (e) {
    console.error('[payment] charge failed', e instanceof Error ? e.message : 'unknown');
    return reply({ error: 'server_error' }, 500);
  }
}

/** POST /api/stripe/cancel  { attempt_id } — stop waiting: cancels at the provider too. A payment that already went through still closes the bill via the webhook. */
export async function paymentCancelResponse(
  request: Request,
  env: Env = process.env,
  deps: PaymentDeps = {},
): Promise<Response> {
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
  const gateway = gatewayFromEnv(env, deps);
  if (!gateway) return reply({ error: 'not_configured' }, 503);
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
      await gateway.cancel({
        providerRef: out.provider_ref,
        readerId: out.tender === 'gateway' ? (out.reader_id ?? null) : null,
      });
    }
    return reply({ status: out.status ?? 'unknown' });
  } catch (e) {
    console.error('[payment] cancel failed', e instanceof Error ? e.message : 'unknown');
    return reply({ error: 'server_error' }, 500);
  }
}

/**
 * POST /api/<provider>/webhook — the provider → us. Raw body first, signature second, JSON last (the adapter does both).
 * A succeeded event is the ONLY thing that closes a bill here. Answers: 400 bad signature · 200 handled / ignored ·
 * 500 we could not process it (the provider retries — the database functions are safe to repeat).
 */
export async function paymentWebhookResponse(
  request: Request,
  env: Env = process.env,
  deps: PaymentDeps = {},
): Promise<Response> {
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
  const gateway = gatewayFromEnv(env, deps);
  if (!gateway) return reply({ error: 'not_configured' }, 503);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const rawBody = await request.text(); // BEFORE any JSON parsing: the signature is over the exact bytes
  const event = gateway.readWebhook({ rawBody, headers: request.headers });
  if (!event) return reply({ error: 'bad_signature' }, 400);
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const svc = { url: supabaseUrl, apikey: serviceRoleKey, bearer: serviceRoleKey };

    if (event.kind !== 'ignored') {
      // an event may only settle an attempt that THIS provider started (a second provider can never close another one's bill)
      const attempt = await selectOne<{ provider: string }>(
        fetchImpl,
        supabaseUrl,
        serviceRoleKey,
        `payment_attempts?id=eq.${event.attemptId}&select=provider`,
      );
      if (typeof attempt?.provider === 'string' && attempt.provider !== gateway.id) {
        console.error(`[${gateway.id}] event for an attempt of another provider`, event.attemptId);
        return reply({ received: true });
      }
    }

    if (event.kind === 'succeeded') {
      const r = await rpc(fetchImpl, svc, 'confirm_payment_attempt', {
        p_attempt: event.attemptId,
        p_ref: event.providerRef,
        p_amount: event.amount,
        p_currency: event.currency,
      });
      if (!r.ok) {
        console.error(`[${gateway.id}] confirm failed`, r.code ?? r.status);
        return reply({ error: 'confirm_failed' }, 500);
      }
      if (r.data === 'needs_review')
        console.error(`[${gateway.id}] payment needs review`, event.attemptId);
    } else if (event.kind === 'failed' || event.kind === 'canceled') {
      await rpc(fetchImpl, svc, 'fail_payment_attempt', {
        p_attempt: event.attemptId,
        p_status: event.kind,
        p_error: event.error,
      });
    }
    if (event.eventId)
      await rpc(fetchImpl, svc, 'record_payment_event', {
        p_id: event.eventId,
        p_type: event.type,
      });
    return reply({ received: true });
  } catch (e) {
    console.error(`[${gateway.id}] webhook failed`, e instanceof Error ? e.message : 'unknown');
    return reply({ error: 'server_error' }, 500);
  }
}

/** The names the Stripe routes and the older tests use. */
export const stripeChargeResponse = paymentChargeResponse;
export const stripeCancelResponse = paymentCancelResponse;
export const stripeWebhookResponse = paymentWebhookResponse;

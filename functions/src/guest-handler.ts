// Vercel Functions: GET /api/guest/menu?t=<table token> and POST /api/guest/order — the table QR, no account.
//
// The guest's phone holds nothing but the random token printed in the table's QR. Everything else is decided by the
// database functions (service role): what the menu is, what an option costs, whether a dish is still available, whether
// QR ordering is on at all. Nothing the phone sends is trusted except item ids, quantities, option ids and a short note.
// Relative imports with .js on purpose (see brand.ts): the bill arithmetic is the SAME code the till uses, never a copy.
import { parseBillOptions } from '../../packages/core/src/billing.js';
import { computeBill } from '../../packages/core/src/tax.js';
import type { BillBreakdown, PriceMode } from '../../packages/core/src/tax.js';
import { readServerEnv } from './env.js';
import { createRateLimiter } from './line.js';
import { gatewayFromEnv, gatewayReady } from './gateway.js';
import type { PaymentGateway } from './gateway.js';
import type { StripeClient } from './stripe.js';

type Env = Record<string, string | undefined>;
const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });

const TOKEN = /^[0-9a-f]{24,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// per IP. Every phone at a table re-reads the bill every few seconds, and a whole restaurant shares one Wi-Fi address, so the read limit is
// generous (the order, call and pay limits below stay tight).
const allowRead = createRateLimiter(600, 60_000);
const allowOrder = createRateLimiter(15, 60_000);

export type GuestDeps = {
  fetchImpl?: typeof fetch;
  stripe?: StripeClient;
  gateway?: PaymentGateway;
};

const allowPay = createRateLimiter(10, 60_000);

function clientKey(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return fwd || request.headers.get('x-real-ip') || 'unknown';
}

type Rpc = { ok: boolean; code: string | null; data: unknown };
async function rpc(
  fetchImpl: typeof fetch,
  url: string,
  serviceKey: string,
  fn: string,
  args: Record<string, unknown>,
): Promise<Rpc> {
  const res = await fetchImpl(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const data: unknown = await res.json().catch(() => null);
  const code =
    !res.ok && data && typeof data === 'object'
      ? String((data as { code?: unknown }).code ?? '')
      : null;
  return { ok: res.ok, code, data };
}

/** GET /api/guest/menu?t=… → { store, table, autoSend, menu, bill } */
export async function guestMenuResponse(
  request: Request,
  env: Env = process.env,
  deps: GuestDeps = {},
): Promise<Response> {
  if (request.method !== 'GET') return reply({ error: 'method_not_allowed' }, 405);
  const token = new URL(request.url).searchParams.get('t') ?? '';
  if (!TOKEN.test(token)) return reply({ error: 'not_found' }, 404);
  if (!allowRead(`read:${clientKey(request)}`)) return reply({ error: 'rate_limited' }, 429);
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const info = await rpc(fetchImpl, supabaseUrl, serviceRoleKey, 'guest_table', {
      p_token: token,
    });
    const t = info.data as Record<string, unknown> | null;
    if (!info.ok) return reply({ error: 'server_error' }, 502);
    if (!t || typeof t !== 'object') return reply({ error: 'not_found' }, 404);
    const head = {
      store: { name: String(t.store_name ?? '') },
      table: { name: String(t.table_name ?? '') },
    };
    if (t.qr_enabled !== true) return reply({ error: 'ordering_off', ...head }, 403);
    const [menu, bill, pay] = await Promise.all([
      rpc(fetchImpl, supabaseUrl, serviceRoleKey, 'guest_menu', { p_token: token }),
      rpc(fetchImpl, supabaseUrl, serviceRoleKey, 'guest_bill', { p_token: token }),
      rpc(fetchImpl, supabaseUrl, serviceRoleKey, 'guest_pay_context', { p_token: token }),
    ]);
    if (!menu.ok || !bill.ok || !pay.ok) return reply({ error: 'server_error' }, 502);
    return reply({
      ...head,
      autoSend: t.auto_send === true,
      kiosk: t.kiosk === true,
      kind: typeof t.kind === 'string' ? t.kind : 'table',
      ai: t.ai_enabled === true,
      menu: menu.data,
      bill: bill.data,
      pay: payInfo(pay.data as PayCtx | null, deps.gateway ? true : gatewayReady(env)),
    });
  } catch {
    return reply({ error: 'server_error' }, 502);
  }
}

type OrderBody = { token?: unknown; clientId?: unknown; lines?: unknown; contact?: unknown };
/** The name and phone an online-order page asks for (nothing else is passed on). */
function contactOf(v: unknown): { name: string; phone: string } | undefined {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  if (!o) return undefined;
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, 80) : '';
  const phone = typeof o.phone === 'string' ? o.phone.trim().slice(0, 30) : '';
  return { name, phone };
}
function parseBody(raw: string): OrderBody | null {
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as OrderBody) : null;
  } catch {
    return null;
  }
}

/** POST /api/guest/order  { token, clientId, lines:[{item_id, quantity, option_ids, note}] } */
export async function guestOrderResponse(
  request: Request,
  env: Env = process.env,
  deps: GuestDeps = {},
): Promise<Response> {
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
  if (!allowOrder(`order:${clientKey(request)}`)) return reply({ error: 'rate_limited' }, 429);
  const raw = await request.text().catch(() => '');
  if (raw.length > 40_000) return reply({ error: 'invalid' }, 413);
  const body = parseBody(raw);
  if (
    !body ||
    typeof body.token !== 'string' ||
    !TOKEN.test(body.token) ||
    typeof body.clientId !== 'string' ||
    !UUID.test(body.clientId) ||
    !Array.isArray(body.lines)
  )
    return reply({ error: 'invalid' }, 422);
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const r = await rpc(fetchImpl, supabaseUrl, serviceRoleKey, 'guest_place_order', {
      p: {
        token: body.token,
        client_id: body.clientId,
        lines: body.lines,
        contact: contactOf(body.contact),
      },
    });
    if (r.ok) return reply(r.data);
    if (r.code === 'P0002') return reply({ error: 'not_found' }, 404);
    if (r.code === '0A000') return reply({ error: 'ordering_off' }, 403);
    if (r.code === '54000') return reply({ error: 'too_many' }, 429);
    if (r.code === '55006') return reply({ error: 'bill_locked' }, 409);
    if (r.code === '23514') return reply({ error: 'unavailable' }, 422);
    if (r.code === '22023') return reply({ error: 'invalid' }, 422);
    return reply({ error: 'server_error' }, 502);
  } catch {
    return reply({ error: 'server_error' }, 502);
  }
}

const allowCall = createRateLimiter(8, 60_000);

/** POST /api/guest/call { token, reason: 'help' | 'bill' } — the guest asks for staff. A closed reason, no free text. */
export async function guestCallResponse(
  request: Request,
  env: Env = process.env,
  deps: GuestDeps = {},
): Promise<Response> {
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
  if (!allowCall(`call:${clientKey(request)}`)) return reply({ error: 'rate_limited' }, 429);
  const raw = await request.text().catch(() => '');
  const body = raw.length < 500 ? parseBody(raw) : null;
  const b = body as { token?: unknown; reason?: unknown } | null;
  if (
    !b ||
    typeof b.token !== 'string' ||
    !TOKEN.test(b.token) ||
    (b.reason !== 'help' && b.reason !== 'bill')
  )
    return reply({ error: 'invalid' }, 422);
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const r = await rpc(fetchImpl, supabaseUrl, serviceRoleKey, 'guest_call_staff', {
      p_token: b.token,
      p_reason: b.reason,
    });
    if (r.ok) {
      const status = (r.data as { status?: unknown } | null)?.status;
      return reply({ status: status === 'already' ? 'already' : 'called' });
    }
    if (r.code === 'P0002') return reply({ error: 'not_found' }, 404);
    if (r.code === '0A000') return reply({ error: 'ordering_off' }, 403);
    if (r.code === '53400') return reply({ error: 'too_many' }, 429);
    if (r.code === '22023') return reply({ error: 'invalid' }, 422);
    return reply({ error: 'server_error' }, 502);
  } catch {
    return reply({ error: 'server_error' }, 502);
  }
}

// ── pay at the table (PromptPay) ─────────────────────────────────────────────
type PayCtx = {
  enabled: boolean;
  device_id: string | null;
  order_id: string | null;
  points_discount?: number;
  config: { vat_bps: number; service_bps: number; price_mode: PriceMode; bill_options: unknown };
  unsent: boolean;
  lines: { unit_price: number; quantity: number }[];
  live: {
    id: string;
    amount: number;
    qr_url: string | null;
    expires_at: string | null;
    status: string;
    provider_ref: string | null;
  } | null;
};

/** The table's bill as the till would compute it: same code, the shop's own billing options, dine-in (service charge applies). */
function billOf(c: PayCtx): BillBreakdown | null {
  if (!c.order_id || !Array.isArray(c.lines) || c.lines.length === 0) return null;
  try {
    return computeBill({
      lines: c.lines.map((l) => ({ unitPrice: l.unit_price, quantity: l.quantity })),
      pointsDiscount: Math.max(0, c.points_discount ?? 0),
      priceMode: c.config.price_mode === 'exclusive' ? 'exclusive' : 'inclusive',
      vatBps: c.config.vat_bps,
      serviceChargeBps: c.config.service_bps,
      options: parseBillOptions(c.config.bill_options),
    });
  } catch {
    return null;
  }
}

/** What the guest page needs to offer "pay" — the amount is computed here, never read from the phone. */
function payInfo(c: PayCtx | null, stripeReady: boolean) {
  const bill = c ? billOf(c) : null;
  const live =
    c?.live && c.live.qr_url && c.live.expires_at && Date.parse(c.live.expires_at) > Date.now()
      ? {
          attemptId: c.live.id,
          amount: c.live.amount,
          qrImageUrl: c.live.qr_url,
          expiresAt: c.live.expires_at,
        }
      : null;
  return {
    enabled: !!c && c.enabled && stripeReady,
    total: bill?.total ?? 0,
    pointsDiscount: bill?.pointsDiscount ?? 0,
    unconfirmed: !!c?.unsent,
    live,
  };
}

const LANGS = ['th', 'en'] as const;

/** POST /api/guest/pay { token, lang } → { attempt_id, amount, qr_image_url, expires_at } */
export async function guestPayResponse(
  request: Request,
  env: Env = process.env,
  deps: GuestDeps = {},
): Promise<Response> {
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
  if (!allowPay(`pay:${clientKey(request)}`)) return reply({ error: 'rate_limited' }, 429);
  const gateway = gatewayFromEnv(env, deps);
  if (!gateway) return reply({ error: 'not_configured' }, 503);
  const body = parseBody(await request.text().catch(() => ''));
  if (!body || typeof body.token !== 'string' || !TOKEN.test(body.token))
    return reply({ error: 'invalid' }, 422);
  const lang = LANGS.find((l) => l === (body as { lang?: unknown }).lang) ?? 'th';
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const call = (fn: string, args: Record<string, unknown>) =>
      rpc(fetchImpl, supabaseUrl, serviceRoleKey, fn, args);
    const ctxRes = await call('guest_pay_context', { p_token: body.token });
    if (!ctxRes.ok) return reply({ error: 'server_error' }, 502);
    const c = ctxRes.data as PayCtx | null;
    if (!c) return reply({ error: 'not_found' }, 404);
    if (!c.enabled || !c.device_id) return reply({ error: 'pay_off' }, 403);
    const bill = billOf(c);
    if (!bill || bill.total <= 0 || !c.order_id) return reply({ error: 'empty' }, 422);
    if (c.unsent) return reply({ error: 'unconfirmed' }, 409);

    // a QR that is already on screen for exactly this bill is shown again (a reload must not strand or duplicate it)
    if (c.live) {
      const fresh =
        c.live.amount === bill.total &&
        c.live.qr_url &&
        c.live.expires_at &&
        Date.parse(c.live.expires_at) > Date.now();
      if (fresh)
        return reply({
          attempt_id: c.live.id,
          amount: c.live.amount,
          qr_image_url: c.live.qr_url,
          expires_at: c.live.expires_at,
        });
      const gone = await call('guest_cancel_payment', {
        p_token: body.token,
        p_attempt: c.live.id,
      });
      const ref = (gone.data as { provider_ref?: string | null } | null)?.provider_ref;
      if (ref) await gateway.cancel({ providerRef: ref, readerId: null });
    }

    const snapshot = {
      order_id: c.order_id,
      device_id: c.device_id,
      staff_id: null,
      tender: 'promptpay',
      lang,
      subtotal: bill.subtotal,
      points_discount: bill.pointsDiscount,
      service_charge: bill.serviceCharge,
      vat: bill.vat,
      net_before_vat: bill.netBeforeVat,
      total: bill.total,
      rounding: 0,
      payable: bill.total,
      vat_bps: c.config.vat_bps,
      service_bps: c.config.service_bps,
      price_mode: c.config.price_mode,
    };
    const begun = await call('guest_begin_payment', { p_token: body.token, p: snapshot });
    if (!begun.ok || typeof begun.data !== 'string') {
      if (begun.code === '23505') return reply({ error: 'attempt_pending' }, 409);
      if (begun.code === '55000') return reply({ error: 'unconfirmed' }, 409);
      if (begun.code === '0A000') return reply({ error: 'pay_off' }, 403);
      if (begun.code === 'P0002') return reply({ error: 'not_found' }, 404);
      if (begun.code === '23514') return reply({ error: 'invalid' }, 422);
      return reply({ error: 'server_error' }, 502);
    }
    const attemptId = begun.data;
    try {
      const started = await gateway.startPromptPay({
        attemptId,
        orderId: c.order_id,
        amount: bill.total,
      });
      const expires = new Date(Date.now() + 15 * 60_000).toISOString();
      await call('attach_payment_intent', {
        p_attempt: attemptId,
        p_ref: started.providerRef,
        p_qr: started.qrImageUrl,
        p_expires: expires,
        p_provider: gateway.id,
      });
      return reply({
        attempt_id: attemptId,
        amount: bill.total,
        qr_image_url: started.qrImageUrl,
        expires_at: expires,
      });
    } catch (e) {
      console.error('[guest-pay] start failed', e instanceof Error ? e.name : 'unknown');
      await call('fail_payment_attempt', {
        p_attempt: attemptId,
        p_status: 'failed',
        p_error: 'provider_error',
      });
      return reply({ error: 'provider_error' }, 502);
    }
  } catch {
    return reply({ error: 'server_error' }, 502);
  }
}

/** GET /api/guest/pay?t=…&a=<attempt id> → { status, amount, receipt } — polled while the QR is on screen */
export async function guestPayStatusResponse(
  request: Request,
  env: Env = process.env,
  deps: GuestDeps = {},
): Promise<Response> {
  if (request.method !== 'GET') return reply({ error: 'method_not_allowed' }, 405);
  const q = new URL(request.url).searchParams;
  const token = q.get('t') ?? '';
  const attempt = q.get('a') ?? '';
  if (!TOKEN.test(token) || !UUID.test(attempt)) return reply({ error: 'not_found' }, 404);
  if (!allowRead(`paystatus:${clientKey(request)}`)) return reply({ error: 'rate_limited' }, 429);
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const r = await rpc(fetchImpl, supabaseUrl, serviceRoleKey, 'guest_payment_status', {
      p_token: token,
      p_attempt: attempt,
    });
    if (!r.ok) return reply({ error: 'server_error' }, 502);
    if (!r.data) return reply({ error: 'not_found' }, 404);
    return reply(r.data);
  } catch {
    return reply({ error: 'server_error' }, 502);
  }
}

/** POST /api/guest/pay-cancel { token, attemptId } — the guest stops waiting; the QR is cancelled at the provider too. */
export async function guestPayCancelResponse(
  request: Request,
  env: Env = process.env,
  deps: GuestDeps = {},
): Promise<Response> {
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
  if (!allowPay(`paycancel:${clientKey(request)}`)) return reply({ error: 'rate_limited' }, 429);
  const body = parseBody(await request.text().catch(() => '')) as {
    token?: unknown;
    attemptId?: unknown;
  } | null;
  if (
    !body ||
    typeof body.token !== 'string' ||
    !TOKEN.test(body.token) ||
    typeof body.attemptId !== 'string' ||
    !UUID.test(body.attemptId)
  )
    return reply({ error: 'invalid' }, 422);
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const r = await rpc(fetchImpl, supabaseUrl, serviceRoleKey, 'guest_cancel_payment', {
      p_token: body.token,
      p_attempt: body.attemptId,
    });
    if (r.code === 'P0002') return reply({ error: 'not_found' }, 404);
    if (!r.ok) return reply({ error: 'server_error' }, 502);
    const out = r.data as { status?: string; provider_ref?: string | null };
    const gateway = gatewayFromEnv(env, deps);
    if (out.status === 'canceled' && out.provider_ref && gateway) {
      await gateway.cancel({ providerRef: out.provider_ref, readerId: null });
    }
    return reply({ status: out.status ?? 'unknown' });
  } catch {
    return reply({ error: 'server_error' }, 502);
  }
}

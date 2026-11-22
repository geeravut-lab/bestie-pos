// Reconciliation and refunds through the payment provider (module-free; the person's own token and the database decide who may):
//   GET  /api/payments/reconcile?store=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD → what Bestie booked as paid through the provider against what the provider lists as paid, + disputes + refunds   (report.view)
//   POST /api/payments/refund { order_id, amount (satang), reason? }       → gives money back on a bill paid through the provider (whole or part), then records it                        (refund.create)
// The provider is asked with the server's own key; the person never sees it. A provider that cannot list payments / refund says so (`available: false` / 501).
import {
  reconcile,
  parseBestieRows,
  parseDisputes,
  parseRefunds,
} from '../../packages/core/src/smartOps.js';
import { gatewayFromEnv } from './gateway.js';
import type { PaymentGateway } from './gateway.js';
import { readServerEnv } from './env.js';
import { createRateLimiter } from './line.js';

type Env = Record<string, string | undefined>;
const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const allowRead = createRateLimiter(20, 60_000);
const allowRefund = createRateLimiter(10, 60_000);

export type ReconcileDeps = { fetchImpl?: typeof fetch; gateway?: PaymentGateway | null };
const bearer = (r: Request): string | null =>
  /^Bearer (.+)$/.exec(r.headers.get('authorization') ?? '')?.[1] ?? null;

async function rpcAs(
  f: typeof fetch,
  url: string,
  apikey: string,
  token: string,
  fn: string,
  args: Record<string, unknown>,
) {
  const res = await f(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  return { ok: res.ok, status: res.status, data: (await res.json().catch(() => null)) as unknown };
}
const bangkokStart = (d: string): number => Date.parse(`${d}T00:00:00+07:00`);

export async function reconcileResponse(
  request: Request,
  env: Env = process.env,
  deps: ReconcileDeps = {},
): Promise<Response> {
  if (request.method !== 'GET') return reply({ error: 'method_not_allowed' }, 405);
  const token = bearer(request);
  const q = new URL(request.url).searchParams;
  const store = q.get('store') ?? '';
  const from = q.get('from') ?? '';
  const to = q.get('to') ?? '';
  if (!token || !UUID.test(store) || !DATE.test(from) || !DATE.test(to))
    return reply({ error: 'invalid' }, 422);
  const fromMs = bangkokStart(from);
  const toMs = bangkokStart(to) + 86_400_000; // the whole last day
  if (!(toMs > fromMs) || toMs - fromMs > 92 * 86_400_000) return reply({ error: 'invalid' }, 422);
  if (!allowRead(`recon:${token.slice(-16)}`)) return reply({ error: 'rate_limited' }, 429);
  const f = deps.fetchImpl ?? fetch;
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const anon = (env.SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_ANON_KEY)?.trim() || serviceRoleKey;
    const r = await rpcAs(f, supabaseUrl, anon, token, 'reconcile_rows', {
      p: {
        store_id: store,
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
      },
    });
    if (!r.ok) return reply({ error: 'forbidden' }, 403);
    const d = (r.data ?? {}) as Record<string, unknown>;
    const bestie = parseBestieRows(d.attempts);
    const disputes = parseDisputes(d.disputes);
    const refunds = parseRefunds(d.refunds);
    const gw = deps.gateway === undefined ? gatewayFromEnv(env, { fetchImpl: f }) : deps.gateway;
    if (!gw || !gw.listSucceeded)
      return reply({ available: false, disputes, refunds, bestieCount: bestie.length });
    const mine = bestie.filter((b) => b.provider === gw.id);
    const provider = await gw.listSucceeded({ fromMs, toMs });
    return reply({
      available: true,
      provider: gw.id,
      result: reconcile(mine, provider),
      disputes,
      refunds,
    });
  } catch {
    return reply({ error: 'provider_unreachable' }, 502);
  }
}

export async function refundResponse(
  request: Request,
  env: Env = process.env,
  deps: ReconcileDeps = {},
): Promise<Response> {
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
  const token = bearer(request);
  const b = (await request.json().catch(() => null)) as {
    order_id?: unknown;
    amount?: unknown;
    reason?: unknown;
  } | null;
  if (
    !token ||
    !b ||
    typeof b.order_id !== 'string' ||
    !UUID.test(b.order_id) ||
    typeof b.amount !== 'number' ||
    !Number.isInteger(b.amount) ||
    b.amount < 1
  )
    return reply({ error: 'invalid' }, 422);
  if (!allowRefund(`refund:${token.slice(-16)}`)) return reply({ error: 'rate_limited' }, 429);
  const f = deps.fetchImpl ?? fetch;
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const anon = (env.SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_ANON_KEY)?.trim() || serviceRoleKey;
    // the database says whether this person may, and how much of which payment is left
    const ctx = await rpcAs(f, supabaseUrl, anon, token, 'refund_context', {
      p_order: b.order_id,
      p_amount: b.amount,
    });
    if (!ctx.ok)
      return reply(
        { error: ctx.status === 400 ? 'not_allowed' : 'forbidden' },
        ctx.status === 400 ? 422 : 403,
      );
    const c = (ctx.data ?? {}) as {
      provider?: string;
      provider_ref?: string;
      attempt_id?: string;
      count?: number;
    };
    const gw = deps.gateway === undefined ? gatewayFromEnv(env, { fetchImpl: f }) : deps.gateway;
    if (!gw || gw.id !== c.provider || !gw.refund || !c.provider_ref)
      return reply({ error: 'not_supported' }, 501);
    // the key makes a double click or a retry harmless at the provider: the same bill, the same number of earlier refunds, the same amount
    const out = await gw.refund({
      providerRef: c.provider_ref,
      amount: b.amount,
      key: `refund:${b.order_id}:${(c.count ?? 0) + 1}:${b.amount}`,
    });
    const rec = await rpcAs(f, supabaseUrl, anon, token, 'record_provider_refund', {
      p: {
        order_id: b.order_id,
        attempt_id: c.attempt_id,
        provider: gw.id,
        refund_ref: out.refundRef,
        amount: b.amount,
        reason: typeof b.reason === 'string' ? b.reason.slice(0, 100) : null,
      },
    });
    return reply({ ok: true, refund_ref: out.refundRef, recorded: rec.ok });
  } catch {
    return reply({ error: 'provider_refused' }, 502);
  }
}

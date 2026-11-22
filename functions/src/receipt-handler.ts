// Vercel Function: POST /api/receipt/send { order_id, via: 'email' | 'line', email?, lang? } — the receipt of a paid bill as a message.
// The database (with the person's own token) checks the right to see the bill and hands over the FROZEN receipt; the text is built from it, never recomputed.
// An e-mail address is typed by the cashier, used once and forgotten; LINE goes only to a member who linked her LINE and has not typed STOP.
import { parseReceiptSend, receiptText } from '../../packages/core/src/growth.js';
import { sendEmail } from './email.js';
import { readServerEnv } from './env.js';
import { rpc } from './guest-extras-handler.js';
import { createRateLimiter, pushLine } from './line.js';
import { lineConfig } from './line-handler.js';

type Env = Record<string, string | undefined>;
const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const allow = createRateLimiter(20, 60_000);

export type ReceiptDeps = { fetchImpl?: typeof fetch };

export async function receiptSendResponse(
  request: Request,
  env: Env = process.env,
  deps: ReceiptDeps = {},
): Promise<Response> {
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
  const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!token) return reply({ error: 'forbidden' }, 403);
  const b = (await request.json().catch(() => null)) as {
    order_id?: unknown;
    via?: unknown;
    email?: unknown;
    lang?: unknown;
  } | null;
  if (
    !b ||
    typeof b.order_id !== 'string' ||
    !UUID.test(b.order_id) ||
    (b.via !== 'email' && b.via !== 'line')
  )
    return reply({ error: 'invalid' }, 422);
  if (!allow(`receipt:${token.slice(-16)}`)) return reply({ error: 'rate_limited' }, 429);
  const lang = b.lang === 'en' ? 'en' : 'th';
  const f = deps.fetchImpl ?? fetch;
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const anon = (env.SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_ANON_KEY)?.trim() || serviceRoleKey;
    const ur = await f(`${supabaseUrl}/rest/v1/rpc/receipt_send_data`, {
      method: 'POST',
      headers: {
        apikey: anon,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_order: b.order_id }),
    });
    const udata: unknown = await ur.json().catch(() => null);
    const r = {
      ok: ur.ok,
      code:
        !ur.ok && udata && typeof udata === 'object'
          ? String((udata as { code?: unknown }).code ?? '')
          : null,
      data: udata,
    };
    if (!r.ok)
      return reply(
        { error: r.code === '42501' ? 'forbidden' : 'server_error' },
        r.code === '42501' ? 403 : 502,
      );
    const data = parseReceiptSend(r.data);
    if (!data) return reply({ error: 'no_receipt' }, 409); // the bill is not paid yet
    const text = receiptText(data, lang);
    if (b.via === 'email') {
      const to = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
      const out = await sendEmail(
        { to, subject: `${data.sellerName} · ${data.number}`, text },
        env,
        f,
      );
      return reply({ ok: out === 'sent', outcome: out }, out === 'rejected' ? 422 : 200);
    }
    const cfg = lineConfig(env);
    if (!cfg) return reply({ ok: false, outcome: 'not_configured' });
    const target = await rpc(f, supabaseUrl, serviceRoleKey, 'receipt_line_target', {
      p_order: b.order_id,
    });
    const to = typeof target.data === 'string' ? target.data : '';
    if (!target.ok || !to) return reply({ ok: false, outcome: 'no_channel' });
    const outcome = await pushLine(cfg, to, { type: 'text', text }, crypto.randomUUID(), f);
    return reply({ ok: outcome === 'sent', outcome });
  } catch {
    return reply({ error: 'server_error' }, 502);
  }
}

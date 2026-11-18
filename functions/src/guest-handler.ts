// Vercel Functions: GET /api/guest/menu?t=<table token> and POST /api/guest/order — the table QR, no account.
//
// The guest's phone holds nothing but the random token printed in the table's QR. Everything else is decided by the
// database functions (service role): what the menu is, what an option costs, whether a dish is still available, whether
// QR ordering is on at all. Nothing the phone sends is trusted except item ids, quantities, option ids and a short note.
import { readServerEnv } from './env.js';
import { createRateLimiter } from './line.js';

type Env = Record<string, string | undefined>;
const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });

const TOKEN = /^[0-9a-f]{24,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// per phone (IP) — a guest looks at a menu a few times and orders a few times
const allowRead = createRateLimiter(60, 60_000);
const allowOrder = createRateLimiter(15, 60_000);

export type GuestDeps = { fetchImpl?: typeof fetch };

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
    const [menu, bill] = await Promise.all([
      rpc(fetchImpl, supabaseUrl, serviceRoleKey, 'guest_menu', { p_token: token }),
      rpc(fetchImpl, supabaseUrl, serviceRoleKey, 'guest_bill', { p_token: token }),
    ]);
    if (!menu.ok || !bill.ok) return reply({ error: 'server_error' }, 502);
    return reply({ ...head, autoSend: t.auto_send === true, menu: menu.data, bill: bill.data });
  } catch {
    return reply({ error: 'server_error' }, 502);
  }
}

type OrderBody = { token?: unknown; clientId?: unknown; lines?: unknown };
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
      p: { token: body.token, client_id: body.clientId, lines: body.lines },
    });
    if (r.ok) return reply(r.data);
    if (r.code === 'P0002') return reply({ error: 'not_found' }, 404);
    if (r.code === '0A000') return reply({ error: 'ordering_off' }, 403);
    if (r.code === '54000') return reply({ error: 'too_many' }, 429);
    if (r.code === '23514') return reply({ error: 'unavailable' }, 422);
    if (r.code === '22023') return reply({ error: 'invalid' }, 422);
    return reply({ error: 'server_error' }, 502);
  } catch {
    return reply({ error: 'server_error' }, 502);
  }
}

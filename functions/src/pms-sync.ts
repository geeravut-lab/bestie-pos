// PMS link on the server (owner order 1): (1) GET /api/pms/in-house?store=<id> — the guests checked in at the hotel, for the folio's "Import from the PMS";
// (2) `postPmsCharges` — called by the notification tick: every room charge of a linked stay is posted to the PMS once (the receipt number is the reference).
// The page asks the database (with the person's own token) whether the PMS module and the front desk's right are there; the PMS keys stay in Vercel.
import { readServerEnv } from './env.js';
import { pmsFromEnv } from './pms.js';
import type { PmsAdapter } from './pms.js';
import { callRpc } from './notify-deliver.js';
import { createRateLimiter } from './line.js';

type Env = Record<string, string | undefined>;
const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const allow = createRateLimiter(20, 60_000);

export type PmsDeps = { fetchImpl?: typeof fetch; adapter?: PmsAdapter | null };

export async function pmsInHouseResponse(
  request: Request,
  env: Env = process.env,
  deps: PmsDeps = {},
): Promise<Response> {
  if (request.method !== 'GET') return reply({ error: 'method_not_allowed' }, 405);
  const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
  const store = new URL(request.url).searchParams.get('store') ?? '';
  if (!token || !UUID.test(store)) return reply({ error: 'forbidden' }, 403);
  const f = deps.fetchImpl ?? fetch;
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const anon = (env.SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_ANON_KEY)?.trim() || serviceRoleKey;
    const res = await f(`${supabaseUrl}/rest/v1/rpc/pms_context`, {
      method: 'POST',
      headers: {
        apikey: anon,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_store: store }),
    });
    if (!res.ok) return reply({ error: 'forbidden' }, 403);
    if (!allow(`pms:${token.slice(-16)}`)) return reply({ error: 'rate_limited' }, 429);
    const adapter = deps.adapter === undefined ? pmsFromEnv(env, f) : deps.adapter;
    if (!adapter) return reply({ available: false });
    return reply({ available: true, provider: adapter.name, guests: await adapter.inHouse() });
  } catch {
    return reply({ available: true, error: 'pms_unreachable', guests: [] }, 502);
  }
}

/** Posts the pending room charges; returns how many were posted. Never throws (the tick must go on). */
export async function postPmsCharges(
  env: Env,
  f: typeof fetch,
  adapter?: PmsAdapter | null,
): Promise<number> {
  try {
    const a = adapter === undefined ? pmsFromEnv(env, f) : adapter;
    if (!a) return 0;
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const pending = (await callRpc(
      supabaseUrl,
      serviceRoleKey,
      'pms_pending_charges',
      { p_limit: 20 },
      f,
    )) as
      { id: string; reservation: string; amount: number; receipt: string; outlet: string }[] | null;
    let n = 0;
    for (const c of Array.isArray(pending) ? pending : []) {
      let r: { ok: true; id: string } | { ok: false; error: string };
      try {
        r = await a.postCharge({
          reservationId: c.reservation,
          amountSatang: c.amount,
          description: `${c.outlet}`.slice(0, 80),
          reference: c.receipt || c.id,
        });
      } catch (e) {
        r = { ok: false, error: e instanceof Error ? e.message : 'failed' };
      }
      await callRpc(
        supabaseUrl,
        serviceRoleKey,
        'pms_mark_posted',
        { p_charge: c.id, p_ok: r.ok, p_ref: r.ok ? r.id : null, p_error: r.ok ? null : r.error },
        f,
      );
      if (r.ok) n += 1;
    }
    return n;
  } catch {
    return 0;
  }
}

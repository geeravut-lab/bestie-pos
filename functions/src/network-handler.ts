// Vercel Functions for the island network (Phase 3), all for a guest's phone with no account:
//   GET  /api/guest/pass?t=<pass token>                              → { pass }            her points, movements and the island's shops
//   POST /api/guest/pass { slug, name, phone, consent }              → { ok, token?, code?, error? }   register a Tourist Pass
//   GET  /api/guest/pass?t=<pass token>&partners=1                    → { partners }        the businesses that share her points, and the switch
//   POST /api/guest/pass { op:'block', t, org, blocked }              → { ok }             stop (or resume) sharing her points with one business
//   GET  /api/guest/island?n=<slug>                                  → { island }          the public marketplace page
// Every rule is checked by the database functions; this file limits the request rate, checks shapes and talks to them with the service role.
import { readServerEnv } from './env.js';
import { clientKey, jsonObject, rpc } from './guest-extras-handler.js';
import { createRateLimiter } from './line.js';
import { parsePassPartners } from '../../packages/core/src/growth.js';
import { parseIsland, parsePass } from '../../packages/core/src/network.js';

type Env = Record<string, string | undefined>;
const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });
const TOKEN = /^[0-9a-f]{32}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{2,39}$/;

export type NetworkDeps = { fetchImpl?: typeof fetch };
const allowRead = createRateLimiter(60, 60_000);
const allowRegister = createRateLimiter(5, 10 * 60_000); // per address: slows making passes in bulk
const allowRegisterAll = createRateLimiter(200, 60 * 60_000);
const allowBlock = createRateLimiter(30, 60_000);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function guestPassResponse(
  request: Request,
  env: Env = process.env,
  deps: NetworkDeps = {},
): Promise<Response> {
  const f = deps.fetchImpl ?? fetch;
  const ip = clientKey(request);
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    if (request.method === 'GET') {
      if (!allowRead(`pass:${ip}`)) return reply({ error: 'rate_limited' }, 429);
      const t = new URL(request.url).searchParams.get('t') ?? '';
      if (!TOKEN.test(t)) return reply({ error: 'invalid' }, 422);
      if (new URL(request.url).searchParams.get('partners') === '1') {
        const pr = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_pass_partners', { p_token: t });
        if (!pr.ok) return reply({ error: 'server_error' }, 502);
        return pr.data == null
          ? reply({ error: 'not_found' }, 404)
          : reply({ partners: parsePassPartners(pr.data) });
      }
      const r = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_pass', { p_token: t });
      if (!r.ok) return reply({ error: 'server_error' }, 502);
      const pass = parsePass(r.data);
      return pass ? reply({ pass }) : reply({ error: 'not_found' }, 404);
    }
    if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
    const b = await jsonObject(request, 2000);
    if (b?.op === 'block') {
      if (!allowBlock(`pass-block:${ip}`)) return reply({ error: 'rate_limited' }, 429);
      if (
        typeof b.t !== 'string' ||
        !TOKEN.test(b.t) ||
        typeof b.org !== 'string' ||
        !UUID.test(b.org) ||
        typeof b.blocked !== 'boolean'
      )
        return reply({ error: 'invalid' }, 422);
      const br = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_pass_set_block', {
        p_token: b.t,
        p_org: b.org,
        p_blocked: b.blocked,
      });
      if (!br.ok) return reply({ error: 'server_error' }, 502);
      const o = (br.data && typeof br.data === 'object' ? br.data : {}) as { ok?: unknown };
      return reply({ ok: o.ok === true });
    }
    if (!b || typeof b.slug !== 'string' || !SLUG.test(b.slug))
      return reply({ error: 'invalid' }, 422);
    if (!allowRegister(`pass-reg:${ip}`) || !allowRegisterAll('pass-reg-all'))
      return reply({ error: 'rate_limited' }, 429);
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, 80) : '';
    const phone = typeof b.phone === 'string' ? b.phone.trim().slice(0, 30) : '';
    if (!name || phone.replace(/\D/g, '').length < 8)
      return reply({ ok: false, error: 'invalid' }, 422);
    const r = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_pass_register', {
      p_slug: b.slug,
      p: { name, phone, consent: b.consent === true },
    });
    if (!r.ok) return reply({ error: 'server_error' }, 502);
    const o = (r.data && typeof r.data === 'object' ? r.data : {}) as Record<string, unknown>;
    if (o.ok === true) return reply({ ok: true, token: o.token, code: o.code });
    return reply({ ok: false, error: typeof o.error === 'string' ? o.error : 'failed' }, 200);
  } catch {
    return reply({ error: 'server_error' }, 502);
  }
}

export async function guestIslandResponse(
  request: Request,
  env: Env = process.env,
  deps: NetworkDeps = {},
): Promise<Response> {
  const f = deps.fetchImpl ?? fetch;
  try {
    if (request.method !== 'GET') return reply({ error: 'method_not_allowed' }, 405);
    if (!allowRead(`island:${clientKey(request)}`)) return reply({ error: 'rate_limited' }, 429);
    const n = new URL(request.url).searchParams.get('n') ?? '';
    if (!SLUG.test(n)) return reply({ error: 'invalid' }, 422);
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const r = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_island', { p_slug: n });
    if (!r.ok) return reply({ error: 'server_error' }, 502);
    const island = parseIsland(r.data);
    return island ? reply({ island: r.data }) : reply({ error: 'not_found' }, 404);
  } catch {
    return reply({ error: 'server_error' }, 502);
  }
}

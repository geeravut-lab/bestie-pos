// Vercel Functions of the integration hub: GET /api/v1/sales?from=&to=  and  GET /api/v1/menu, both read-only, both with `Authorization: Bearer bk_…`.
// The key is looked up by its SHA-256 (only the hash is stored); the database checks that the owner switched the hub on and that the key is not revoked.
import { createHash } from 'node:crypto';
import { readServerEnv } from './env.js';
import { rpc } from './guest-extras-handler.js';
import { createRateLimiter } from './line.js';

type Env = Record<string, string | undefined>;
const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });
const KEY = /^bk_[0-9a-f]{48}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const allow = createRateLimiter(120, 60_000);

export type PublicApiDeps = { fetchImpl?: typeof fetch };

export async function publicApiResponse(
  request: Request,
  what: 'sales' | 'menu',
  env: Env = process.env,
  deps: PublicApiDeps = {},
): Promise<Response> {
  if (request.method !== 'GET') return reply({ error: 'method_not_allowed' }, 405);
  const key = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1]?.trim() ?? '';
  if (!KEY.test(key)) return reply({ error: 'unauthorized' }, 401);
  const hash = createHash('sha256').update(key).digest('hex');
  if (!allow(`api:${hash}`)) return reply({ error: 'rate_limited' }, 429);
  const f = deps.fetchImpl ?? fetch;
  try {
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    const who = await rpc(f, supabaseUrl, serviceRoleKey, 'api_key_lookup', { p_hash: hash });
    const o = (who.data && typeof who.data === 'object' ? who.data : null) as {
      org_id?: unknown;
      scopes?: unknown;
    } | null;
    if (!who.ok || !o || typeof o.org_id !== 'string') return reply({ error: 'unauthorized' }, 401);
    if (!Array.isArray(o.scopes) || !o.scopes.includes(what))
      return reply({ error: 'forbidden' }, 403);
    if (what === 'menu') {
      const r = await rpc(f, supabaseUrl, serviceRoleKey, 'api_menu', { p_org: o.org_id });
      return r.ok ? reply({ items: r.data }) : reply({ error: 'server_error' }, 502);
    }
    const u = new URL(request.url);
    const from = u.searchParams.get('from') ?? '';
    const to = u.searchParams.get('to') ?? '';
    if (!DAY.test(from) || !DAY.test(to)) return reply({ error: 'invalid_range' }, 422);
    const r = await rpc(f, supabaseUrl, serviceRoleKey, 'api_sales', {
      p_org: o.org_id,
      p_from: from,
      p_to: to,
    });
    if (!r.ok)
      return reply(
        { error: r.code === '22023' ? 'invalid_range' : 'server_error' },
        r.code === '22023' ? 422 : 502,
      );
    return reply({ days: r.data, currency: 'THB', unit: 'satang' });
  } catch {
    return reply({ error: 'server_error' }, 502);
  }
}

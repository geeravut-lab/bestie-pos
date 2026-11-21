// Vercel Function for the Bestie Song Bridge (a program in the karaoke room; the room's bridge key is the only key):
//   GET  /api/karaoke/bridge                         Authorization: Bearer <64 hex>   → { ok, room, running, now, queue: [{ id, video_id, title }] }
//   POST /api/karaoke/bridge  { song, status }       status = 'playing' | 'done' | 'removed'   → { ok }
// The bridge only PULLS: nothing in the shop opens a port. Every rule (key, module, own room, song states) lives in the database functions.
import { createRateLimiter } from './line.js';
import { readServerEnv } from './env.js';
import { clientKey, jsonObject, rpc } from './guest-extras-handler.js';

type Env = Record<string, string | undefined>;
export type BridgeDeps = { fetchImpl?: typeof fetch };
const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });
const allowIp = createRateLimiter(300, 60_000);
const allowToken = createRateLimiter(90, 60_000);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['playing', 'done', 'removed']);

export async function karaokeBridgeResponse(
  request: Request,
  env: Env = process.env,
  deps: BridgeDeps = {},
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST')
    return reply({ ok: false, error: 'method_not_allowed' }, 405);
  const f = deps.fetchImpl ?? fetch;
  try {
    const token = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!token) return reply({ ok: false, error: 'unauthorized' }, 401);
    if (!allowIp(`bridge:${clientKey(request)}`) || !allowToken(`bridge-token:${token}`))
      return reply({ ok: false, error: 'rate_limited' }, 429);
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
    if (request.method === 'GET') {
      const r = await rpc(f, supabaseUrl, serviceRoleKey, 'bridge_karaoke_poll', {
        p_token: token,
      });
      if (!r.ok) return reply({ ok: false, error: 'server_error' }, 502);
      const o = (r.data && typeof r.data === 'object' ? r.data : {}) as Record<string, unknown>;
      return o.ok === true ? reply(o) : reply({ ok: false, error: 'unauthorized' }, 401);
    }
    const b = await jsonObject(request, 2_000);
    const song = typeof b?.song === 'string' ? b.song : '';
    const status = typeof b?.status === 'string' ? b.status : '';
    if (!UUID.test(song) || !STATUSES.has(status))
      return reply({ ok: false, error: 'invalid' }, 422);
    const r = await rpc(f, supabaseUrl, serviceRoleKey, 'bridge_karaoke_song', {
      p_token: token,
      p_song: song,
      p_status: status,
    });
    if (!r.ok) return reply({ ok: false, error: 'server_error' }, 502);
    const o = (r.data && typeof r.data === 'object' ? r.data : {}) as Record<string, unknown>;
    if (o.ok === true) return reply({ ok: true });
    const error = typeof o.error === 'string' ? o.error : 'invalid';
    return reply({ ok: false, error }, error === 'unauthorized' ? 401 : 409);
  } catch {
    return reply({ ok: false, error: 'server_error' }, 502);
  }
}

// Vercel Function for the online booking of tour seats (module `tours.online`; the shop's tour link token is the only key):
//   GET  /api/guest/tour?t=<token>                          → { info }      the shop, its open tours with seats left and the deposit per seat
//   GET  /api/guest/tour?t=<token>&id=<id>&code=<code>      → { status }    the deposit received? still held?
//   POST /api/guest/tour { t, op: 'book', slot_id, seats, name, phone, client_id } → { result }
//   POST /api/guest/tour { t, op: 'cancel', id, code }                             → { result }
//   POST /api/guest/tour { t, op: 'contact', id, code, email }                     → { ok, error? }  (e-mail for the reminder before the trip; '' removes it)
// Every rule (module on, notice time, seats left, limits, repeat = same answer) is checked by the database functions; this file only limits the request rate,
// checks the shapes and talks to them with the service role. The browser never gets a key. Nothing here takes money: the deposit is recorded by the front desk.
import { createRateLimiter } from './line.js';
import { readServerEnv } from './env.js';
import { clientKey, jsonObject, rpc } from './guest-extras-handler.js';
import {
  parseTourBookResult,
  parseTourOnlineInfo,
  parseTourStatus,
} from '../../packages/core/src/growth.js';

type Env = Record<string, string | undefined>;
export type TourBookingDeps = { fetchImpl?: typeof fetch };
const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });
const TOKEN = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const allowRead = createRateLimiter(60, 60_000);
const allowBook = createRateLimiter(6, 60_000);
const allowBookShop = createRateLimiter(30, 10 * 60_000);
const allowCancel = createRateLimiter(10, 60_000);

const str = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';

export async function guestTourBookingResponse(
  request: Request,
  env: Env = process.env,
  deps: TourBookingDeps = {},
): Promise<Response> {
  const f = deps.fetchImpl ?? fetch;
  const ip = clientKey(request);
  try {
    if (request.method === 'GET') {
      const q = new URL(request.url).searchParams;
      const token = q.get('t') ?? '';
      if (!TOKEN.test(token)) return reply({ error: 'invalid' }, 422);
      const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
      const id = q.get('id');
      if (id !== null) {
        if (!allowRead(`tour-status:${ip}`)) return reply({ error: 'rate_limited' }, 429);
        const code = str(q.get('code'), 20);
        if (!UUID.test(id) || code.length < 4) return reply({ error: 'invalid' }, 422);
        const r = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_tour_status', {
          p_token: token,
          p_id: id,
          p_code: code,
        });
        if (!r.ok) return reply({ error: 'server_error' }, 502);
        return reply({ status: parseTourStatus(r.data) });
      }
      if (!allowRead(`tour:${ip}`)) return reply({ error: 'rate_limited' }, 429);
      const r = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_tour_info', { p_token: token });
      if (!r.ok) return reply({ error: 'server_error' }, 502);
      const info = parseTourOnlineInfo(r.data);
      // the Official Account a guest can add as a friend to get a reminder by LINE (absent = LINE is not set up)
      const basic = env.LINE_BASIC_ID?.trim();
      const lineBasicId = basic && /^@?[A-Za-z0-9._-]{2,40}$/.test(basic) ? basic : null;
      return info ? reply({ info, lineBasicId }) : reply({ error: 'not_found' }, 404);
    }

    if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
    const b = await jsonObject(request, 4000);
    if (!b || typeof b.t !== 'string' || !TOKEN.test(b.t)) return reply({ error: 'invalid' }, 422);
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);

    if (b.op === 'book') {
      if (!allowBook(`tour-book:${ip}`) || !allowBookShop(`tour-shop:${b.t}`))
        return reply({ error: 'rate_limited' }, 429);
      if (
        typeof b.slot_id !== 'string' ||
        !UUID.test(b.slot_id) ||
        typeof b.seats !== 'number' ||
        !Number.isInteger(b.seats) ||
        b.seats < 1 ||
        b.seats > 20 ||
        typeof b.client_id !== 'string' ||
        !UUID.test(b.client_id)
      )
        return reply({ error: 'invalid' }, 422);
      const name = str(b.name, 80);
      const phone = str(b.phone, 30);
      if (!name || phone.length < 6) return reply({ error: 'invalid' }, 422);
      const r = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_tour_book', {
        p_token: b.t,
        p: { slot_id: b.slot_id, seats: b.seats, name, phone, client_id: b.client_id },
      });
      if (!r.ok) return reply({ error: 'server_error' }, 502);
      return reply({ result: parseTourBookResult(r.data) });
    }

    if (b.op === 'cancel') {
      if (!allowCancel(`tour-cancel:${ip}`)) return reply({ error: 'rate_limited' }, 429);
      const code = str(b.code, 20);
      if (typeof b.id !== 'string' || !UUID.test(b.id) || code.length < 4)
        return reply({ error: 'invalid' }, 422);
      const r = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_tour_cancel', {
        p_token: b.t,
        p_id: b.id,
        p_code: code,
      });
      if (!r.ok) return reply({ error: 'server_error' }, 502);
      const o = (r.data && typeof r.data === 'object' ? r.data : {}) as Record<string, unknown>;
      return reply({
        result: o.ok === true ? { ok: true } : { ok: false, error: str(o.error, 30) || 'failed' },
      });
    }
    if (b.op === 'contact') {
      if (!allowCancel(`tour-contact:${ip}`)) return reply({ error: 'rate_limited' }, 429);
      const code = str(b.code, 20);
      const email = str(b.email, 120);
      if (typeof b.id !== 'string' || !UUID.test(b.id) || code.length < 4)
        return reply({ error: 'invalid' }, 422);
      const r = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_tour_contact', {
        p_token: b.t,
        p_id: b.id,
        p_code: code,
        p_email: email,
      });
      if (!r.ok) return reply({ error: 'server_error' }, 502);
      const o = (r.data && typeof r.data === 'object' ? r.data : {}) as {
        ok?: unknown;
        error?: unknown;
      };
      return reply({ ok: o.ok === true, error: typeof o.error === 'string' ? o.error : null });
    }
    return reply({ error: 'invalid' }, 422);
  } catch {
    return reply({ error: 'server_error' }, 502);
  }
}

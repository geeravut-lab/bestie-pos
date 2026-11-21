// Vercel Function for online booking by guests (module `booking.online`; the shop's booking link token is the only key):
//   GET  /api/guest/booking?t=<token>                                   → { info }            the shop, services, stylists, settings
//   GET  /api/guest/booking?t=<token>&service=<id>&date=YYYY-MM-DD[&provider=<id>] → { slots: ["09:00", …] }
//   POST /api/guest/booking { t, op: 'book', service_id, provider_id?, date, time, name, phone, note?, client_id } → { result }
//   POST /api/guest/booking { t, op: 'cancel', id, code }                                                          → { result }
//   GET  /api/guest/booking?t=<token>&op=styles                                                                   → { styles }       (the shop's hair-style catalogue)
//   POST /api/guest/booking { t, op: 'hair', id, code, request: { style_id?, answers?, photo?: {consent, mime, data}, remove_photo? } } → { ok, error?, photo }
//   POST /api/guest/booking { t, op: 'contact', id, code, email }                                                  → { ok, error? }  (e-mail for the reminder; '' removes it)
// Every rule (module on, free time, limits, repeat = same answer) is checked by the database functions; this file only limits the
// request rate, checks the shapes and talks to them with the service role. The browser never gets a key.
import { createRateLimiter } from './line.js';
import { readServerEnv } from './env.js';
import { clientKey, jsonObject, rpc } from './guest-extras-handler.js';
import {
  parseBookingInfo,
  parseBookingResult,
  parseCancelResult,
  parseSlots,
} from '../../packages/core/src/onlineBooking.js';

type Env = Record<string, string | undefined>;
const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });
const TOKEN = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export type BookingDeps = { fetchImpl?: typeof fetch };

const allowRead = createRateLimiter(60, 60_000);
const allowSlots = createRateLimiter(60, 60_000);
const allowBook = createRateLimiter(6, 60_000);
const allowBookShop = createRateLimiter(30, 10 * 60_000);
const allowCancel = createRateLimiter(10, 60_000);
const allowHair = createRateLimiter(10, 60_000);

const str = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';

export async function guestBookingResponse(
  request: Request,
  env: Env = process.env,
  deps: BookingDeps = {},
): Promise<Response> {
  const f = deps.fetchImpl ?? fetch;
  const ip = clientKey(request);
  try {
    if (request.method === 'GET') {
      const q = new URL(request.url).searchParams;
      const token = q.get('t') ?? '';
      if (!TOKEN.test(token)) return reply({ error: 'invalid' }, 422);
      const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
      if (q.get('op') === 'styles') {
        if (!allowRead(`booking-styles:${ip}`)) return reply({ error: 'rate_limited' }, 429);
        const r = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_hair_styles', {
          p_token: token,
        });
        if (!r.ok) return reply({ error: 'server_error' }, 502);
        return r.data === null ? reply({ error: 'not_found' }, 404) : reply({ styles: r.data });
      }
      const service = q.get('service');
      if (service !== null) {
        if (!allowSlots(`booking-slots:${ip}`)) return reply({ error: 'rate_limited' }, 429);
        const date = q.get('date') ?? '';
        const provider = q.get('provider');
        if (!UUID.test(service) || !DATE.test(date) || (provider !== null && !UUID.test(provider)))
          return reply({ error: 'invalid' }, 422);
        const r = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_booking_slots', {
          p_token: token,
          p_service: service,
          p_provider: provider,
          p_date: date,
        });
        if (!r.ok) return reply({ error: 'server_error' }, 502);
        if (r.data === null) return reply({ error: 'not_found' }, 404);
        return reply({ slots: parseSlots(r.data) });
      }
      if (!allowRead(`booking:${ip}`)) return reply({ error: 'rate_limited' }, 429);
      const r = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_booking_info', { p_token: token });
      if (!r.ok) return reply({ error: 'server_error' }, 502);
      const info = parseBookingInfo(r.data);
      // the Official Account a guest can add as a friend to get a reminder by LINE (absent = LINE is not set up)
      const basic = env.LINE_BASIC_ID?.trim();
      const lineBasicId = basic && /^@?[A-Za-z0-9._-]{2,40}$/.test(basic) ? basic : null;
      return info ? reply({ info, lineBasicId }) : reply({ error: 'not_found' }, 404);
    }

    if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
    // the hair photo (a base64 picture of at most 256 KB) needs a bigger body than every other request
    const b = await jsonObject(request, 420_000);
    if (!b || typeof b.t !== 'string' || !TOKEN.test(b.t)) return reply({ error: 'invalid' }, 422);
    if (b.op !== 'hair' && JSON.stringify(b).length >= 4000)
      return reply({ error: 'invalid' }, 422);
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);

    if (b.op === 'book') {
      if (!allowBook(`booking-book:${ip}`) || !allowBookShop(`booking-shop:${b.t}`))
        return reply({ error: 'rate_limited' }, 429);
      const provider = typeof b.provider_id === 'string' && b.provider_id ? b.provider_id : null;
      if (
        typeof b.service_id !== 'string' ||
        !UUID.test(b.service_id) ||
        (provider !== null && !UUID.test(provider)) ||
        typeof b.date !== 'string' ||
        !DATE.test(b.date) ||
        typeof b.time !== 'string' ||
        !TIME.test(b.time) ||
        typeof b.client_id !== 'string' ||
        !UUID.test(b.client_id)
      )
        return reply({ error: 'invalid' }, 422);
      const name = str(b.name, 80);
      const phone = str(b.phone, 30);
      if (!name || phone.length < 6) return reply({ error: 'invalid' }, 422);
      const r = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_book', {
        p_token: b.t,
        p: {
          service_id: b.service_id,
          provider_id: provider,
          date: b.date,
          time: b.time,
          name,
          phone,
          note: str(b.note, 300) || null,
          client_id: b.client_id,
        },
      });
      if (!r.ok) return reply({ error: 'server_error' }, 502);
      return reply({ result: parseBookingResult(r.data) });
    }

    if (b.op === 'cancel') {
      if (!allowCancel(`booking-cancel:${ip}`)) return reply({ error: 'rate_limited' }, 429);
      const code = str(b.code, 20);
      if (typeof b.id !== 'string' || !UUID.test(b.id) || code.length < 4)
        return reply({ error: 'invalid' }, 422);
      const r = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_cancel_booking', {
        p_token: b.t,
        p_id: b.id,
        p_code: code,
      });
      if (!r.ok) return reply({ error: 'server_error' }, 502);
      return reply({ result: parseCancelResult(r.data) });
    }
    if (b.op === 'contact') {
      if (!allowCancel(`booking-contact:${ip}`)) return reply({ error: 'rate_limited' }, 429);
      const code = str(b.code, 20);
      const email = str(b.email, 120);
      if (typeof b.id !== 'string' || !UUID.test(b.id) || code.length < 4)
        return reply({ error: 'invalid' }, 422);
      const r = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_booking_contact', {
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
    if (b.op === 'hair') {
      if (!allowHair(`booking-hair:${ip}`)) return reply({ error: 'rate_limited' }, 429);
      const code = str(b.code, 20);
      if (typeof b.id !== 'string' || !UUID.test(b.id) || code.length < 4)
        return reply({ error: 'invalid' }, 422);
      const p =
        b.request && typeof b.request === 'object' ? (b.request as Record<string, unknown>) : {};
      const r = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_hair_request', {
        p_token: b.t,
        p_id: b.id,
        p_code: code,
        p,
      });
      if (!r.ok) return reply({ error: 'server_error' }, 502);
      const o = (r.data && typeof r.data === 'object' ? r.data : {}) as Record<string, unknown>;
      return reply({
        ok: o.ok === true,
        error: typeof o.error === 'string' ? o.error : null,
        photo: o.photo === true,
      });
    }
    return reply({ error: 'invalid' }, 422);
  } catch {
    return reply({ error: 'server_error' }, 502);
  }
}

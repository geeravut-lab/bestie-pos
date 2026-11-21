// Vercel Function for the online booking of karaoke rooms (module `karaoke.booking`; the shop's karaoke booking link token is the only key):
//   GET  /api/guest/karaoke-booking?t=<token>                                         → { info }      the shop, its rooms, hours, deposit
//   GET  /api/guest/karaoke-booking?t=<token>&room=<id>&date=YYYY-MM-DD&minutes=<n>   → { slots: ["12:00", …] }
//   GET  /api/guest/karaoke-booking?t=<token>&id=<id>&code=<code>                     → { status }    the deposit received? still held?
//   POST /api/guest/karaoke-booking { t, op: 'book', room_id, date, time, minutes, name, phone, guests?, note?, client_id } → { result }
//   POST /api/guest/karaoke-booking { t, op: 'cancel', id, code }                                                          → { result }
// Every rule (module on, free time, limits, repeat = same answer) is checked by the database functions; this file only limits the request rate,
// checks the shapes and talks to them with the service role. The browser never gets a key. Nothing here takes money: the deposit is recorded by the front desk.
import { createRateLimiter } from './line.js';
import { readServerEnv } from './env.js';
import { clientKey, jsonObject, rpc } from './guest-extras-handler.js';
import {
  parseKaraokeBookResult,
  parseKaraokeBookStatus,
  parseKaraokeBookingInfo,
  parseKaraokeCancelResult,
} from '../../packages/core/src/karaokeBooking.js';
import { parseSlots } from '../../packages/core/src/onlineBooking.js';

type Env = Record<string, string | undefined>;
export type KaraokeBookingDeps = { fetchImpl?: typeof fetch };
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

const allowRead = createRateLimiter(60, 60_000);
const allowSlots = createRateLimiter(60, 60_000);
const allowBook = createRateLimiter(6, 60_000);
const allowBookShop = createRateLimiter(30, 10 * 60_000);
const allowCancel = createRateLimiter(10, 60_000);

const str = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';

export async function guestKaraokeBookingResponse(
  request: Request,
  env: Env = process.env,
  deps: KaraokeBookingDeps = {},
): Promise<Response> {
  const f = deps.fetchImpl ?? fetch;
  const ip = clientKey(request);
  try {
    if (request.method === 'GET') {
      const q = new URL(request.url).searchParams;
      const token = q.get('t') ?? '';
      if (!TOKEN.test(token)) return reply({ error: 'invalid' }, 422);
      const { supabaseUrl, serviceRoleKey } = readServerEnv(env);
      const room = q.get('room');
      if (room !== null) {
        if (!allowSlots(`kbook-slots:${ip}`)) return reply({ error: 'rate_limited' }, 429);
        const date = q.get('date') ?? '';
        const minutes = Number(q.get('minutes'));
        if (!UUID.test(room) || !DATE.test(date) || !Number.isInteger(minutes))
          return reply({ error: 'invalid' }, 422);
        const r = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_karaoke_booking_slots', {
          p_token: token,
          p_room: room,
          p_date: date,
          p_minutes: minutes,
        });
        if (!r.ok) return reply({ error: 'server_error' }, 502);
        if (r.data === null) return reply({ error: 'not_found' }, 404);
        return reply({ slots: parseSlots(r.data) });
      }
      const id = q.get('id');
      if (id !== null) {
        if (!allowRead(`kbook-status:${ip}`)) return reply({ error: 'rate_limited' }, 429);
        const code = str(q.get('code'), 20);
        if (!UUID.test(id) || code.length < 4) return reply({ error: 'invalid' }, 422);
        const r = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_karaoke_booking_status', {
          p_token: token,
          p_id: id,
          p_code: code,
        });
        if (!r.ok) return reply({ error: 'server_error' }, 502);
        return reply({ status: parseKaraokeBookStatus(r.data) });
      }
      if (!allowRead(`kbook:${ip}`)) return reply({ error: 'rate_limited' }, 429);
      const r = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_karaoke_booking_info', {
        p_token: token,
      });
      if (!r.ok) return reply({ error: 'server_error' }, 502);
      const info = parseKaraokeBookingInfo(r.data);
      return info ? reply({ info }) : reply({ error: 'not_found' }, 404);
    }

    if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
    const b = await jsonObject(request, 4000);
    if (!b || typeof b.t !== 'string' || !TOKEN.test(b.t)) return reply({ error: 'invalid' }, 422);
    const { supabaseUrl, serviceRoleKey } = readServerEnv(env);

    if (b.op === 'book') {
      if (!allowBook(`kbook-book:${ip}`) || !allowBookShop(`kbook-shop:${b.t}`))
        return reply({ error: 'rate_limited' }, 429);
      const guests = typeof b.guests === 'number' && Number.isInteger(b.guests) ? b.guests : null;
      if (
        typeof b.room_id !== 'string' ||
        !UUID.test(b.room_id) ||
        typeof b.date !== 'string' ||
        !DATE.test(b.date) ||
        typeof b.time !== 'string' ||
        !TIME.test(b.time) ||
        typeof b.minutes !== 'number' ||
        !Number.isInteger(b.minutes) ||
        typeof b.client_id !== 'string' ||
        !UUID.test(b.client_id)
      )
        return reply({ error: 'invalid' }, 422);
      const name = str(b.name, 80);
      const phone = str(b.phone, 30);
      if (!name || phone.length < 6) return reply({ error: 'invalid' }, 422);
      const r = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_karaoke_book', {
        p_token: b.t,
        p: {
          room_id: b.room_id,
          date: b.date,
          time: b.time,
          minutes: b.minutes,
          name,
          phone,
          guests,
          note: str(b.note, 300) || null,
          client_id: b.client_id,
        },
      });
      if (!r.ok) return reply({ error: 'server_error' }, 502);
      return reply({ result: parseKaraokeBookResult(r.data) });
    }

    if (b.op === 'cancel') {
      if (!allowCancel(`kbook-cancel:${ip}`)) return reply({ error: 'rate_limited' }, 429);
      const code = str(b.code, 20);
      if (typeof b.id !== 'string' || !UUID.test(b.id) || code.length < 4)
        return reply({ error: 'invalid' }, 422);
      const r = await rpc(f, supabaseUrl, serviceRoleKey, 'guest_karaoke_cancel', {
        p_token: b.t,
        p_id: b.id,
        p_code: code,
      });
      if (!r.ok) return reply({ error: 'server_error' }, 502);
      return reply({ result: parseKaraokeCancelResult(r.data) });
    }
    return reply({ error: 'invalid' }, 422);
  } catch {
    return reply({ error: 'server_error' }, 502);
  }
}

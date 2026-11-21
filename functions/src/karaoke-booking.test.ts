import { describe, expect, it, vi } from 'vitest';
import { guestKaraokeBookingResponse } from './karaoke-booking-handler.js';

const TOKEN = 'b'.repeat(32);
const ROOM = '11111111-1111-4111-8111-111111111111';
const BOOKING = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const env = {
  SUPABASE_URL: 'https://x.supabase.co',
  VITE_SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'svc',
};
const calls: { fn: string; body: Record<string, unknown> }[] = [];
const fakeFetch = (answers: Record<string, unknown>, status = 200) =>
  vi.fn(async (url: unknown, init?: RequestInit) => {
    const fn = /\/rpc\/(\w+)$/.exec(String(url))?.[1] ?? '';
    calls.push({ fn, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return Response.json(answers[fn] ?? null, { status });
  }) as unknown as typeof fetch;
let n = 0;
const ip = () => ({ 'x-forwarded-for': `9.9.9.${(n += 1)}` });
const get = (qs: string) =>
  new Request(`https://x/api/guest/karaoke-booking?${qs}`, { headers: ip() });
const post = (body: unknown) =>
  new Request('https://x/api/guest/karaoke-booking', {
    method: 'POST',
    headers: ip(),
    body: JSON.stringify(body),
  });
const book = {
  t: TOKEN,
  op: 'book',
  room_id: ROOM,
  date: '2030-01-15',
  time: '20:00',
  minutes: 120,
  name: ' Anna ',
  phone: '081-111-1111',
  guests: 5,
  client_id: CLIENT,
};

describe('GET', () => {
  it('returns the page for a karaoke booking link', async () => {
    const res = await guestKaraokeBookingResponse(get(`t=${TOKEN}`), env, {
      fetchImpl: fakeFetch({
        guest_karaoke_booking_info: {
          open: true,
          store_name: 'Sing',
          rooms: [{ id: ROOM, name: 'VIP', rate_per_hour: 30000, lengths: [60, 120] }],
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { info: { storeName: string; rooms: unknown[] } };
    expect(body.info.storeName).toBe('Sing');
    expect(body.info.rooms).toHaveLength(1);
  });
  it('a wrong link is 404, a malformed one 422', async () => {
    expect(
      (await guestKaraokeBookingResponse(get(`t=${TOKEN}`), env, { fetchImpl: fakeFetch({}) }))
        .status,
    ).toBe(404);
    expect(
      (await guestKaraokeBookingResponse(get('t=zzz'), env, { fetchImpl: fakeFetch({}) })).status,
    ).toBe(422);
  });
  it('lists free times for a room, day and length', async () => {
    const f = fakeFetch({ guest_karaoke_booking_slots: ['12:00', 'bad', '12:30'] });
    const res = await guestKaraokeBookingResponse(
      get(`t=${TOKEN}&room=${ROOM}&date=2030-01-15&minutes=120`),
      env,
      { fetchImpl: f },
    );
    expect(await res.json()).toEqual({ slots: ['12:00', '12:30'] });
    expect(calls.at(-1)).toEqual({
      fn: 'guest_karaoke_booking_slots',
      body: { p_token: TOKEN, p_room: ROOM, p_date: '2030-01-15', p_minutes: 120 },
    });
  });
  it('refuses a bad room, date or length', async () => {
    const f = { fetchImpl: fakeFetch({}) };
    expect(
      (
        await guestKaraokeBookingResponse(
          get(`t=${TOKEN}&room=x&date=2030-01-15&minutes=60`),
          env,
          f,
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await guestKaraokeBookingResponse(
          get(`t=${TOKEN}&room=${ROOM}&date=tomorrow&minutes=60`),
          env,
          f,
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await guestKaraokeBookingResponse(
          get(`t=${TOKEN}&room=${ROOM}&date=2030-01-15&minutes=x`),
          env,
          f,
        )
      ).status,
    ).toBe(422);
  });
  it('shows the deposit state of a booking with its code', async () => {
    const f = fakeFetch({
      guest_karaoke_booking_status: {
        ok: true,
        status: 'booked',
        starts_at: '2030-01-15T13:00:00Z',
        minutes: 120,
        room: 'VIP',
        deposit_due: 18000,
        deposit_paid: 18000,
      },
    });
    const res = await guestKaraokeBookingResponse(
      get(`t=${TOKEN}&id=${BOOKING}&code=ABCD1234`),
      env,
      { fetchImpl: f },
    );
    expect(((await res.json()) as { status: { depositPaid: number } }).status.depositPaid).toBe(
      18000,
    );
    expect(calls.at(-1)?.body).toEqual({ p_token: TOKEN, p_id: BOOKING, p_code: 'ABCD1234' });
    expect(
      (
        await guestKaraokeBookingResponse(get(`t=${TOKEN}&id=${BOOKING}&code=ab`), env, {
          fetchImpl: f,
        })
      ).status,
    ).toBe(422);
  });
});

describe('POST', () => {
  it('books through the database function with trimmed text', async () => {
    const f = fakeFetch({
      guest_karaoke_book: {
        ok: true,
        id: BOOKING,
        code: 'ABCD1234',
        starts_at: '2030-01-15T13:00:00Z',
        minutes: 120,
        room: 'VIP',
        price: 60000,
        deposit_due: 18000,
        hold_until: null,
      },
    });
    const res = await guestKaraokeBookingResponse(post(book), env, { fetchImpl: f });
    expect(((await res.json()) as { result: { ok: boolean; code: string } }).result).toMatchObject({
      ok: true,
      code: 'ABCD1234',
    });
    expect(calls.at(-1)).toMatchObject({
      fn: 'guest_karaoke_book',
      body: {
        p_token: TOKEN,
        p: {
          room_id: ROOM,
          name: 'Anna',
          phone: '081-111-1111',
          minutes: 120,
          guests: 5,
          client_id: CLIENT,
        },
      },
    });
  });
  it('passes a refusal on as an answer, not an error', async () => {
    const res = await guestKaraokeBookingResponse(post(book), env, {
      fetchImpl: fakeFetch({ guest_karaoke_book: { ok: false, error: 'taken' } }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: unknown }).result).toEqual({
      ok: false,
      error: 'taken',
    });
  });
  it('refuses wrong shapes before the database is asked', async () => {
    const f = fakeFetch({});
    for (const bad of [
      { ...book, room_id: 'x' },
      { ...book, time: '8pm' },
      { ...book, minutes: 'two hours' },
      { ...book, name: '  ' },
      { ...book, phone: '123' },
      { ...book, client_id: 'x' },
    ])
      expect((await guestKaraokeBookingResponse(post(bad), env, { fetchImpl: f })).status).toBe(
        422,
      );
    expect(
      (await guestKaraokeBookingResponse(post({ ...book, t: 'bad' }), env, { fetchImpl: f }))
        .status,
    ).toBe(422);
  });
  it('cancels with the booking id and code', async () => {
    const f = fakeFetch({ guest_karaoke_cancel: { ok: true } });
    const res = await guestKaraokeBookingResponse(
      post({ t: TOKEN, op: 'cancel', id: BOOKING, code: 'abcd1234' }),
      env,
      { fetchImpl: f },
    );
    expect(((await res.json()) as { result: unknown }).result).toEqual({ ok: true });
    expect(calls.at(-1)).toEqual({
      fn: 'guest_karaoke_cancel',
      body: { p_token: TOKEN, p_id: BOOKING, p_code: 'abcd1234' },
    });
    expect(
      (
        await guestKaraokeBookingResponse(
          post({ t: TOKEN, op: 'cancel', id: 'x', code: 'abcd1234' }),
          env,
          { fetchImpl: f },
        )
      ).status,
    ).toBe(422);
  });
  it('a server fault is a 502, other verbs 405', async () => {
    expect(
      (await guestKaraokeBookingResponse(post(book), env, { fetchImpl: fakeFetch({}, 500) }))
        .status,
    ).toBe(502);
    expect(
      (
        await guestKaraokeBookingResponse(
          new Request('https://x/api/guest/karaoke-booking', { method: 'PUT' }),
          env,
          { fetchImpl: fakeFetch({}) },
        )
      ).status,
    ).toBe(405);
  });
  it('limits how fast one address can book', async () => {
    const f = fakeFetch({ guest_karaoke_book: { ok: false, error: 'taken' } });
    const same = () =>
      new Request('https://x/api/guest/karaoke-booking', {
        method: 'POST',
        headers: { 'x-forwarded-for': '6.6.6.6' },
        body: JSON.stringify(book),
      });
    const codes: number[] = [];
    for (let i = 0; i < 8; i += 1)
      codes.push((await guestKaraokeBookingResponse(same(), env, { fetchImpl: f })).status);
    expect(codes.slice(0, 6).every((c) => c === 200)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });
});

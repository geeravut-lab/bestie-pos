import { describe, expect, it, vi } from 'vitest';
import { guestTourBookingResponse } from './tour-booking-handler.js';

const TOKEN = 'c'.repeat(32);
const SLOT = '11111111-1111-4111-8111-111111111111';
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
const ip = () => ({ 'x-forwarded-for': `8.8.8.${(n += 1)}` });
const get = (qs: string) => new Request(`https://x/api/guest/tour?${qs}`, { headers: ip() });
const post = (body: unknown) =>
  new Request('https://x/api/guest/tour', {
    method: 'POST',
    headers: ip(),
    body: JSON.stringify(body),
  });
const book = {
  t: TOKEN,
  op: 'book',
  slot_id: SLOT,
  seats: 2,
  name: ' Anna ',
  phone: '081-111-1111',
  client_id: CLIENT,
};

describe('GET', () => {
  it('returns the page for a tour link', async () => {
    const res = await guestTourBookingResponse(get(`t=${TOKEN}`), env, {
      fetchImpl: fakeFetch({
        guest_tour_info: {
          open: true,
          store_name: 'Island Tours',
          settings: { deposit_pct: 30, hold_min: 120, pay_note: 'PromptPay 081' },
          slots: [
            {
              id: SLOT,
              title: { th: 'ดำน้ำ', en: 'Snorkel' },
              starts_at: '2030-01-15T02:00:00Z',
              duration_min: 240,
              price: 150000,
              seats_left: 6,
              deposit_per_seat: 45000,
            },
          ],
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { info: { storeName: string; slots: unknown[] } };
    expect(body.info.storeName).toBe('Island Tours');
    expect(body.info.slots).toHaveLength(1);
  });
  it('a wrong link is 404, a malformed one 422', async () => {
    expect(
      (await guestTourBookingResponse(get(`t=${TOKEN}`), env, { fetchImpl: fakeFetch({}) })).status,
    ).toBe(404);
    expect((await guestTourBookingResponse(get('t=zzz'), env)).status).toBe(422);
  });
  it('the status needs the booking id and the code', async () => {
    const f = fakeFetch({
      guest_tour_status: { status: 'booked', seats: 2, deposit_due: 90000, deposit_received: 0 },
    });
    const ok = await guestTourBookingResponse(get(`t=${TOKEN}&id=${BOOKING}&code=ABCD1234`), env, {
      fetchImpl: f,
    });
    expect(((await ok.json()) as { status: { status: string } }).status.status).toBe('booked');
    expect(
      (await guestTourBookingResponse(get(`t=${TOKEN}&id=${BOOKING}&code=x`), env)).status,
    ).toBe(422);
  });
});

describe('POST', () => {
  it('books through the database and passes only the closed fields (trimmed)', async () => {
    calls.length = 0;
    const res = await guestTourBookingResponse(post(book), env, {
      fetchImpl: fakeFetch({
        guest_tour_book: {
          ok: true,
          id: BOOKING,
          code: 'ABCD1234',
          deposit_due: 90000,
          hold_until: null,
        },
      }),
    });
    const body = (await res.json()) as { result: { ok: boolean; code: string } };
    expect(body.result).toMatchObject({ ok: true, code: 'ABCD1234' });
    const c = calls.find((x) => x.fn === 'guest_tour_book')!;
    expect(c.body.p_token).toBe(TOKEN);
    expect(c.body.p).toEqual({
      slot_id: SLOT,
      seats: 2,
      name: 'Anna',
      phone: '081-111-1111',
      client_id: CLIENT,
    });
  });
  it('never sends a price and refuses bad shapes', async () => {
    for (const bad of [
      { ...book, seats: 0 },
      { ...book, seats: 21 },
      { ...book, seats: 1.5 },
      { ...book, slot_id: 'x' },
      { ...book, client_id: 'x' },
      { ...book, name: '  ' },
      { ...book, phone: '12' },
      { ...book, op: 'nope' },
      { ...book, t: 'short' },
    ]) {
      expect((await guestTourBookingResponse(post(bad), env)).status).toBe(422);
    }
  });
  it('a refusal from the database is an answer the page can word', async () => {
    const res = await guestTourBookingResponse(post(book), env, {
      fetchImpl: fakeFetch({ guest_tour_book: { ok: false, error: 'full' } }),
    });
    expect(((await res.json()) as { result: unknown }).result).toEqual({
      ok: false,
      error: 'full',
    });
  });
  it('cancels with the code', async () => {
    const res = await guestTourBookingResponse(
      post({ t: TOKEN, op: 'cancel', id: BOOKING, code: 'ABCD1234' }),
      env,
      { fetchImpl: fakeFetch({ guest_tour_cancel: { ok: true } }) },
    );
    expect(((await res.json()) as { result: unknown }).result).toEqual({ ok: true });
    const late = await guestTourBookingResponse(
      post({ t: TOKEN, op: 'cancel', id: BOOKING, code: 'ABCD1234' }),
      env,
      { fetchImpl: fakeFetch({ guest_tour_cancel: { ok: false, error: 'too_late' } }) },
    );
    expect(((await late.json()) as { result: unknown }).result).toEqual({
      ok: false,
      error: 'too_late',
    });
  });
  it('database trouble is a 502, other methods 405', async () => {
    const res = await guestTourBookingResponse(post(book), env, {
      fetchImpl: fakeFetch({}, 500),
    });
    expect(res.status).toBe(502);
    expect(
      (
        await guestTourBookingResponse(
          new Request('https://x/api/guest/tour', { method: 'PUT' }),
          env,
        )
      ).status,
    ).toBe(405);
  });
  it('a shop is rate limited: 6 bookings a minute from one address', async () => {
    const f = fakeFetch({ guest_tour_book: { ok: false, error: 'full' } });
    const fixed = () =>
      new Request('https://x/api/guest/tour', {
        method: 'POST',
        headers: { 'x-forwarded-for': '7.7.7.7' },
        body: JSON.stringify({ ...book, t: 'd'.repeat(32) }),
      });
    const codes: number[] = [];
    for (let i = 0; i < 8; i += 1)
      codes.push((await guestTourBookingResponse(fixed(), env, { fetchImpl: f })).status);
    expect(codes.slice(0, 6).every((c) => c === 200)).toBe(true);
    expect(codes.slice(6)).toEqual([429, 429]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { guestBookingResponse } from './booking-handler.js';

const TOKEN = 'a'.repeat(32);
const SVC = '11111111-1111-4111-8111-111111111111';
const PRO = '22222222-2222-4222-8222-222222222222';
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
const ip = () => ({ 'x-forwarded-for': `7.7.7.${(n += 1)}` });
const get = (qs: string) => new Request(`https://x/api/guest/booking?${qs}`, { headers: ip() });
const post = (body: unknown) =>
  new Request('https://x/api/guest/booking', {
    method: 'POST',
    headers: ip(),
    body: JSON.stringify(body),
  });
const book = {
  t: TOKEN,
  op: 'book',
  service_id: SVC,
  provider_id: PRO,
  date: '2030-01-15',
  time: '10:00',
  name: ' Anna ',
  phone: '081-111-1111',
  client_id: CLIENT,
};

describe('GET', () => {
  it('returns the shop page for a booking link', async () => {
    const res = await guestBookingResponse(get(`t=${TOKEN}`), env, {
      fetchImpl: fakeFetch({
        guest_booking_info: { open: true, store_name: 'Salon', services: [], providers: [] },
      }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { info: { storeName: string } }).info.storeName).toBe('Salon');
  });
  it('a wrong link is 404, a malformed one 422', async () => {
    expect(
      (await guestBookingResponse(get(`t=${TOKEN}`), env, { fetchImpl: fakeFetch({}) })).status,
    ).toBe(404);
    expect(
      (await guestBookingResponse(get('t=zzz'), env, { fetchImpl: fakeFetch({}) })).status,
    ).toBe(422);
  });
  it('lists free times for a service and day', async () => {
    const f = fakeFetch({ guest_booking_slots: ['09:00', 'bad', '09:30'] });
    const res = await guestBookingResponse(
      get(`t=${TOKEN}&service=${SVC}&date=2030-01-15&provider=${PRO}`),
      env,
      { fetchImpl: f },
    );
    expect(await res.json()).toEqual({ slots: ['09:00', '09:30'] });
    expect(calls.at(-1)).toEqual({
      fn: 'guest_booking_slots',
      body: { p_token: TOKEN, p_service: SVC, p_provider: PRO, p_date: '2030-01-15' },
    });
  });
  it('refuses a bad service id or date', async () => {
    const f = fakeFetch({});
    expect(
      (
        await guestBookingResponse(get(`t=${TOKEN}&service=x&date=2030-01-15`), env, {
          fetchImpl: f,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await guestBookingResponse(get(`t=${TOKEN}&service=${SVC}&date=tomorrow`), env, {
          fetchImpl: f,
        })
      ).status,
    ).toBe(422);
  });
  it('a database failure is 502', async () => {
    const res = await guestBookingResponse(get(`t=${TOKEN}`), env, {
      fetchImpl: fakeFetch({}, 500),
    });
    expect(res.status).toBe(502);
  });
});

describe('POST book', () => {
  it('sends only the fields it knows, trimmed, with the token', async () => {
    const f = fakeFetch({
      guest_book: {
        ok: true,
        id: 'a1',
        code: 'ABCD1234',
        starts_at: '2030-01-15T10:00:00+07:00',
        provider: 'Nok',
      },
    });
    const res = await guestBookingResponse(post({ ...book, price: 1, evil: 'x' }), env, {
      fetchImpl: f,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { ok: boolean; code: string } }).result).toMatchObject({
      ok: true,
      code: 'ABCD1234',
    });
    expect(calls.at(-1)).toEqual({
      fn: 'guest_book',
      body: {
        p_token: TOKEN,
        p: {
          service_id: SVC,
          provider_id: PRO,
          date: '2030-01-15',
          time: '10:00',
          name: 'Anna',
          phone: '081-111-1111',
          note: null,
          client_id: CLIENT,
        },
      },
    });
  });
  it('"anyone" sends no provider', async () => {
    await guestBookingResponse(post({ ...book, provider_id: '' }), env, {
      fetchImpl: fakeFetch({ guest_book: { ok: false, error: 'taken' } }),
    });
    expect((calls.at(-1)!.body.p as { provider_id: unknown }).provider_id).toBeNull();
  });
  it('passes the database refusal on as an answer', async () => {
    const res = await guestBookingResponse(post(book), env, {
      fetchImpl: fakeFetch({ guest_book: { ok: false, error: 'taken' } }),
    });
    expect(((await res.json()) as { result: unknown }).result).toEqual({
      ok: false,
      error: 'taken',
    });
  });
  it('refuses bad shapes before the database', async () => {
    const f = fakeFetch({});
    for (const bad of [
      { ...book, time: '10:15pm' },
      { ...book, date: '15/01/2030' },
      { ...book, service_id: 'nope' },
      { ...book, client_id: 'nope' },
      { ...book, name: '  ' },
      { ...book, phone: '123' },
      { ...book, op: 'other' },
      { ...book, t: 'short' },
    ]) {
      expect((await guestBookingResponse(post(bad), env, { fetchImpl: f })).status).toBe(422);
    }
    expect(f).not.toHaveBeenCalled();
  });
  it('is rate limited per phone address', async () => {
    const f = fakeFetch({ guest_book: { ok: false, error: 'taken' } });
    const same = () =>
      new Request('https://x/api/guest/booking', {
        method: 'POST',
        headers: { 'x-forwarded-for': '5.5.5.5' },
        body: JSON.stringify(book),
      });
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++)
      statuses.push((await guestBookingResponse(same(), env, { fetchImpl: f })).status);
    expect(statuses.slice(0, 6).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(6)).toEqual([429, 429]);
  });
});

describe('POST cancel', () => {
  it('cancels with the booking id and the code', async () => {
    const res = await guestBookingResponse(
      post({ t: TOKEN, op: 'cancel', id: SVC, code: 'abcd1234' }),
      env,
      {
        fetchImpl: fakeFetch({ guest_cancel_booking: { ok: true } }),
      },
    );
    expect(((await res.json()) as { result: unknown }).result).toEqual({ ok: true });
    expect(calls.at(-1)).toEqual({
      fn: 'guest_cancel_booking',
      body: { p_token: TOKEN, p_id: SVC, p_code: 'abcd1234' },
    });
  });
  it('a wrong code is an answer, a missing code is 422', async () => {
    const res = await guestBookingResponse(
      post({ t: TOKEN, op: 'cancel', id: SVC, code: 'nope1234' }),
      env,
      {
        fetchImpl: fakeFetch({ guest_cancel_booking: { ok: false, error: 'invalid' } }),
      },
    );
    expect(((await res.json()) as { result: unknown }).result).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(
      (
        await guestBookingResponse(post({ t: TOKEN, op: 'cancel', id: SVC }), env, {
          fetchImpl: fakeFetch({}),
        })
      ).status,
    ).toBe(422);
  });
  it('other methods are refused', async () => {
    const res = await guestBookingResponse(
      new Request('https://x/api/guest/booking', { method: 'DELETE' }),
      env,
      { fetchImpl: fakeFetch({}) },
    );
    expect(res.status).toBe(405);
  });
});

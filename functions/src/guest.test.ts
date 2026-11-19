import { describe, expect, it, vi } from 'vitest';
import { guestCallResponse, guestMenuResponse, guestOrderResponse } from './guest-handler.js';

const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
const TOKEN = 'a'.repeat(32);
const CID = '20000000-0000-4000-8000-000000000001';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

/** Fake Supabase REST: answers by function name. */
function fakeFetch(answers: Record<string, () => Response>) {
  return vi.fn(async (url: string | URL | Request) => {
    const fn = String(url).split('/rpc/')[1] ?? '';
    return (answers[fn] ?? (() => json(null, 404)))();
  }) as unknown as typeof fetch;
}
const get = (t: string, ip = '1.1.1.1') =>
  new Request(`https://app.test/api/guest/menu?t=${t}`, { headers: { 'x-forwarded-for': ip } });
const post = (body: unknown, ip = '2.2.2.2') =>
  new Request('https://app.test/api/guest/order', {
    method: 'POST',
    headers: { 'x-forwarded-for': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('GET /api/guest/menu', () => {
  it('refuses a malformed token without touching the database', async () => {
    const f = fakeFetch({});
    const r = await guestMenuResponse(get('not-a-token'), env, { fetchImpl: f });
    expect(r.status).toBe(404);
    expect(f).not.toHaveBeenCalled();
  });
  it('404 for an unknown table', async () => {
    const f = fakeFetch({ guest_table: () => json(null) });
    expect((await guestMenuResponse(get(TOKEN), env, { fetchImpl: f })).status).toBe(404);
  });
  it('says so when ordering is off (and does not send the menu)', async () => {
    const f = fakeFetch({
      guest_table: () => json({ store_name: 'Acme', table_name: 'T1', qr_enabled: false }),
    });
    const r = await guestMenuResponse(get(TOKEN, '1.1.1.2'), env, { fetchImpl: f });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: 'ordering_off', store: { name: 'Acme' } });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('returns the menu and the bill', async () => {
    const f = fakeFetch({
      guest_table: () =>
        json({ store_name: 'Acme', table_name: 'T1', qr_enabled: true, auto_send: true }),
      guest_menu: () => json({ categories: [], items: [], groups: [] }),
      guest_bill: () => json({ order_id: null, lines: [] }),
      guest_pay_context: () => json(null),
    });
    const r = await guestMenuResponse(get(TOKEN, '1.1.1.3'), env, { fetchImpl: f });
    const body = (await r.json()) as Record<string, unknown>;
    expect(r.status).toBe(200);
    expect(body.autoSend).toBe(true);
    expect(body).not.toHaveProperty('org_id');
    expect(JSON.stringify(body)).not.toContain('svc'); // the service key never leaves the server
  });
  it('is rate limited per phone', async () => {
    const f = fakeFetch({ guest_table: () => json(null) });
    let last = 0;
    for (let i = 0; i < 610; i++)
      last = (await guestMenuResponse(get(TOKEN, '9.9.9.9'), env, { fetchImpl: f })).status;
    expect(last).toBe(429);
  });
  it('a database failure is a 502, not a leak', async () => {
    const f = fakeFetch({
      guest_table: () => json({ code: 'XX000', message: 'secret detail' }, 500),
    });
    const r = await guestMenuResponse(get(TOKEN, '1.1.1.4'), env, { fetchImpl: f });
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain('secret');
  });
});

describe('POST /api/guest/order', () => {
  const lines = [{ item_id: 'i', quantity: 1, option_ids: [], note: '' }];
  it('validates the shape before calling the database', async () => {
    const f = fakeFetch({});
    for (const body of [
      '{bad json',
      { token: 'short', clientId: CID, lines },
      { token: TOKEN, clientId: 'nope', lines },
      { token: TOKEN, clientId: CID, lines: 'x' },
    ]) {
      expect((await guestOrderResponse(post(body, '3.3.3.3'), env, { fetchImpl: f })).status).toBe(
        422,
      );
    }
    expect(f).not.toHaveBeenCalled();
  });
  it('refuses a huge body', async () => {
    const r = await guestOrderResponse(post('x'.repeat(50_000), '3.3.3.4'), env, {
      fetchImpl: fakeFetch({}),
    });
    expect(r.status).toBe(413);
  });
  it('passes only token, client id and lines to the database and returns its answer', async () => {
    const f = fakeFetch({
      guest_place_order: () =>
        json({ order_id: 'o', number: 'QR001', lines: 1, status: 'waiting' }),
    });
    const r = await guestOrderResponse(
      post({ token: TOKEN, clientId: CID, lines, price: 1, org_id: 'evil' }, '3.3.3.5'),
      env,
      { fetchImpl: f },
    );
    expect(await r.json()).toMatchObject({ number: 'QR001' });
    const sent = JSON.parse(
      ((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { body: string }).body,
    ) as { p: Record<string, unknown> };
    expect(Object.keys(sent.p).sort()).toEqual(['client_id', 'lines', 'token']);
  });
  it('maps database refusals', async () => {
    const cases: [string, number, string][] = [
      ['P0002', 404, 'not_found'],
      ['0A000', 403, 'ordering_off'],
      ['54000', 429, 'too_many'],
      ['23514', 422, 'unavailable'],
      ['22023', 422, 'invalid'],
      ['XX000', 502, 'server_error'],
    ];
    for (const [code, status, error] of cases) {
      const f = fakeFetch({ guest_place_order: () => json({ code, message: 'detail' }, 400) });
      const r = await guestOrderResponse(
        post({ token: TOKEN, clientId: CID, lines }, `4.4.4.${status}${code.length}`),
        env,
        { fetchImpl: f },
      );
      expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([status, error]);
    }
  });
  it('rejects GET', async () => {
    expect((await guestOrderResponse(new Request('https://app.test/x'), env)).status).toBe(405);
  });
});

describe('POST /api/guest/call', () => {
  const call = (body: unknown, ip: string) =>
    new Request('https://app.test/api/guest/call', {
      method: 'POST',
      headers: { 'x-forwarded-for': ip },
      body: JSON.stringify(body),
    });
  it('asks the database for the staff with a closed reason and says "called"', async () => {
    const f = vi.fn(async () => json({ status: 'called', id: 'x' })) as unknown as typeof fetch;
    const r = await guestCallResponse(call({ token: TOKEN, reason: 'bill' }, '40.0.0.1'), env, {
      fetchImpl: f,
    });
    expect(await r.json()).toEqual({ status: 'called' });
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toContain('/rpc/guest_call_staff');
    expect(JSON.parse(String(init.body))).toEqual({ p_token: TOKEN, p_reason: 'bill' });
  });
  it('a second tap says "already" (no second call)', async () => {
    const f = fakeFetch({ guest_call_staff: () => json({ status: 'already', id: 'x' }) });
    expect(
      await (
        await guestCallResponse(call({ token: TOKEN, reason: 'help' }, '40.0.0.2'), env, {
          fetchImpl: f,
        })
      ).json(),
    ).toEqual({ status: 'already' });
  });
  it('refuses free text, a bad token and other methods before touching the database', async () => {
    const f = fakeFetch({});
    expect(
      (
        await guestCallResponse(
          call({ token: TOKEN, reason: 'please bring a pony' }, '40.0.0.3'),
          env,
          { fetchImpl: f },
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await guestCallResponse(call({ token: 'bad', reason: 'help' }, '40.0.0.4'), env, {
          fetchImpl: f,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await guestCallResponse(new Request('https://app.test/api/guest/call'), env, {
          fetchImpl: f,
        })
      ).status,
    ).toBe(405);
    expect(f).not.toHaveBeenCalled();
  });
  it('maps the database refusals: unknown table 404, QR off 403, too many 429', async () => {
    const run = async (code: string, ip: string) => {
      const f = vi.fn(async () => json({ code }, 400)) as unknown as typeof fetch;
      return (
        await guestCallResponse(call({ token: TOKEN, reason: 'help' }, ip), env, { fetchImpl: f })
      ).status;
    };
    expect(await run('P0002', '40.0.1.1')).toBe(404);
    expect(await run('0A000', '40.0.1.2')).toBe(403);
    expect(await run('53400', '40.0.1.3')).toBe(429);
  });
  it('rate limits one phone', async () => {
    const f = fakeFetch({ guest_call_staff: () => json({ status: 'called' }) });
    let last = 200;
    for (let i = 0; i < 10; i++)
      last = (
        await guestCallResponse(call({ token: TOKEN, reason: 'help' }, '40.0.2.1'), env, {
          fetchImpl: f,
        })
      ).status;
    expect(last).toBe(429);
  });
});

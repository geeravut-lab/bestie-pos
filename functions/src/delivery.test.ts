import { describe, expect, it, vi } from 'vitest';
import { deliveryIntakeResponse } from './delivery-handler.js';

const TOKEN = 'c'.repeat(64);
const env = {
  SUPABASE_URL: 'https://x.supabase.co',
  VITE_SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'svc',
};
const calls: { fn: string; body: Record<string, unknown> }[] = [];
const fakeFetch = (answer: unknown, status = 200) =>
  vi.fn(async (url: unknown, init?: RequestInit) => {
    const fn = /\/rpc\/(\w+)$/.exec(String(url))?.[1] ?? '';
    calls.push({ fn, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return Response.json(answer, { status });
  }) as unknown as typeof fetch;
let n = 0;
const post = (body: unknown, auth: string | null = `Bearer ${TOKEN}`) =>
  new Request('https://x/api/delivery/intake', {
    method: 'POST',
    headers: { 'x-forwarded-for': `5.5.5.${(n += 1)}`, ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  });
const order = {
  ref: ' LM-1 ',
  name: 'Somchai',
  items: [
    { barcode: 'RICE-001', quantity: 2, note: 'spicy' },
    { sku: 'TEA-1', quantity: 1 },
  ],
};

describe('delivery intake', () => {
  it('passes a good order to the database function with trimmed text and the token from the header', async () => {
    const f = fakeFetch({ ok: true, order_id: 'o1', number: 'DL001', lines: 2, replay: false });
    const res = await deliveryIntakeResponse(post(order), env, { fetchImpl: f });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      order_id: 'o1',
      number: 'DL001',
      lines: 2,
      replay: false,
    });
    expect(calls.at(-1)).toMatchObject({
      fn: 'delivery_intake',
      body: {
        p_token: TOKEN,
        p: {
          ref: 'LM-1',
          name: 'Somchai',
          items: [
            { barcode: 'RICE-001', quantity: 2, note: 'spicy' },
            { sku: 'TEA-1', quantity: 1 },
          ],
        },
      },
    });
  });
  it('needs a Bearer token of the right shape (no token in the body or the address)', async () => {
    const f = fakeFetch({});
    expect((await deliveryIntakeResponse(post(order, null), env, { fetchImpl: f })).status).toBe(
      401,
    );
    expect(
      (await deliveryIntakeResponse(post(order, 'Bearer short'), env, { fetchImpl: f })).status,
    ).toBe(401);
    expect(
      (await deliveryIntakeResponse(post(order, `Basic ${TOKEN}`), env, { fetchImpl: f })).status,
    ).toBe(401);
  });
  it('answers a wrong token 401 and an unknown item 422 with the item named', async () => {
    const r1 = await deliveryIntakeResponse(post(order), env, {
      fetchImpl: fakeFetch({ ok: false, error: 'unauthorized' }),
    });
    expect(r1.status).toBe(401);
    const r2 = await deliveryIntakeResponse(post(order), env, {
      fetchImpl: fakeFetch({ ok: false, error: 'unknown_item', item: 'NOPE-9' }),
    });
    expect(r2.status).toBe(422);
    expect(await r2.json()).toEqual({ ok: false, error: 'unknown_item', item: 'NOPE-9' });
  });
  it('a repeated platform order is a 200 with replay true', async () => {
    const res = await deliveryIntakeResponse(post(order), env, {
      fetchImpl: fakeFetch({ ok: true, order_id: 'o1', number: 'DL001', lines: 2, replay: true }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { replay: boolean }).replay).toBe(true);
  });
  it('refuses wrong shapes before the database is asked', async () => {
    const f = fakeFetch({});
    const before = calls.length;
    for (const bad of [
      { ...order, items: [] },
      { ...order, items: 'x' },
      { ...order, items: [{ barcode: 'A', quantity: 'two' }] },
      { ...order, items: [{ barcode: 'A', quantity: 1.5 }] },
      { ...order, items: Array.from({ length: 41 }, () => ({ barcode: 'A', quantity: 1 })) },
    ])
      expect((await deliveryIntakeResponse(post(bad), env, { fetchImpl: f })).status).toBe(422);
    expect(calls.length).toBe(before);
  });
  it('only POST, and a server fault is a 502', async () => {
    expect(
      (
        await deliveryIntakeResponse(new Request('https://x/api/delivery/intake'), env, {
          fetchImpl: fakeFetch({}),
        })
      ).status,
    ).toBe(405);
    expect(
      (await deliveryIntakeResponse(post(order), env, { fetchImpl: fakeFetch({}, 500) })).status,
    ).toBe(502);
  });
  it('limits how fast one token can send', async () => {
    const f = fakeFetch({ ok: true, order_id: 'o', number: 'DL001', lines: 1, replay: false });
    const tok = 'd'.repeat(64);
    const req = () =>
      new Request('https://x/api/delivery/intake', {
        method: 'POST',
        headers: { authorization: `Bearer ${tok}`, 'x-forwarded-for': `4.4.4.${(n += 1)}` },
        body: JSON.stringify(order),
      });
    const codes: number[] = [];
    for (let i = 0; i < 62; i += 1)
      codes.push((await deliveryIntakeResponse(req(), env, { fetchImpl: f })).status);
    expect(codes.slice(0, 60).every((c) => c === 200)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });
});

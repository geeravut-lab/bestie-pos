import { describe, expect, it, vi } from 'vitest';
import { guestIslandResponse, guestPassResponse } from './network-handler.js';

const env = { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'srv' };
const T = 'a'.repeat(32);
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
const req = (url: string, init?: RequestInit) => new Request(`https://x.test${url}`, init);

describe('GET /api/guest/pass', () => {
  it('returns the parsed pass for a valid token and 404 for an unknown one', async () => {
    const ok = vi.fn(async () =>
      json({
        name: 'Liu',
        code: 'BP-ABCD2345KK',
        network: { slug: 'koh-phangan', name: { th: 'เกาะ' } },
        points: 10,
        activity: [],
        shops: [],
      }),
    );
    const r = await guestPassResponse(req(`/api/guest/pass?t=${T}`), env, {
      fetchImpl: ok as never,
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { pass: { points: number } }).pass.points).toBe(10);
    expect(String((ok.mock.calls[0] as unknown[])[0])).toContain('/rpc/guest_pass');
    const none = await guestPassResponse(req(`/api/guest/pass?t=${T}`), env, {
      fetchImpl: (async () => json(null)) as never,
    });
    expect(none.status).toBe(404);
    expect((await guestPassResponse(req('/api/guest/pass?t=bad'), env)).status).toBe(422);
  });
});

describe('POST /api/guest/pass (register)', () => {
  const post = (body: unknown) =>
    req('/api/guest/pass', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'x-forwarded-for': `9.9.${Math.floor(Math.random() * 250)}.1` },
    });
  it('passes the name, phone and consent to the database and returns the token and code', async () => {
    const f = vi.fn(async () => json({ ok: true, token: T, code: 'BP-ABCD2345KK' }));
    const r = await guestPassResponse(
      post({ slug: 'koh-phangan', name: ' Liu ', phone: '081-111-1111', consent: true }),
      env,
      { fetchImpl: f as never },
    );
    expect(((await r.json()) as { ok: boolean; token: string }).token).toBe(T);
    const body = JSON.parse(String(((f.mock.calls[0] as unknown[])[1] as RequestInit).body));
    expect(body).toMatchObject({ p_slug: 'koh-phangan', p: { name: 'Liu', consent: true } });
  });
  it('refuses a short phone before any call, and relays "exists" without handing out a pass', async () => {
    const f = vi.fn();
    expect(
      (
        await guestPassResponse(
          post({ slug: 'koh-phangan', name: 'Liu', phone: '12', consent: true }),
          env,
          { fetchImpl: f as never },
        )
      ).status,
    ).toBe(422);
    expect(f).not.toHaveBeenCalled();
    const ex = await guestPassResponse(
      post({ slug: 'koh-phangan', name: 'Liu', phone: '0811111111', consent: true }),
      env,
      { fetchImpl: (async () => json({ ok: false, error: 'exists' })) as never },
    );
    const o = (await ex.json()) as { ok: boolean; error: string; token?: string };
    expect(o).toMatchObject({ ok: false, error: 'exists' });
    expect(o.token).toBeUndefined();
  });
});

describe('GET /api/guest/island', () => {
  it('returns the marketplace, 404 for an unknown network, 422 for a bad slug', async () => {
    const f = async () =>
      json({
        network: { slug: 'koh-phangan', name: { th: 'เกาะ' } },
        shops: [{ category: 'spa', title: { th: 'สปา' } }],
      });
    const r = await guestIslandResponse(req('/api/guest/island?n=koh-phangan'), env, {
      fetchImpl: f as never,
    });
    expect(((await r.json()) as { island: { shops: unknown[] } }).island.shops.length).toBe(1);
    expect(
      (
        await guestIslandResponse(req('/api/guest/island?n=koh-phangan'), env, {
          fetchImpl: (async () => json(null)) as never,
        })
      ).status,
    ).toBe(404);
    expect((await guestIslandResponse(req('/api/guest/island?n=X'), env)).status).toBe(422);
  });
});

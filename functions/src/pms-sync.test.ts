import { describe, expect, it, vi } from 'vitest';
import { pmsInHouseResponse, postPmsCharges } from './pms-sync.js';
import type { PmsAdapter } from './pms.js';

const env = {
  SUPABASE_URL: 'https://x.supabase.co',
  VITE_SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'svc',
  SUPABASE_ANON_KEY: 'anon',
};
const STORE = '11111111-1111-4111-8111-111111111111';
const req = (qs = `store=${STORE}`, auth: string | null = 'Bearer user-jwt') =>
  new Request(`https://x/api/pms/in-house?${qs}`, { headers: auth ? { authorization: auth } : {} });
const guests = [
  {
    reservationId: 'R1',
    guestName: 'Anna',
    room: '101',
    checkIn: '2026-11-20',
    checkOut: '2026-11-23',
  },
];
const adapter = (over: Partial<PmsAdapter> = {}): PmsAdapter => ({
  name: 'mews',
  inHouse: async () => guests,
  postCharge: async (c) => ({ ok: true, id: `P-${c.reference}` }),
  ...over,
});

describe('GET /api/pms/in-house', () => {
  it('needs a token and a store id', async () => {
    expect(
      (await pmsInHouseResponse(req(`store=${STORE}`, null), env, { adapter: adapter() })).status,
    ).toBe(403);
    expect((await pmsInHouseResponse(req('store=nope'), env, { adapter: adapter() })).status).toBe(
      403,
    );
    expect(
      (await pmsInHouseResponse(new Request('https://x/api/pms/in-house', { method: 'POST' }), env))
        .status,
    ).toBe(405);
  });
  it('asks the database as the person first, then reads the PMS', async () => {
    const seen: { url: string; auth: string }[] = [];
    const f = vi.fn(async (url: unknown, init?: RequestInit) => {
      seen.push({
        url: String(url),
        auth: String((init?.headers as Record<string, string>).Authorization),
      });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const res = await pmsInHouseResponse(req(), env, { fetchImpl: f, adapter: adapter() });
    expect(await res.json()).toEqual({ available: true, provider: 'mews', guests });
    expect(seen[0]).toEqual({
      url: 'https://x.supabase.co/rest/v1/rpc/pms_context',
      auth: 'Bearer user-jwt',
    });
  });
  it('refuses when the database refuses, says so when no PMS is set, and reports an unreachable PMS', async () => {
    const no = vi.fn(async () => new Response('{}', { status: 403 })) as unknown as typeof fetch;
    expect(
      (await pmsInHouseResponse(req(), env, { fetchImpl: no, adapter: adapter() })).status,
    ).toBe(403);
    const ok = vi.fn(async () => Response.json({ ok: true })) as unknown as typeof fetch;
    expect(
      await (await pmsInHouseResponse(req(), env, { fetchImpl: ok, adapter: null })).json(),
    ).toEqual({ available: false });
    const down = adapter({
      inHouse: async () => {
        throw new Error('boom');
      },
    });
    expect((await pmsInHouseResponse(req(), env, { fetchImpl: ok, adapter: down })).status).toBe(
      502,
    );
  });
});

describe('postPmsCharges (the tick)', () => {
  const run = (pending: unknown, a: PmsAdapter | null) => {
    const calls: { fn: string; body: Record<string, unknown> }[] = [];
    const f = vi.fn(async (url: unknown, init?: RequestInit) => {
      const fn = /\/rpc\/(\w+)$/.exec(String(url))?.[1] ?? '';
      calls.push({ fn, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json(fn === 'pms_pending_charges' ? pending : null);
    }) as unknown as typeof fetch;
    return { calls, p: postPmsCharges(env, f, a) };
  };
  it('does nothing without a PMS', async () => {
    const r = run([], null);
    expect(await r.p).toBe(0);
    expect(r.calls).toHaveLength(0);
  });
  it('posts every pending charge with the receipt number as the reference and reports each result', async () => {
    const post = vi.fn(async (c: { reference: string }) =>
      c.reference === 'A+000002'
        ? ({ ok: false, error: 'closed' } as const)
        : ({ ok: true, id: 'X1' } as const),
    );
    const r = run(
      [
        { id: 'c1', reservation: 'R1', amount: 21000, receipt: 'A+000001', outlet: 'Pool Bar' },
        { id: 'c2', reservation: 'R1', amount: 5000, receipt: 'A+000002', outlet: 'Spa' },
      ],
      adapter({ postCharge: post as PmsAdapter['postCharge'] }),
    );
    expect(await r.p).toBe(1);
    expect(post).toHaveBeenCalledWith({
      reservationId: 'R1',
      amountSatang: 21000,
      description: 'Pool Bar',
      reference: 'A+000001',
    });
    const marks = r.calls.filter((c) => c.fn === 'pms_mark_posted').map((c) => c.body);
    expect(marks).toEqual([
      { p_charge: 'c1', p_ok: true, p_ref: 'X1', p_error: null },
      { p_charge: 'c2', p_ok: false, p_ref: null, p_error: 'closed' },
    ]);
  });
  it('a throwing adapter is a failed posting, not a crashed tick', async () => {
    const r = run(
      [{ id: 'c1', reservation: 'R1', amount: 100, receipt: 'A+1', outlet: 'Bar' }],
      adapter({
        postCharge: async () => {
          throw new Error('timeout');
        },
      }),
    );
    expect(await r.p).toBe(0);
    expect(r.calls.at(-1)!.body).toMatchObject({ p_ok: false, p_error: 'timeout' });
  });
});

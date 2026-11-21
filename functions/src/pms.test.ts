import { describe, expect, it, vi } from 'vitest';
import { cloudbedsAdapter, mewsAdapter, pmsFromEnv } from './pms.js';

const fakeFetch = (answer: unknown, status = 200) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Response.json(answer, { status });
  }) as unknown as typeof fetch;
  return { f, calls };
};

describe('PMS adapters', () => {
  it('are off without their secrets and never fall back to another provider', () => {
    expect(pmsFromEnv({ PMS_PROVIDER: 'cloudbeds' })).toBeNull();
    expect(pmsFromEnv({ PMS_PROVIDER: 'mews', MEWS_CLIENT_TOKEN: 'a' })).toBeNull();
    expect(pmsFromEnv({ PMS_PROVIDER: 'other', CLOUDBEDS_API_KEY: 'k' })).toBeNull();
    expect(pmsFromEnv({ CLOUDBEDS_API_KEY: 'k' })).toBeNull();
    expect(
      cloudbedsAdapter({ CLOUDBEDS_API_KEY: 'k', CLOUDBEDS_BASE_URL: 'http://insecure' }),
    ).toBeNull();
    expect(pmsFromEnv({ PMS_PROVIDER: 'cloudbeds', CLOUDBEDS_API_KEY: 'k' })?.name).toBe(
      'cloudbeds',
    );
  });
  it('Cloudbeds: lists checked-in guests and posts a charge in baht', async () => {
    const { f, calls } = fakeFetch({
      data: [
        {
          reservationID: 'R1',
          guestName: 'Anna',
          roomName: '101',
          startDate: '2026-11-20',
          endDate: '2026-11-23',
        },
      ],
      success: true,
    });
    const a = cloudbedsAdapter({ CLOUDBEDS_API_KEY: 'k' }, f)!;
    expect(await a.inHouse()).toEqual([
      {
        reservationId: 'R1',
        guestName: 'Anna',
        room: '101',
        checkIn: '2026-11-20',
        checkOut: '2026-11-23',
      },
    ]);
    expect(calls[0]!.url).toContain('status=checked_in');
    const g = fakeFetch({ success: true, data: { itemID: 'I9' } });
    const r = await cloudbedsAdapter({ CLOUDBEDS_API_KEY: 'k' }, g.f)!.postCharge({
      reservationId: 'R1',
      amountSatang: 21050,
      description: 'Pool bar',
      reference: 'A+000001',
    });
    expect(r).toEqual({ ok: true, id: 'I9' });
    const body = String(g.calls[0]!.init!.body);
    expect(body).toContain('itemPrice=210.5');
    expect(body).toContain('itemNote=A%2B000001');
    expect((g.calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer k');
  });
  it('Cloudbeds: a refusal is reported, not thrown', async () => {
    const { f } = fakeFetch({ success: false, message: 'no such reservation' }, 400);
    expect(
      await cloudbedsAdapter({ CLOUDBEDS_API_KEY: 'k' }, f)!.postCharge({
        reservationId: 'x',
        amountSatang: 100,
        description: 'd',
        reference: 'r',
      }),
    ).toEqual({ ok: false, error: 'no such reservation' });
    const down = fakeFetch({}, 503);
    await expect(cloudbedsAdapter({ CLOUDBEDS_API_KEY: 'k' }, down.f)!.inHouse()).rejects.toThrow(
      'cloudbeds 503',
    );
  });
  it('Mews: joins reservations with guests and rooms, and posts an order in baht', async () => {
    const env = { MEWS_CLIENT_TOKEN: 'c', MEWS_ACCESS_TOKEN: 'a' };
    const { f, calls } = fakeFetch({
      Reservations: [
        {
          Id: 'RV1',
          AccountId: 'C1',
          AssignedResourceId: 'RS1',
          StartUtc: '2026-11-20T05:00:00Z',
          EndUtc: '2026-11-23T05:00:00Z',
        },
      ],
      Customers: [{ Id: 'C1', FirstName: 'Anna', LastName: 'Berg' }],
      Resources: [{ Id: 'RS1', Name: '101' }],
    });
    expect(await mewsAdapter(env, f)!.inHouse()).toEqual([
      {
        reservationId: 'RV1',
        guestName: 'Anna Berg',
        room: '101',
        checkIn: '2026-11-20T05:00:00Z',
        checkOut: '2026-11-23T05:00:00Z',
      },
    ]);
    const sent = JSON.parse(String(calls[0]!.init!.body)) as Record<string, unknown>;
    expect(sent).toMatchObject({ ClientToken: 'c', AccessToken: 'a', States: ['Started'] });
    const g = fakeFetch({ OrderId: 'O1' });
    expect(
      await mewsAdapter(env, g.f)!.postCharge({
        reservationId: 'C1',
        amountSatang: 21000,
        description: 'Spa',
        reference: 'A+000002',
      }),
    ).toEqual({ ok: true, id: 'O1' });
    const o = JSON.parse(String(g.calls[0]!.init!.body)) as {
      Items: { UnitAmount: { GrossValue: number; Currency: string } }[];
    };
    expect(o.Items[0]!.UnitAmount).toEqual({ Currency: 'THB', GrossValue: 210 });
    const bad = fakeFetch({ Message: 'Invalid token' }, 401);
    expect(
      await mewsAdapter(env, bad.f)!.postCharge({
        reservationId: 'C1',
        amountSatang: 100,
        description: 'd',
        reference: 'r',
      }),
    ).toEqual({ ok: false, error: 'Invalid token' });
  });
});

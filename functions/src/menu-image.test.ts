import { describe, expect, it, vi } from 'vitest';
import { menuImageResponse } from './menu-image.js';

const ID = '11111111-1111-4111-8111-111111111111';
const env = {
  SUPABASE_URL: 'https://x.supabase.co',
  VITE_SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'svc',
};
const b64 = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3));
const get = (qs: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Request(`https://x/api/menu-image?${qs}`, { method, headers });
const answer = (body: unknown, status = 200) =>
  vi.fn(async () => Response.json(body, { status })) as unknown as typeof fetch;

describe('GET /api/menu-image', () => {
  it('serves the picture bytes with the right type and a year of immutable caching for the current version', async () => {
    const f = answer({ mime: 'image/jpeg', version: 3, b64 });
    const res = await menuImageResponse(get(`i=${ID}&v=3`), env, { fetchImpl: f });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const call = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(call[0]).toContain('/rpc/menu_image_get');
    expect(JSON.parse(String(call[1].body))).toEqual({ p_item: ID });
  });

  it('an old address still answers but is not cached for long', async () => {
    const res = await menuImageResponse(get(`i=${ID}&v=2`), env, {
      fetchImpl: answer({ mime: 'image/png', version: 3, b64 }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('an unchanged picture is answered 304 without asking the database', async () => {
    const f = answer({});
    const res = await menuImageResponse(
      get(`i=${ID}&v=3`, { 'if-none-match': `"mi-${ID}-3"` }),
      env,
      { fetchImpl: f },
    );
    expect(res.status).toBe(304);
    expect(f).not.toHaveBeenCalled();
  });

  it('no picture, a database refusal or a strange type is a plain 404', async () => {
    expect(
      (await menuImageResponse(get(`i=${ID}&v=1`), env, { fetchImpl: answer(null) })).status,
    ).toBe(404);
    expect(
      (await menuImageResponse(get(`i=${ID}&v=1`), env, { fetchImpl: answer({}, 500) })).status,
    ).toBe(404);
    expect(
      (
        await menuImageResponse(get(`i=${ID}&v=1`), env, {
          fetchImpl: answer({ mime: 'image/svg+xml', version: 1, b64 }),
        })
      ).status,
    ).toBe(404);
  });

  it('bad ids and versions never reach the database', async () => {
    const f = answer({ mime: 'image/png', version: 1, b64 });
    for (const qs of ['i=nope&v=1', `i=${ID}`, `i=${ID}&v=x`, `i=${ID}&v=-1`, `i=${ID}';drop&v=1`])
      expect((await menuImageResponse(get(qs), env, { fetchImpl: f })).status).toBe(404);
    expect(f).not.toHaveBeenCalled();
  });

  it('only GET and HEAD', async () => {
    expect(
      (await menuImageResponse(get(`i=${ID}&v=1`, {}, 'POST'), env, { fetchImpl: answer({}) }))
        .status,
    ).toBe(405);
    const head = await menuImageResponse(get(`i=${ID}&v=1`, {}, 'HEAD'), env, {
      fetchImpl: answer({ mime: 'image/png', version: 1, b64 }),
    });
    expect(head.status).toBe(200);
  });
});

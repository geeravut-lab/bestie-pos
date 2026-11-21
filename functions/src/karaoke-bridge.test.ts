import { describe, expect, it, vi } from 'vitest';
import { karaokeBridgeResponse } from './karaoke-bridge-handler.js';

const TOKEN = 'a'.repeat(64);
const SONG = '11111111-1111-4111-8111-111111111111';
const env = {
  SUPABASE_URL: 'https://x.supabase.co',
  VITE_SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'svc',
};
const calls: { fn: string; body: Record<string, unknown> }[] = [];
const fakeFetch = (answer: unknown) =>
  vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({
      fn: /\/rpc\/(\w+)$/.exec(String(url))?.[1] ?? '',
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return Response.json(answer);
  }) as unknown as typeof fetch;
let n = 0;
const req = (method: string, body?: unknown, auth: string | null = `Bearer ${TOKEN}`) =>
  new Request('https://x/api/karaoke/bridge', {
    method,
    headers: { 'x-forwarded-for': `7.7.7.${(n += 1)}`, ...(auth ? { authorization: auth } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('karaoke bridge', () => {
  it('needs a well-formed Bearer key', async () => {
    expect(
      (await karaokeBridgeResponse(req('GET', undefined, null), env, { fetchImpl: fakeFetch({}) }))
        .status,
    ).toBe(401);
    expect(
      (
        await karaokeBridgeResponse(req('GET', undefined, 'Bearer abc'), env, {
          fetchImpl: fakeFetch({}),
        })
      ).status,
    ).toBe(401);
    expect((await karaokeBridgeResponse(req('PUT'), env)).status).toBe(405);
  });
  it('polls the queue with the key', async () => {
    calls.length = 0;
    const f = fakeFetch({
      ok: true,
      room: 'VIP 1',
      running: true,
      now: null,
      queue: [{ id: SONG, video_id: 'dQw4w9WgXcQ', title: 'x' }],
    });
    const res = await karaokeBridgeResponse(req('GET'), env, { fetchImpl: f });
    expect(res.status).toBe(200);
    expect((await res.json()).queue).toHaveLength(1);
    expect(calls[0]).toEqual({ fn: 'bridge_karaoke_poll', body: { p_token: TOKEN } });
  });
  it('a refused key is a 401', async () => {
    const res = await karaokeBridgeResponse(req('GET'), env, {
      fetchImpl: fakeFetch({ ok: false, error: 'unauthorized' }),
    });
    expect(res.status).toBe(401);
  });
  it('reports a song and checks the shape first', async () => {
    calls.length = 0;
    expect(
      (
        await karaokeBridgeResponse(req('POST', { song: 'nope', status: 'done' }), env, {
          fetchImpl: fakeFetch({}),
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await karaokeBridgeResponse(req('POST', { song: SONG, status: 'deleted' }), env, {
          fetchImpl: fakeFetch({}),
        })
      ).status,
    ).toBe(422);
    expect(calls).toHaveLength(0);
    const ok = await karaokeBridgeResponse(req('POST', { song: SONG, status: 'playing' }), env, {
      fetchImpl: fakeFetch({ ok: true }),
    });
    expect(await ok.json()).toEqual({ ok: true });
    expect(calls[0]).toEqual({
      fn: 'bridge_karaoke_song',
      body: { p_token: TOKEN, p_song: SONG, p_status: 'playing' },
    });
    const bad = await karaokeBridgeResponse(req('POST', { song: SONG, status: 'done' }), env, {
      fetchImpl: fakeFetch({ ok: false, error: 'invalid_state' }),
    });
    expect(bad.status).toBe(409);
  });
});

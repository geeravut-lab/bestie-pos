import { describe, expect, it, vi } from 'vitest';
import {
  guestFeedbackResponse,
  guestInfoAskResponse,
  guestInfoResponse,
} from './guest-extras-handler.js';
import type { ProviderAdapter } from './ai-adapters.js';

const TOKEN = 'a'.repeat(32);
const env = {
  SUPABASE_URL: 'https://x.supabase.co',
  VITE_SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'svc',
  ANTHROPIC_API_KEY: 'k',
};
const CARDS = [
  { id: 'a', title: { th: 'ไวไฟ', en: 'Wifi' }, body: { th: 'รหัส 1234', en: 'Password 1234' } },
  { id: 'b', title: { th: 'เวลาเปิด' }, body: { th: '8-22' } },
];
const adapter = (text: string): ProviderAdapter => ({
  id: 'anthropic',
  call: vi.fn(async () => ({
    text,
    provider: 'anthropic' as const,
    model: 'm',
    usage: { inputTokens: 3, outputTokens: 4 },
  })),
});
const calls: { fn: string; body: Record<string, unknown> }[] = [];
const fakeFetch = (
  o: { table?: boolean; ai?: boolean; infoNull?: boolean; feedbackCode?: string } = {},
) =>
  vi.fn(async (url: unknown, init?: RequestInit) => {
    const fn = /\/rpc\/(\w+)$/.exec(String(url))?.[1];
    if (!fn) return Response.json([]);
    calls.push({ fn, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    if (fn === 'guest_info') return Response.json(o.infoNull ? null : CARDS);
    if (fn === 'guest_table')
      return Response.json(
        o.table === false ? null : { ai_enabled: o.ai !== false, store_id: 's1' },
      );
    if (fn === 'guest_feedback_submit')
      return o.feedbackCode
        ? Response.json({ code: o.feedbackCode }, { status: 400 })
        : Response.json('11111111-1111-4111-8111-111111111111');
    return Response.json(null);
  }) as unknown as typeof fetch;
let n = 0;
const post = (path: string, body: unknown) =>
  new Request(`https://x${path}`, {
    method: 'POST',
    headers: { 'x-forwarded-for': `9.9.9.${(n += 1)}` },
    body: JSON.stringify(body),
  });
const get = (path: string) =>
  new Request(`https://x${path}`, { headers: { 'x-forwarded-for': `8.8.8.${(n += 1)}` } });

describe('GET /api/guest/info', () => {
  it('returns the shop’s cards for a table token', async () => {
    const res = await guestInfoResponse(get(`/api/guest/info?t=${TOKEN}`), env, {
      fetchImpl: fakeFetch(),
    });
    const b = (await res.json()) as { info: { id: string }[] };
    expect(b.info.map((c) => c.id)).toEqual(['a', 'b']);
  });
  it('refuses a bad token and an unknown table', async () => {
    expect(
      (await guestInfoResponse(get('/api/guest/info?t=zz'), env, { fetchImpl: fakeFetch() }))
        .status,
    ).toBe(422);
    expect(
      (
        await guestInfoResponse(get(`/api/guest/info?t=${TOKEN}`), env, {
          fetchImpl: fakeFetch({ infoNull: true }),
        })
      ).status,
    ).toBe(404);
  });
});

describe('POST /api/guest/info-ask', () => {
  it('shows only cards the model pointed at that really exist (numbers, not text) and logs tokens only', async () => {
    calls.length = 0;
    const a = adapter('{"ids": [2, 9, "x", 1]}');
    const res = await guestInfoAskResponse(
      post('/api/guest/info-ask', { t: TOKEN, text: 'what time do you open?' }),
      env,
      {
        fetchImpl: fakeFetch(),
        adapters: { anthropic: a, google: a },
      },
    );
    const b = (await res.json()) as { available: boolean; cards: { id: string }[] };
    expect(b.available).toBe(true);
    expect(b.cards.map((c) => c.id)).toEqual(['b', 'a']);
    expect(JSON.stringify(calls.find((c) => c.fn === 'log_ai_usage')!.body)).not.toContain('open');
    const prompt = String((a.call as ReturnType<typeof vi.fn>).mock.calls[0]![0].prompt);
    expect(prompt).toContain('1. ไวไฟ / Wifi');
    expect(prompt).not.toContain('1234'); // the model sees titles only, never the card text
  });
  it('a model that writes prose gets nothing through', async () => {
    const a = adapter('The wifi password is 1234.');
    const res = await guestInfoAskResponse(
      post('/api/guest/info-ask', { t: TOKEN, text: 'wifi?' }),
      env,
      {
        fetchImpl: fakeFetch(),
        adapters: { anthropic: a, google: a },
      },
    );
    expect(((await res.json()) as { cards: unknown[] }).cards).toEqual([]);
  });
  it('is off with the module off or no key, and refuses bad input', async () => {
    const a = adapter('{"ids":[1]}');
    const off = await guestInfoAskResponse(
      post('/api/guest/info-ask', { t: TOKEN, text: 'wifi?' }),
      env,
      {
        fetchImpl: fakeFetch({ ai: false }),
        adapters: { anthropic: a, google: a },
      },
    );
    expect(await off.json()).toEqual({ available: false });
    const nokey = await guestInfoAskResponse(
      post('/api/guest/info-ask', { t: TOKEN, text: 'wifi?' }),
      { ...env, ANTHROPIC_API_KEY: undefined },
      { fetchImpl: fakeFetch(), adapters: { anthropic: a, google: a } },
    );
    expect(await nokey.json()).toEqual({ available: false });
    expect(a.call).not.toHaveBeenCalled();
    expect(
      (
        await guestInfoAskResponse(post('/api/guest/info-ask', { t: TOKEN, text: 'a' }), env, {
          fetchImpl: fakeFetch(),
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await guestInfoAskResponse(post('/api/guest/info-ask', { t: 'bad', text: 'wifi?' }), env, {
          fetchImpl: fakeFetch(),
        })
      ).status,
    ).toBe(422);
  });
});

describe('POST /api/guest/feedback', () => {
  it('stores a rating with a closed topic and a short comment', async () => {
    calls.length = 0;
    const res = await guestFeedbackResponse(
      post('/api/guest/feedback', { token: TOKEN, rating: 2, topic: 'service', comment: 'slow' }),
      env,
      {
        fetchImpl: fakeFetch(),
      },
    );
    expect(await res.json()).toEqual({ ok: true });
    expect(calls[0]!.body).toEqual({
      p_token: TOKEN,
      p_rating: 2,
      p_topic: 'service',
      p_comment: 'slow',
    });
  });
  it('refuses bad ratings / topics and maps the database answers', async () => {
    const bad = (body: unknown) =>
      guestFeedbackResponse(post('/api/guest/feedback', body), env, { fetchImpl: fakeFetch() });
    expect((await bad({ token: TOKEN, rating: 6 })).status).toBe(422);
    expect((await bad({ token: TOKEN, rating: 2.5 })).status).toBe(422);
    expect((await bad({ token: TOKEN, rating: 3, topic: 'weather' })).status).toBe(422);
    expect((await bad({ token: 'x', rating: 3 })).status).toBe(422);
    const code = async (c: string) =>
      (
        await guestFeedbackResponse(post('/api/guest/feedback', { token: TOKEN, rating: 3 }), env, {
          fetchImpl: fakeFetch({ feedbackCode: c }),
        })
      ).status;
    expect(await code('P0002')).toBe(404);
    expect(await code('0A000')).toBe(403);
    expect(await code('53400')).toBe(429);
  });
});

describe('GET /api/guest/eta', () => {
  it('asks the database with the table token and returns the minutes, or null', async () => {
    const { guestEtaResponse } = await import('./guest-extras-handler.js');
    const env2 = {
      SUPABASE_URL: 'https://x.supabase.co',
      VITE_SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'svc',
    };
    const token = 'a'.repeat(32);
    const f = vi.fn(async () =>
      Response.json({ ok: true, minutes: 12, waiting: 2 }),
    ) as unknown as typeof fetch;
    const res = await guestEtaResponse(
      new Request(`https://x/api/guest/eta?token=${token}`, {
        headers: { 'x-forwarded-for': '3.3.3.3' },
      }),
      env2,
      { fetchImpl: f },
    );
    expect(await res.json()).toEqual({ minutes: 12 });
    expect(
      JSON.parse(
        String(
          (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1].body,
        ),
      ),
    ).toEqual({ p_token: token });
    const none = await guestEtaResponse(new Request('https://x/api/guest/eta?token=nope'), env2, {
      fetchImpl: f,
    });
    expect(await none.json()).toEqual({ minutes: null });
    const empty = vi.fn(async () =>
      Response.json({ ok: true, minutes: null }),
    ) as unknown as typeof fetch;
    expect(
      await (
        await guestEtaResponse(
          new Request(`https://x/api/guest/eta?token=${token}`, {
            headers: { 'x-forwarded-for': '3.3.3.4' },
          }),
          env2,
          { fetchImpl: empty },
        )
      ).json(),
    ).toEqual({ minutes: null });
  });
});

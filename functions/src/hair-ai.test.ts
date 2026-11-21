import { describe, expect, it, vi } from 'vitest';
import { createAnthropicAdapter, createGoogleAdapter } from './ai-adapters.js';
import type { ProviderAdapter } from './ai-adapters.js';
import { guestBookingResponse } from './booking-handler.js';
import { parseHairLabels, labelsToAnswers } from '../../packages/core/src/hairAdvisor.js';

const env = {
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_ROLE_KEY: 'srv',
  ANTHROPIC_API_KEY: 'k',
};
const T = 'd'.repeat(32);
const ID = '11111111-1111-1111-1111-111111111111';
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
const post = (body: unknown) =>
  new Request('https://x.test/api/guest/booking', {
    method: 'POST',
    body: JSON.stringify({ t: T, op: 'hair_ai', id: ID, code: 'ABCD2345', ...(body as object) }),
    headers: {
      'x-forwarded-for': `5.5.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
    },
  });
const fakeAdapter = (text: string): ProviderAdapter => ({
  id: 'anthropic',
  call: vi.fn(async (_r, model) => ({
    text,
    provider: 'anthropic' as const,
    model,
    usage: { inputTokens: 900, outputTokens: 30 },
  })),
});
const adapters = (text: string) => {
  const a = fakeAdapter(text);
  return { a, map: { anthropic: a, google: { ...a, id: 'google' as const } } };
};
/** The database answers by function name. */
const db = (over: Record<string, unknown> = {}) =>
  vi.fn(async (input: unknown, init?: RequestInit) => {
    const u = String(input);
    const fn = /\/rpc\/(\w+)/.exec(u)?.[1] ?? '';
    if (fn in over) return json(over[fn]);
    if (fn === 'guest_hair_ai_input')
      return json({ ok: true, store_id: 's1', mime: 'image/jpeg', data: 'AAAA' });
    if (fn === 'guest_hair_ai_save') return json({ ok: true });
    if (fn === 'guest_hair_ai_state') return json({ enabled: true, consent: true, labels: null });
    if (fn === 'guest_hair_ai_consent') return json({ ok: true, consent: true });
    if (fn === 'log_ai_usage') return json(null);
    if (u.includes('ai_prompt_versions')) return json([]);
    if (u.includes('ai_settings')) return json([]);
    void init;
    return json(null);
  });

describe('parseHairLabels', () => {
  it('keeps only the closed labels', () => {
    const l = parseHairLabels(
      'Sure! {"readable": true, "length": "long", "texture": "wavy", "thickness": "fine", "colored": true, "condition": "healthy", "age": 30, "name": "Ann"} thanks',
    );
    expect(l).toEqual({
      length: 'long',
      texture: 'wavy',
      thickness: 'fine',
      colored: true,
      condition: 'healthy',
    });
    expect(labelsToAnswers(l!)).toEqual({ length: 'long', texture: 'wavy' });
  });
  it('drops values outside the lists and gives null for an unreadable photo or prose', () => {
    expect(parseHairLabels({ length: 'enormous', texture: 'frizzy' })).toBeNull();
    expect(parseHairLabels('{"readable": false}')).toBeNull();
    expect(parseHairLabels('I see a woman called Ann')).toBeNull();
    expect(parseHairLabels({ length: 'short', texture: 'x' })).toMatchObject({
      length: 'short',
      texture: null,
    });
  });
});

describe('vision in the adapters', () => {
  it('sends the picture to Anthropic as an image block before the text', async () => {
    const f = vi.fn(async () => json({ content: [{ type: 'text', text: '{}' }], usage: {} }));
    await createAnthropicAdapter(f as never).call(
      { prompt: 'look', images: [{ mime: 'image/png', data: 'QUJD' }] },
      'm',
      'k',
    );
    const body = JSON.parse(
      String(
        (f.mock.calls[0] as unknown[])[1]
          ? ((f.mock.calls[0] as unknown[])[1] as RequestInit).body
          : '',
      ),
    );
    expect(body.messages[0].content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
    });
    expect(body.messages[0].content[1]).toEqual({ type: 'text', text: 'look' });
  });
  it('sends it to Gemini as inlineData, and plain text requests stay as they were', async () => {
    const f = vi.fn(async () => json({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }));
    await createGoogleAdapter(f as never).call(
      { prompt: 'look', images: [{ mime: 'image/jpeg', data: 'QUJD' }] },
      'm',
      'k',
    );
    const body = JSON.parse(String(((f.mock.calls[0] as unknown[])[1] as RequestInit).body));
    expect(body.contents[0].parts[0]).toEqual({
      inlineData: { mimeType: 'image/jpeg', data: 'QUJD' },
    });
    const g = vi.fn(async () => json({ content: [{ type: 'text', text: 'x' }], usage: {} }));
    await createAnthropicAdapter(g as never).call({ prompt: 'plain' }, 'm', 'k');
    expect(
      JSON.parse(String(((g.mock.calls[0] as unknown[])[1] as RequestInit).body)).messages[0]
        .content,
    ).toBe('plain');
  });
});

describe('POST op hair_ai', () => {
  it('reads the photo once, keeps closed labels and logs tokens only', async () => {
    const f = db();
    const { a, map } = adapters(
      '{"readable":true,"length":"medium","texture":"curly","thickness":"thick","colored":false,"condition":"healthy","name":"Ann"}',
    );
    const r = await guestBookingResponse(post({ action: 'read' }), env, {
      fetchImpl: f as never,
      adapters: map,
    });
    const body = (await r.json()) as {
      ok: boolean;
      labels: Record<string, unknown>;
      answers: unknown;
    };
    expect(body.ok).toBe(true);
    expect(body.labels).toEqual({
      length: 'medium',
      texture: 'curly',
      thickness: 'thick',
      colored: false,
      condition: 'healthy',
    });
    expect(body.answers).toEqual({ length: 'medium', texture: 'curly' });
    const sent = (a.call as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      prompt: string;
      images: { mime: string; data: string }[];
      system: string;
    };
    expect(sent.images).toEqual([{ mime: 'image/jpeg', data: 'AAAA' }]);
    expect(sent.system).toMatch(/HAIR ONLY/);
    // nothing about the guest reaches the model
    expect(JSON.stringify(sent)).not.toMatch(/ABCD2345|11111111|Ann/);
    const saved = f.mock.calls.find((c) =>
      String(c[0]).includes('guest_hair_ai_save'),
    ) as unknown[];
    expect(JSON.parse(String((saved[1] as RequestInit).body)).p_labels).toEqual(body.labels);
    const usage = f.mock.calls.find((c) => String(c[0]).includes('log_ai_usage')) as unknown[];
    expect(String((usage[1] as RequestInit).body)).not.toMatch(/AAAA|medium|curly/);
  });
  it('does not call the model without the database’s permission (module off, no consent, photo gone)', async () => {
    for (const error of ['unavailable', 'consent_needed']) {
      const { a, map } = adapters('{"length":"long"}');
      const r = await guestBookingResponse(post({ action: 'read' }), env, {
        fetchImpl: db({ guest_hair_ai_input: { ok: false, error } }) as never,
        adapters: map,
      });
      expect(((await r.json()) as { error: string }).error).toBe(error);
      expect(a.call).not.toHaveBeenCalled();
    }
  });
  it('says so when there is no key, when the photo is unclear, and when the model fails', async () => {
    const noKey = await guestBookingResponse(
      post({ action: 'read' }),
      { ...env, ANTHROPIC_API_KEY: '' },
      { fetchImpl: db() as never },
    );
    expect(((await noKey.json()) as { error: string }).error).toBe('no_key');
    const unclear = adapters('{"readable": false}');
    const u = await guestBookingResponse(post({ action: 'read' }), env, {
      fetchImpl: db() as never,
      adapters: unclear.map,
    });
    expect(((await u.json()) as { error: string }).error).toBe('unclear');
    const bad: ProviderAdapter = {
      id: 'anthropic',
      call: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const x = await guestBookingResponse(post({ action: 'read' }), env, {
      fetchImpl: db() as never,
      adapters: { anthropic: bad, google: { ...bad, id: 'google' } },
    });
    expect(((await x.json()) as { error: string }).error).toBe('ai_failed');
  });
  it('gives and withdraws the consent, and reports the state', async () => {
    const f = db();
    await guestBookingResponse(post({ action: 'consent', on: true }), env, {
      fetchImpl: f as never,
    });
    const c = f.mock.calls.find((x) => String(x[0]).includes('guest_hair_ai_consent')) as unknown[];
    expect(JSON.parse(String((c[1] as RequestInit).body)).p_on).toBe(true);
    const s = await guestBookingResponse(post({ action: 'state' }), env, {
      fetchImpl: db({
        guest_hair_ai_state: {
          enabled: true,
          consent: true,
          labels: {
            length: 'short',
            texture: null,
            thickness: null,
            colored: null,
            condition: null,
          },
        },
      }) as never,
    });
    expect(await s.json()).toMatchObject({
      enabled: true,
      consent: true,
      answers: { length: 'short' },
    });
  });
  it('limits how often one booking can be read', async () => {
    const { map } = adapters('{"length":"long"}');
    const req = () =>
      new Request('https://x.test/api/guest/booking', {
        method: 'POST',
        body: JSON.stringify({
          t: T,
          op: 'hair_ai',
          id: '22222222-2222-2222-2222-222222222222',
          code: 'ABCD2345',
          action: 'read',
        }),
        headers: { 'x-forwarded-for': '6.6.6.6' },
      });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++)
      codes.push(
        (await guestBookingResponse(req(), env, { fetchImpl: db() as never, adapters: map }))
          .status,
      );
    expect(codes.slice(0, 4).every((c) => c === 200)).toBe(true);
    expect(codes[5]).toBe(429);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { ProviderAdapter } from './ai-adapters.js';
import {
  cleanTranslation,
  shiftSummaryResponse,
  staffTranslateResponse,
} from './staff-ai-handler.js';

const env = {
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_ROLE_KEY: 'srv',
  GOOGLE_API_KEY: 'g',
};
const SHIFT = '11111111-1111-1111-1111-111111111111';
const STORE = '22222222-2222-2222-2222-222222222222';
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
const figures = {
  store_id: STORE,
  shop: 'Cafe Nok',
  device: 'Till A',
  opened_at: '2026-11-20T02:00:00Z',
  closed_at: '2026-11-20T10:00:00Z',
  opening_cash: 100000,
  expected_cash: 482550,
  counted_cash: 480050,
  variance: -2500,
  bills: 23,
  sales: 1234567,
  by_tender: { cash: 382550, promptpay: 852017 },
};
const req = (path: string, body: unknown, token: string | null = 'user-token-abcdefghijkl') =>
  new Request(`https://x.test${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
const adapter = (
  text: string,
): { a: ProviderAdapter; map: Record<'anthropic' | 'google', ProviderAdapter> } => {
  const a: ProviderAdapter = {
    id: 'google',
    call: vi.fn(async (_r, model) => ({
      text,
      provider: 'google' as const,
      model,
      usage: { inputTokens: 100, outputTokens: 20 },
    })),
  };
  return { a, map: { google: a, anthropic: { ...a, id: 'anthropic' } } };
};
const net = (over: Record<string, unknown> = {}) =>
  vi.fn(async (input: unknown) => {
    const u = String(input);
    const fn = /\/rpc\/(\w+)/.exec(u)?.[1] ?? '';
    if (fn in over) return json(over[fn]);
    if (fn === 'shift_figures') return json(figures);
    if (fn === 'translate_context') return json({ org_id: 'o1', store_id: STORE });
    if (fn === 'log_ai_usage') return json(null);
    return json([]);
  });

describe('POST /api/shift/summary', () => {
  it('explains the figures the database gave and flags numbers it cannot find', async () => {
    const { a, map } = adapter(
      'Sales were 12,345.67 baht from 23 bills; the drawer was short by 25. Tips were 999 baht.',
    );
    const f = net();
    const r = await shiftSummaryResponse(req('/api/shift/summary', { shift_id: SHIFT }), env, {
      fetchImpl: f as never,
      adapters: map,
    });
    const b = (await r.json()) as {
      available: boolean;
      summary: string;
      unverified: string[];
      figures: string;
    };
    expect(b.available).toBe(true);
    expect(b.unverified).toEqual(['999']);
    expect(b.figures).toContain('Cash difference: SHORT by THB 25');
    const sent = (a.call as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { prompt: string };
    expect(sent.prompt).toContain('12,345.67');
    // the shift was read with the person's own token
    const call = f.mock.calls.find((c) => String(c[0]).includes('shift_figures')) as unknown[];
    expect(((call[1] as RequestInit).headers as Record<string, string>).Authorization).toBe(
      'Bearer user-token-abcdefghijkl',
    );
  });
  it('is forbidden when the database says no, without a token, and invalid for a bad id', async () => {
    const no = await shiftSummaryResponse(req('/api/shift/summary', { shift_id: SHIFT }), env, {
      fetchImpl: net({ shift_figures: null }) as never,
    });
    expect(no.status).toBe(403);
    expect(
      (await shiftSummaryResponse(req('/api/shift/summary', { shift_id: SHIFT }, null), env))
        .status,
    ).toBe(403);
    expect(
      (await shiftSummaryResponse(req('/api/shift/summary', { shift_id: 'x' }), env)).status,
    ).toBe(422);
  });
  it('says unavailable without a key and never calls a model then', async () => {
    const { a, map } = adapter('x');
    const r = await shiftSummaryResponse(
      req('/api/shift/summary', { shift_id: SHIFT }, 'tok-no-key-0123456789'),
      { SUPABASE_URL: env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: 'srv' },
      { fetchImpl: net() as never, adapters: map },
    );
    expect(((await r.json()) as { available: boolean }).available).toBe(false);
    expect(a.call).not.toHaveBeenCalled();
  });
});

describe('POST /api/staff/translate', () => {
  it('translates and cleans the answer; the text is fenced as data', async () => {
    const { a, map } = adapter('Translation: "ไม่ใส่ผักชี"');
    const r = await staffTranslateResponse(
      req(
        '/api/staff/translate',
        { store_id: STORE, text: 'No coriander please', to: 'th' },
        'tok-translate-0123456',
      ),
      env,
      { fetchImpl: net() as never, adapters: map },
    );
    expect(await r.json()).toEqual({ available: true, text: 'ไม่ใส่ผักชี' });
    const sent = (a.call as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      prompt: string;
      system: string;
    };
    expect(sent.prompt).toContain('Target language: Thai');
    expect(sent.prompt).toContain('No coriander please');
    expect(sent.system).toMatch(/Reply with the translation ONLY/);
  });
  it('refuses a person the database does not allow, an unknown language and a long text', async () => {
    const { map } = adapter('x');
    const no = await staffTranslateResponse(
      req(
        '/api/staff/translate',
        { store_id: STORE, text: 'hi', to: 'en' },
        'tok-no-0123456789abcd',
      ),
      env,
      { fetchImpl: net({ translate_context: null }) as never, adapters: map },
    );
    expect(no.status).toBe(403);
    expect(
      (
        await staffTranslateResponse(
          req('/api/staff/translate', { store_id: STORE, text: 'hi', to: 'fr' }),
          env,
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await staffTranslateResponse(
          req('/api/staff/translate', { store_id: STORE, text: 'x'.repeat(601), to: 'en' }),
          env,
        )
      ).status,
    ).toBe(422);
  });
  it('limits how fast one person can translate', async () => {
    const { map } = adapter('ok');
    const codes: number[] = [];
    for (let i = 0; i < 32; i++)
      codes.push(
        (
          await staffTranslateResponse(
            req(
              '/api/staff/translate',
              { store_id: STORE, text: 'hi', to: 'en' },
              'tok-rate-limit-0123456',
            ),
            env,
            { fetchImpl: net() as never, adapters: map },
          )
        ).status,
      );
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    expect(codes[31]).toBe(429);
  });
  it('cleans wrapping quotes, fences and labels', () => {
    expect(cleanTranslation('"Hello"')).toBe('Hello');
    expect(cleanTranslation('```\nHello\n```')).toBe('Hello');
    expect(cleanTranslation('Translated text: Hola')).toBe('Hola');
    expect(cleanTranslation('  line one\nline two ')).toBe('line one\nline two');
  });
});

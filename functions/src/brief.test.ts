import { describe, expect, it, vi } from 'vitest';
import type { ProviderAdapter } from './ai-adapters.js';
import { briefSummaryResponse } from './brief-handler.js';

const env = {
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_ROLE_KEY: 'srv',
  GOOGLE_API_KEY: 'g',
};
const STORE = '22222222-2222-4222-8222-222222222222';
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
const ctx = {
  org_id: 'o1',
  store_id: STORE,
  insights: [
    {
      id: 'i1',
      kind: 'low_stock',
      severity: 'act',
      status: 'new',
      evidence: {
        items: [
          {
            name: { th: 'นม', en: 'Milk' },
            unit: 'ml',
            quantity: 850,
            days_left: 2.8,
            suggested: 1850,
          },
        ],
      },
    },
    {
      id: 'i2',
      kind: 'sales_drop',
      severity: 'watch',
      status: 'new',
      evidence: { yesterday: 100000, usual: 500000, weeks: 4 },
    },
    {
      id: 'i3',
      kind: 'waste_high',
      severity: 'watch',
      status: 'dismissed',
      evidence: { waste: 99999, sales: 1 },
    },
  ],
};
const req = (token: string | null = 'user-token-abcdefghijkl') =>
  new Request('https://x.test/api/brief/summary', {
    method: 'POST',
    body: JSON.stringify({ store_id: STORE }),
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
const net = (c: unknown = ctx, status = 200) =>
  vi.fn(async (input: unknown) => {
    const fn = /\/rpc\/(\w+)/.exec(String(input))?.[1] ?? '';
    if (fn === 'brief_context') return json(c, status);
    return json(null);
  });
const adapter = (text: string) => {
  const a: ProviderAdapter = {
    id: 'google',
    call: vi.fn(async (_r, model) => ({
      text,
      provider: 'google' as const,
      model,
      usage: { inputTokens: 50, outputTokens: 20 },
    })),
  };
  return {
    a,
    map: { google: a, anthropic: { ...a, id: 'anthropic' } } as Record<
      'anthropic' | 'google',
      ProviderAdapter
    >,
  };
};

describe('POST /api/brief/summary', () => {
  it('explains only the open findings and flags any number it cannot find among them', async () => {
    const { a, map } = adapter(
      'Milk is low: 850 ml, 2.8 days. Yesterday sold 1,000 baht against 5,000. Waste is 777 baht.',
    );
    const res = await briefSummaryResponse(req(), env, {
      fetchImpl: net() as never,
      adapters: map,
    });
    const b = (await res.json()) as { available: boolean; unverified: string[]; facts: string };
    expect(b.available).toBe(true);
    expect(b.unverified).toEqual(['777']);
    expect(b.facts).toContain('Milk has 850 ml left');
    expect(b.facts).not.toContain('Waste');
    const prompt = ((a.call as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { prompt: string })
      .prompt;
    expect(prompt).toContain('THB 1000');
  });
  it('is forbidden when the database says no, and refuses a call without a token or with a bad id', async () => {
    expect(
      (await briefSummaryResponse(req(), env, { fetchImpl: net(null, 403) as never })).status,
    ).toBe(403);
    expect((await briefSummaryResponse(req(null), env)).status).toBe(403);
    const bad = new Request('https://x.test/api/brief/summary', {
      method: 'POST',
      body: JSON.stringify({ store_id: 'x' }),
      headers: { authorization: 'Bearer t' },
    });
    expect((await briefSummaryResponse(bad, env)).status).toBe(422);
  });
  it('says there is nothing to explain, and works without a key', async () => {
    const none = await briefSummaryResponse(req(), env, {
      fetchImpl: net({ ...ctx, insights: [] }) as never,
    });
    expect(await none.json()).toEqual({
      available: true,
      summary: null,
      unverified: [],
      facts: '',
    });
    const nokey = await briefSummaryResponse(
      req(),
      { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'srv' },
      { fetchImpl: net() as never },
    );
    const j = (await nokey.json()) as { available: boolean; facts: string };
    expect(j.available).toBe(false);
    expect(j.facts).toContain('Sales drop');
  });
});

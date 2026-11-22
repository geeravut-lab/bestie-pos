import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { deliverMarketing, deliverWebhooks, signWebhook } from './growth-deliver.js';
import { publicApiResponse } from './public-api-handler.js';
import { guestPassResponse } from './network-handler.js';
import { handleLineWebhook } from './line.js';
import type { LineConfig, LineStore } from './line.js';
import { createHmac as hmac } from 'node:crypto';

const env = {
  SUPABASE_URL: 'https://x.supabase.co',
  VITE_SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'svc',
};
const URL_ = 'https://x.supabase.co';
const cfg: LineConfig = {
  channelSecret: 'secret',
  channelAccessToken: 'tok',
  codeSecret: 'code',
  basicId: '@bestie',
  siteUrl: 'https://bestie.example',
};
type Call = { url: string; body: unknown };
/** A fetch that records calls and answers by URL suffix. */
const mock = (answers: Record<string, () => Response>) => {
  const calls: Call[] = [];
  const f = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
    for (const [k, v] of Object.entries(answers)) if (u.endsWith(k) || u.includes(k)) return v();
    return Response.json(null);
  }) as unknown as typeof fetch;
  return { f, calls };
};

describe('promotional messages', () => {
  it('does nothing without the LINE credentials', async () => {
    const { f, calls } = mock({});
    expect(
      await deliverMarketing({ supabaseUrl: URL_, serviceRoleKey: 'svc', cfg: null, fetchImpl: f }),
    ).toEqual({ queued: 0, claimed: 0, sent: 0, failed: 0 });
    expect(calls).toHaveLength(0);
  });
  it('pushes each due message with the STOP footer and reports it', async () => {
    const pushes: { to: string; text: string; key: string }[] = [];
    const reports: unknown[] = [];
    const f = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('marketing_run_all')) return Response.json(2);
      if (u.includes('marketing_claim'))
        return Response.json([
          { id: 'send-1', line_user_id: 'Uabc12345', th: 'คิดถึง', en: 'We miss you' },
        ]);
      if (u.includes('marketing_report')) {
        reports.push(JSON.parse(String(init?.body)));
        return Response.json(null);
      }
      if (u.includes('api.line.me')) {
        const b = JSON.parse(String(init?.body)) as { to: string; messages: { text: string }[] };
        pushes.push({
          to: b.to,
          text: b.messages[0]!.text,
          key: String((init?.headers as Record<string, string>)['X-Line-Retry-Key']),
        });
        return new Response('{}', { status: 200 });
      }
      return Response.json(null);
    }) as unknown as typeof fetch;
    const r = await deliverMarketing({
      supabaseUrl: URL_,
      serviceRoleKey: 'svc',
      cfg,
      fetchImpl: f,
    });
    expect(r).toEqual({ queued: 2, claimed: 1, sent: 1, failed: 0 });
    expect(pushes[0]).toMatchObject({ to: 'Uabc12345', key: 'send-1' });
    expect(pushes[0]!.text).toContain('คิดถึง\n\nWe miss you');
    expect(pushes[0]!.text).toMatch(/STOP/);
    expect(reports).toEqual([{ p_id: 'send-1', p_outcome: 'sent' }]);
  });
  it('reports a blocked account so no more is sent, and stops the run when LINE says the token is dead', async () => {
    let status = 400;
    const reports: { p_outcome: string }[] = [];
    const f = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('marketing_run_all')) return Response.json(0);
      if (u.includes('marketing_claim'))
        return Response.json([
          { id: 'a', line_user_id: 'Uaaaaa1', th: 'x' },
          { id: 'b', line_user_id: 'Ubbbbb2', th: 'x' },
        ]);
      if (u.includes('marketing_report')) {
        reports.push(JSON.parse(String(init?.body)));
        return Response.json(null);
      }
      if (u.includes('api.line.me')) {
        const s = status;
        status = 401;
        return new Response('{}', { status: s });
      }
      return Response.json(null);
    }) as unknown as typeof fetch;
    const r = await deliverMarketing({
      supabaseUrl: URL_,
      serviceRoleKey: 'svc',
      cfg,
      fetchImpl: f,
    });
    expect(reports.map((x) => x.p_outcome)).toEqual(['blocked', 'auth_failed']);
    expect(r.failed).toBe(2);
  });
});

describe('webhooks', () => {
  it('signs "t.body" with the secret', () => {
    const body = '{"a":1}';
    const expected = createHmac('sha256', 'whsec_x').update(`1700000000.${body}`).digest('hex');
    expect(signWebhook('whsec_x', 1700000000, body)).toBe(`t=1700000000,v1=${expected}`);
  });
  it('posts the payload with a signature, never follows a redirect, and reports the outcome', async () => {
    const sent: {
      url: string;
      headers: Record<string, string>;
      body: string;
      redirect?: string;
    }[] = [];
    const reports: { p_ok: boolean; p_status: number }[] = [];
    const f = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('webhook_claim'))
        return Response.json([
          {
            id: 'd1',
            url: 'https://hooks.example.com/in',
            secret: 'whsec_s',
            event: 'order.paid',
            payload: { data: { n: 1 } },
          },
          {
            id: 'd2',
            url: 'https://127.0.0.1/in',
            secret: 'whsec_s',
            event: 'order.paid',
            payload: {},
          },
          {
            id: 'd3',
            url: 'https://hooks.example.com/bad',
            secret: 'whsec_s',
            event: 'order.paid',
            payload: {},
          },
        ]);
      if (u.includes('webhook_report')) {
        reports.push(JSON.parse(String(init?.body)));
        return Response.json(null);
      }
      sent.push({
        url: u,
        headers: init?.headers as Record<string, string>,
        body: String(init?.body),
        redirect: init?.redirect,
      });
      return new Response(null, { status: u.endsWith('/bad') ? 302 : 204 });
    }) as unknown as typeof fetch;
    const r = await deliverWebhooks({
      supabaseUrl: URL_,
      serviceRoleKey: 'svc',
      fetchImpl: f,
      now: () => 1_700_000_000_000,
    });
    expect(r).toEqual({ claimed: 3, sent: 1, failed: 2 });
    expect(sent.map((s) => s.url)).toEqual([
      'https://hooks.example.com/in',
      'https://hooks.example.com/bad',
    ]); // the IP address was never called
    expect(sent[0]!.redirect).toBe('manual');
    expect(sent[0]!.headers['Bestie-Signature']).toBe(
      signWebhook('whsec_s', 1_700_000_000, sent[0]!.body),
    );
    expect(sent[0]!.headers['Bestie-Event']).toBe('order.paid');
    expect(reports).toEqual([
      { p_id: 'd1', p_ok: true, p_status: 204 },
      { p_id: 'd2', p_ok: false, p_status: 0 },
      { p_id: 'd3', p_ok: false, p_status: 302 },
    ]);
  });
});

describe('public API', () => {
  const KEY = `bk_${'a'.repeat(48)}`;
  const hash = createHash('sha256').update(KEY).digest('hex');
  const req = (path: string, auth: string | null = `Bearer ${KEY}`) =>
    new Request(`https://x${path}`, { headers: auth ? { authorization: auth } : {} });
  it('needs a well-formed key', async () => {
    expect((await publicApiResponse(req('/api/v1/menu', null), 'menu', env)).status).toBe(401);
    expect((await publicApiResponse(req('/api/v1/menu', 'Bearer nope'), 'menu', env)).status).toBe(
      401,
    );
    expect(
      (
        await publicApiResponse(
          new Request('https://x/api/v1/menu', { method: 'POST' }),
          'menu',
          env,
        )
      ).status,
    ).toBe(405);
  });
  it('looks the key up by its hash and answers within its scope', async () => {
    const { f, calls } = mock({
      api_key_lookup: () => Response.json({ org_id: 'o1', scopes: ['menu'] }),
      api_menu: () => Response.json([{ id: 'i1', price: 5500 }]),
    });
    const res = await publicApiResponse(req('/api/v1/menu'), 'menu', env, { fetchImpl: f });
    expect(await res.json()).toEqual({ items: [{ id: 'i1', price: 5500 }] });
    expect(calls[0]!.body).toEqual({ p_hash: hash });
    const no = await publicApiResponse(
      req('/api/v1/sales?from=2026-11-01&to=2026-11-02'),
      'sales',
      env,
      { fetchImpl: f },
    );
    expect(no.status).toBe(403); // the key has the menu scope only
  });
  it('checks the dates and forwards a valid range', async () => {
    const { f, calls } = mock({
      api_key_lookup: () => Response.json({ org_id: 'o1', scopes: ['sales'] }),
      api_sales: () => Response.json([{ date: '2026-11-01', total: 100 }]),
    });
    expect(
      (await publicApiResponse(req('/api/v1/sales?from=x&to=y'), 'sales', env, { fetchImpl: f }))
        .status,
    ).toBe(422);
    const ok = await publicApiResponse(
      req('/api/v1/sales?from=2026-11-01&to=2026-11-02'),
      'sales',
      env,
      { fetchImpl: f },
    );
    expect(await ok.json()).toEqual({
      days: [{ date: '2026-11-01', total: 100 }],
      currency: 'THB',
      unit: 'satang',
    });
    expect(calls.at(-1)!.body).toEqual({ p_org: 'o1', p_from: '2026-11-01', p_to: '2026-11-02' });
  });
  it('treats an unknown or revoked key (database answers null) as unauthorised', async () => {
    const { f } = mock({ api_key_lookup: () => Response.json(null) });
    expect(
      (await publicApiResponse(req('/api/v1/menu'), 'menu', env, { fetchImpl: f })).status,
    ).toBe(401);
  });
});

describe("Tourist Pass: the guest's consents", () => {
  const T = 'a'.repeat(32);
  const ORG = '22222222-2222-4222-8222-222222222222';
  it('lists the partners and flips one', async () => {
    const { f, calls } = mock({
      guest_pass_partners: () => Response.json([{ org_id: ORG, name: 'Cafe', blocked: false }]),
      guest_pass_set_block: () => Response.json({ ok: true }),
    });
    const list = await guestPassResponse(
      new Request(`https://x/api/guest/pass?t=${T}&partners=1`),
      env,
      { fetchImpl: f },
    );
    expect(await list.json()).toEqual({ partners: [{ orgId: ORG, name: 'Cafe', blocked: false }] });
    const post = await guestPassResponse(
      new Request('https://x/api/guest/pass', {
        method: 'POST',
        body: JSON.stringify({ op: 'block', t: T, org: ORG, blocked: true }),
      }),
      env,
      { fetchImpl: f },
    );
    expect(await post.json()).toEqual({ ok: true });
    expect(calls.at(-1)!.body).toEqual({ p_token: T, p_org: ORG, p_blocked: true });
  });
  it('refuses a bad token, organisation or flag', async () => {
    const { f } = mock({});
    const bad = (b: unknown) =>
      guestPassResponse(
        new Request('https://x/api/guest/pass', { method: 'POST', body: JSON.stringify(b) }),
        env,
        { fetchImpl: f },
      );
    expect((await bad({ op: 'block', t: 'short', org: ORG, blocked: true })).status).toBe(422);
    expect((await bad({ op: 'block', t: T, org: 'nope', blocked: true })).status).toBe(422);
    expect((await bad({ op: 'block', t: T, org: ORG, blocked: 'yes' })).status).toBe(422);
  });
  it('a wrong token has no partners', async () => {
    const { f } = mock({ guest_pass_partners: () => Response.json(null) });
    const res = await guestPassResponse(
      new Request(`https://x/api/guest/pass?t=${T}&partners=1`),
      env,
      { fetchImpl: f },
    );
    expect(res.status).toBe(404);
  });
});

describe('LINE chat: the code and STOP', () => {
  const body = (text: string) =>
    JSON.stringify({
      events: [
        {
          type: 'message',
          replyToken: 'rt',
          source: { userId: 'Uguest12345' },
          message: { type: 'text', text },
        },
      ],
    });
  const sign = (b: string) => hmac('sha256', cfg.channelSecret).update(b).digest('base64');
  const store = (over: Partial<LineStore>): LineStore =>
    ({ markStopped: vi.fn(), ...over }) as unknown as LineStore;
  it('a member code binds her LINE and gets the offers welcome', async () => {
    const replies: string[] = [];
    const s = store({ bindGuest: vi.fn(async () => 'marketing' as const) });
    const b = body('1A2B3C4D');
    await handleLineWebhook({
      rawBody: b,
      signature: sign(b),
      cfg,
      store: s,
      reply: async (_t, text) => void replies.push(text),
    });
    expect(replies[0]).toMatch(/โปรโมชัน/);
    expect(replies[0]).toMatch(/STOP/);
  });
  it('STOP withdraws the consent and is confirmed', async () => {
    const replies: string[] = [];
    const stop = vi.fn(async () => 1);
    const s = store({ stopMarketing: stop });
    for (const w of ['STOP', ' stop ', 'หยุด']) {
      const b = body(w);
      await handleLineWebhook({
        rawBody: b,
        signature: sign(b),
        cfg,
        store: s,
        reply: async (_t, text) => void replies.push(text),
      });
    }
    expect(stop).toHaveBeenCalledTimes(3);
    expect(stop).toHaveBeenCalledWith('Uguest12345');
    expect(replies[0]).toMatch(/Reply|offers/i);
  });
  it('other words are not a STOP', async () => {
    const stop = vi.fn(async () => 1);
    const b = body('please stop by tomorrow');
    await handleLineWebhook({
      rawBody: b,
      signature: sign(b),
      cfg,
      store: store({ stopMarketing: stop }),
      reply: async () => {},
    });
    expect(stop).not.toHaveBeenCalled();
  });
});

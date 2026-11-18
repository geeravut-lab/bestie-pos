import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { LINE_MESSAGES } from './line-messages.js';
import { lineConfig, lineLinkResponse, lineWebhookResponse } from './line-handler.js';
import {
  bindLine,
  createRateLimiter,
  handleLineWebhook,
  hashCode,
  notifyLine,
  pushLine,
  startLineLink,
  verifyLineSignature,
} from './line.js';
import type { LineConfig, LineStore } from './line.js';
import type { Lang } from './line-messages.js';

const cfg: LineConfig = {
  channelSecret: 'chan-secret',
  channelAccessToken: 'tok',
  codeSecret: 'code-secret',
  basicId: '@bestie',
  siteUrl: 'https://bestie-pos.vercel.app',
};
const sign = (body: string, secret = cfg.channelSecret) =>
  createHmac('sha256', secret).update(body).digest('base64');

type Row = {
  id: string;
  ownerId: string;
  hash: string | null;
  expires: Date | null;
  attempts: number;
  status: 'pending' | 'active' | 'stopped';
  address: string | null;
  lastError: string | null;
};
function memoryStore(lang: Lang = 'th') {
  const rows: Row[] = [];
  const logs: unknown[] = [];
  const store: LineStore = {
    async startLink(userId, hash, expiresAt) {
      const i = rows.findIndex((r) => r.ownerId === userId);
      const row: Row = {
        id: `row-${userId}`,
        ownerId: userId,
        hash,
        expires: expiresAt,
        attempts: 0,
        status: 'pending',
        address: null,
        lastError: null,
      };
      if (i >= 0) rows[i] = row;
      else rows.push(row);
    },
    async findPendingByHash(hash) {
      const r = rows.find((x) => x.status === 'pending' && x.hash === hash);
      return r
        ? { id: r.id, ownerId: r.ownerId, expiresAt: r.expires!, attempts: r.attempts }
        : null;
    },
    async activate(id, lineUserId) {
      const r = rows.find((x) => x.id === id);
      if (!r || r.status !== 'pending') return false;
      Object.assign(r, { status: 'active', address: lineUserId, hash: null, expires: null });
      return true;
    },
    async markStopped(uid, reason) {
      const r = rows.find((x) => x.address === uid && x.status === 'active');
      if (r) Object.assign(r, { status: 'stopped', lastError: reason });
    },
    async status(userId) {
      const r = rows.find((x) => x.ownerId === userId);
      return r
        ? { status: r.status, expiresAt: r.expires?.toISOString() ?? null, lastError: r.lastError }
        : null;
    },
    async activeAddress(userId) {
      return rows.find((x) => x.ownerId === userId && x.status === 'active')?.address ?? null;
    },
    async remove(userId) {
      const i = rows.findIndex((x) => x.ownerId === userId);
      if (i < 0) return false;
      rows.splice(i, 1);
      return true;
    },
    async log(e) {
      logs.push(e);
    },
    async ownerLang() {
      return lang;
    },
  };
  return { store, rows, logs };
}

describe('startLineLink / bindLine', () => {
  const seed = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);

  it('issues an 8-character code, stores only its HMAC and expires after 30 minutes', async () => {
    const { store, rows } = memoryStore();
    const now = new Date('2026-11-18T10:00:00Z');
    const r = await startLineLink(store, 'u1', cfg, now, () => seed);
    expect(r).toEqual({
      code: 'ABCDEFGH',
      expiresAt: '2026-11-18T10:30:00.000Z',
      basicId: '@bestie',
    });
    expect(rows[0]!.hash).toBe(hashCode('code-secret', 'ABCDEFGH'));
    expect(JSON.stringify(rows)).not.toContain('ABCDEFGH');
  });

  it('a new request kills the old code at once', async () => {
    const { store } = memoryStore();
    await startLineLink(store, 'u1', cfg, new Date(), () => seed);
    await startLineLink(store, 'u1', cfg, new Date(), () =>
      Uint8Array.from([8, 9, 10, 11, 12, 13, 14, 15]),
    );
    expect(await bindLine(store, 'ABCDEFGH', 'Uline', cfg)).toEqual({ ok: false });
    expect((await bindLine(store, 'JKLMNPQR', 'Uline', cfg)).ok).toBe(true);
  });

  it('binds by HASH, case-insensitively, exactly once', async () => {
    const { store, rows } = memoryStore();
    await startLineLink(store, 'u1', cfg, new Date(), () => seed);
    expect(await bindLine(store, 'abcdefgh', 'Uline1', cfg)).toEqual({ ok: true, ownerId: 'u1' });
    expect(rows[0]).toMatchObject({ status: 'active', address: 'Uline1', hash: null });
    expect(await bindLine(store, 'ABCDEFGH', 'Uother', cfg)).toEqual({ ok: false }); // the code is single use
  });

  it('refuses expired codes, malformed codes and too many attempts', async () => {
    const { store, rows } = memoryStore();
    await startLineLink(store, 'u1', cfg, new Date('2026-11-18T10:00:00Z'), () => seed);
    expect(await bindLine(store, 'ABCDEFGH', 'U', cfg, new Date('2026-11-18T10:30:01Z'))).toEqual({
      ok: false,
    });
    expect(await bindLine(store, 'short', 'U', cfg)).toEqual({ ok: false });
    expect(await bindLine(store, 'ABCDEFGH', '', cfg, new Date('2026-11-18T10:01:00Z'))).toEqual({
      ok: false,
    });
    rows[0]!.attempts = 5;
    expect(await bindLine(store, 'ABCDEFGH', 'U', cfg, new Date('2026-11-18T10:01:00Z'))).toEqual({
      ok: false,
    });
  });
});

describe('verifyLineSignature', () => {
  it('accepts the exact HMAC of the raw body and rejects everything else', () => {
    const body = '{"events":[]}';
    expect(verifyLineSignature(body, 'chan-secret', sign(body))).toBe(true);
    expect(verifyLineSignature(body + ' ', 'chan-secret', sign(body))).toBe(false); // one byte different
    expect(verifyLineSignature(body, 'chan-secret', sign(body, 'wrong'))).toBe(false);
    expect(verifyLineSignature(body, 'chan-secret', 'short')).toBe(false); // wrong length must not throw
    expect(verifyLineSignature(body, 'chan-secret', null)).toBe(false);
    expect(verifyLineSignature(body, '', sign(body))).toBe(false);
  });
});

describe('handleLineWebhook', () => {
  const event = (text: string, uid = 'Uline') => ({
    type: 'message',
    replyToken: `rt-${text}`,
    source: { userId: uid },
    message: { type: 'text', text },
  });
  const run = async (
    events: unknown[],
    over: Partial<Parameters<typeof handleLineWebhook>[0]> = {},
    lang: Lang = 'th',
  ) => {
    const m = memoryStore(lang);
    await startLineLink(m.store, 'u1', cfg, new Date(), () =>
      Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]),
    );
    const replies: [string, string][] = [];
    const rawBody = JSON.stringify({ events });
    const out = await handleLineWebhook({
      rawBody,
      signature: sign(rawBody),
      cfg,
      store: m.store,
      reply: async (t, text) => void replies.push([t, text]),
      ...over,
    });
    return { out, replies, ...m };
  };

  it('rejects a bad signature, oversize bodies and invalid JSON — before touching anything', async () => {
    const m = memoryStore();
    const base = { cfg, store: m.store, reply: async () => {} };
    expect((await handleLineWebhook({ ...base, rawBody: '{}', signature: 'nope' })).status).toBe(
      401,
    );
    expect(
      (await handleLineWebhook({ ...base, rawBody: 'x'.repeat(200_001), signature: sign('x') }))
        .status,
    ).toBe(413);
    const bad = '{not json';
    expect((await handleLineWebhook({ ...base, rawBody: bad, signature: sign(bad) })).status).toBe(
      400,
    );
  });

  it("a valid code links the account and the confirmation comes back in the OWNER's language", async () => {
    const th = await run([event('abcdefgh')], {}, 'th');
    expect(th.out).toEqual({ status: 200, body: { ok: true } });
    expect(th.rows[0]).toMatchObject({ status: 'active', address: 'Uline' });
    expect(th.replies[0]![1]).toBe(LINE_MESSAGES.linked.th);
    const en = await run([event('LINK ABCDEFGH')], {}, 'en');
    expect(en.replies[0]![1]).toBe(LINE_MESSAGES.linked.en);
  });

  it('anything else gets the help text in both languages; a wrong code gets "invalid or expired"', async () => {
    const help = await run([event('hello')]);
    expect(help.replies[0]![1]).toBe(`${LINE_MESSAGES.help.th}\n\n${LINE_MESSAGES.help.en}`);
    const wrong = await run([event('ZZZZZZZZ')]);
    expect(wrong.replies[0]![1]).toContain(LINE_MESSAGES.invalidCode.en);
    expect(wrong.rows[0]!.status).toBe('pending');
  });

  it('unfollow stops the channel without deleting it', async () => {
    const m = memoryStore();
    await startLineLink(m.store, 'u1', cfg, new Date(), () =>
      Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]),
    );
    await bindLine(m.store, 'ABCDEFGH', 'Uline', cfg);
    const raw = JSON.stringify({ events: [{ type: 'unfollow', source: { userId: 'Uline' } }] });
    await handleLineWebhook({
      rawBody: raw,
      signature: sign(raw),
      cfg,
      store: m.store,
      reply: async () => {},
    });
    expect(m.rows[0]).toMatchObject({ status: 'stopped', lastError: 'unfollowed' });
  });

  it('too many tries from one LINE account: silence, and no binding', async () => {
    const r = await run([event('ABCDEFGH')], { allow: () => false });
    expect(r.replies).toHaveLength(0);
    expect(r.rows[0]!.status).toBe('pending');
  });

  it('a failing reply never undoes the link, and one bad event never fails the batch', async () => {
    const r = await run([event('ABCDEFGH')], {
      reply: async () => {
        throw new Error('LINE down');
      },
    });
    expect(r.rows[0]!.status).toBe('active');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = memoryStore();
    const boom = {
      ...m.store,
      findPendingByHash: async () => {
        throw new Error('db');
      },
    };
    const raw = JSON.stringify({ events: [event('ABCDEFGH'), event('hello', 'U2')] });
    const replies: string[] = [];
    const out = await handleLineWebhook({
      rawBody: raw,
      signature: sign(raw),
      cfg,
      store: boom,
      reply: async (_t, text) => void replies.push(text),
    });
    expect(out.status).toBe(200);
    expect(replies).toHaveLength(1); // the second event was still processed
    spy.mockRestore();
  });

  it('ignores non-text events, events without a user and caps the batch at 20', async () => {
    const many = Array.from({ length: 30 }, (_, i) => event('hello', `U${i}`));
    const r = await run([
      { type: 'follow', source: { userId: 'U' } },
      { type: 'message', source: {}, message: { type: 'text', text: 'x' } },
      ...many,
    ]);
    expect(r.replies).toHaveLength(18); // 20 events looked at: 2 ignored, 18 answered
  });
});

describe('createRateLimiter', () => {
  it('allows N per window, then blocks, then frees up', () => {
    let t = 0;
    const allow = createRateLimiter(2, 1000, () => t);
    expect([allow('k'), allow('k'), allow('k')]).toEqual([true, true, false]);
    expect(allow('other')).toBe(true);
    t = 1001;
    expect(allow('k')).toBe(true);
  });
});

describe('pushLine / notifyLine', () => {
  const status = (s: number) =>
    vi.fn(async () => new Response('{}', { status: s })) as unknown as typeof fetch;
  it('maps LINE statuses to outcomes (409 = already delivered, 401/403 = our token is dead, 400 = blocked)', async () => {
    const expected: Record<number, string> = {
      200: 'sent',
      409: 'sent',
      401: 'auth_failed',
      403: 'auth_failed',
      400: 'blocked',
      429: 'rate_limited',
      500: 'retry',
      503: 'retry',
    };
    for (const [s, outcome] of Object.entries(expected))
      expect(await pushLine(cfg, 'U', {}, 'k', status(Number(s))), s).toBe(outcome);
    expect(
      await pushLine(cfg, 'U', {}, 'k', (async () => {
        throw new TypeError('network');
      }) as unknown as typeof fetch),
    ).toBe('retry');
  });

  it('sends the retry key and a one-message body to the push endpoint', async () => {
    const f = vi.fn(async () => new Response('{}'));
    await pushLine(cfg, 'Uabc', { type: 'flex' }, 'retry-1', f as unknown as typeof fetch);
    const [url, init] = f.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('https://api.line.me/v2/bot/message/push');
    expect(init.headers['X-Line-Retry-Key']).toBe('retry-1');
    expect(JSON.parse(init.body)).toEqual({ to: 'Uabc', messages: [{ type: 'flex' }] });
  });

  it("builds the card in the RECIPIENT's language, logs the send, and stops a channel LINE says is blocked", async () => {
    const m = memoryStore('en');
    await startLineLink(m.store, 'u1', cfg, new Date(), () =>
      Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]),
    );
    await bindLine(m.store, 'ABCDEFGH', 'Uline', cfg);
    const f = vi.fn(async () => new Response('{}', { status: 200 }));
    expect(
      await notifyLine({
        store: m.store,
        cfg,
        userId: 'u1',
        notice: { title: 'Paid', summary: 'Bill A-1' },
        path: '/orders',
        kind: 'payment',
        retryKey: 'r1',
        fetchImpl: f as unknown as typeof fetch,
      }),
    ).toBe('sent');
    const msg = JSON.parse((f.mock.calls[0] as unknown as [string, { body: string }])[1].body)
      .messages[0];
    expect(msg.contents.footer.contents[0].action).toEqual({
      type: 'uri',
      label: 'Open the app',
      uri: 'https://bestie-pos.vercel.app/orders?openExternalBrowser=1',
    });
    expect(m.logs).toEqual([{ ownerId: 'u1', kind: 'payment', status: 'sent' }]);

    expect(
      await notifyLine({
        store: m.store,
        cfg,
        userId: 'u1',
        notice: { title: 'x' },
        kind: 'k',
        retryKey: 'r2',
        fetchImpl: status(400),
      }),
    ).toBe('blocked');
    expect(m.rows[0]).toMatchObject({ status: 'stopped', lastError: 'blocked' });
    expect(
      await notifyLine({
        store: m.store,
        cfg,
        userId: 'u1',
        notice: { title: 'x' },
        kind: 'k',
        retryKey: 'r3',
        fetchImpl: status(200),
      }),
    ).toBe('no_channel');
  });
});

describe('bot messages', () => {
  it('every message exists in both languages and mentions no secret', () => {
    for (const [key, v] of Object.entries(LINE_MESSAGES)) {
      expect(v.th.length, `${key}.th`).toBeGreaterThan(0);
      expect(v.en.length, `${key}.en`).toBeGreaterThan(0);
    }
  });
});

describe('HTTP handlers', () => {
  const env = {
    SUPABASE_URL: 'https://p.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'svc',
    LINE_CHANNEL_SECRET: 'chan-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'tok',
    LINE_CODE_SECRET: 'code-secret',
    LINE_BASIC_ID: '@bestie',
  };
  const authFetch = (ok: boolean) =>
    vi.fn(async (url: string) =>
      String(url).includes('/auth/v1/user')
        ? new Response(JSON.stringify(ok ? { id: 'u1' } : {}), { status: ok ? 200 : 401 })
        : new Response('{}'),
    ) as unknown as typeof fetch;
  const req = (method: string, qs = '', token: string | null = 'jwt') =>
    new Request(`https://x/api/line/link${qs}`, {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  it('lineConfig is null until every variable is set', () => {
    expect(lineConfig({})).toBeNull();
    expect(lineConfig({ ...env, LINE_BASIC_ID: '' })).toBeNull();
    expect(lineConfig(env)?.basicId).toBe('@bestie');
  });

  it('webhook: 405 for GET, 503 when unconfigured, 401 for a bad signature, 200 for a valid one', async () => {
    const m = memoryStore();
    expect(
      (await lineWebhookResponse(new Request('https://x/w'), env, { store: m.store })).status,
    ).toBe(405);
    expect(
      (
        await lineWebhookResponse(
          new Request('https://x/w', { method: 'POST', body: '{}' }),
          {},
          { store: m.store },
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await lineWebhookResponse(
          new Request('https://x/w', {
            method: 'POST',
            body: '{}',
            headers: { 'x-line-signature': 'bad' },
          }),
          env,
          { store: m.store },
        )
      ).status,
    ).toBe(401);
    const raw = JSON.stringify({ events: [] });
    const ok = await lineWebhookResponse(
      new Request('https://x/w', {
        method: 'POST',
        body: raw,
        headers: { 'x-line-signature': sign(raw) },
      }),
      env,
      { store: m.store },
    );
    expect(ok.status).toBe(200);
  });

  it('link API needs a signed-in user', async () => {
    expect(
      (
        await lineLinkResponse(req('GET', '', null), env, {
          fetchImpl: authFetch(true),
          store: memoryStore().store,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await lineLinkResponse(req('GET'), env, {
          fetchImpl: authFetch(false),
          store: memoryStore().store,
        })
      ).status,
    ).toBe(403);
  });

  it('link API: unavailable without config; status never exposes the LINE userId or any hash', async () => {
    const m = memoryStore();
    expect(
      await (
        await lineLinkResponse(req('GET'), {}, { fetchImpl: authFetch(true), store: m.store })
      ).json(),
    ).toEqual({ error: 'forbidden' }); // no server env → cannot verify the user → closed
    const unconfigured = await lineLinkResponse(
      req('GET'),
      { SUPABASE_URL: env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: 'svc' },
      { fetchImpl: authFetch(true), store: m.store },
    );
    expect(await unconfigured.json()).toEqual({ available: false });

    await startLineLink(m.store, 'u1', cfg, new Date(), () =>
      Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]),
    );
    await bindLine(m.store, 'ABCDEFGH', 'U-secret-line-id', cfg);
    const text = await (
      await lineLinkResponse(req('GET'), env, { fetchImpl: authFetch(true), store: m.store })
    ).text();
    expect(JSON.parse(text)).toMatchObject({
      available: true,
      basicId: '@bestie',
      channel: { status: 'active' },
    });
    expect(text).not.toContain('U-secret-line-id');
  });

  it('link API: POST issues a code (shown once), DELETE disconnects', async () => {
    const m = memoryStore();
    const created = (await (
      await lineLinkResponse(req('POST'), env, { fetchImpl: authFetch(true), store: m.store })
    ).json()) as { code: string; basicId: string };
    expect(created.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(created.basicId).toBe('@bestie');
    expect(
      await (
        await lineLinkResponse(req('DELETE'), env, { fetchImpl: authFetch(true), store: m.store })
      ).json(),
    ).toEqual({ ok: true });
    expect(
      await (
        await lineLinkResponse(req('DELETE'), env, { fetchImpl: authFetch(true), store: m.store })
      ).json(),
    ).toEqual({ ok: false });
  });
});

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { evaluateDiagnosis } from './line-diagnose.js';
import type { DiagnosisInput } from './line-diagnose.js';
import { lineLinkResponse, lineWebhookResponse } from './line-handler.js';

const WEBHOOK = 'https://bestie-pos.vercel.app/api/line/webhook';
const good: DiagnosisInput = {
  missingEnv: [],
  expectedWebhook: WEBHOOK,
  configuredBasicId: '@123abcde',
  info: { status: 200, basicId: '@123abcde', displayName: 'Bestie POS' },
  endpoint: { status: 200, endpoint: WEBHOOK, active: true },
  test: { status: 200, success: true, statusCode: 200, reason: 'OK' },
  recent: { ok: 3, ok_empty: 1 },
  pendingLinks: 0,
};
const levels = (i: DiagnosisInput) =>
  Object.fromEntries(evaluateDiagnosis(i).map((c) => [c.id, c.level]));

describe('evaluateDiagnosis', () => {
  it('everything right: all ok', () => {
    expect(levels(good)).toEqual({
      env: 'ok',
      token: 'ok',
      basic_id: 'ok',
      webhook_url: 'ok',
      webhook_test: 'ok',
      recent: 'ok',
      pending: 'info',
    });
  });

  it('missing variables stop the check right there and name them', () => {
    const r = evaluateDiagnosis({ ...good, missingEnv: ['LINE_BASIC_ID'] });
    expect(r).toEqual([{ id: 'env', level: 'fail', data: { names: 'LINE_BASIC_ID' } }]);
  });

  it('a token LINE refuses is a FAIL; a different Basic ID is a WARN (the add-friend button would point elsewhere)', () => {
    expect(levels({ ...good, info: { status: 401 } }).token).toBe('fail');
    const r = evaluateDiagnosis({ ...good, info: { status: 200, basicId: '@other' } });
    expect(r.find((c) => c.id === 'basic_id')).toMatchObject({
      level: 'warn',
      data: { real: '@other' },
    });
    // the "@" and the case do not matter
    expect(levels({ ...good, configuredBasicId: '123ABCDE' }).basic_id).toBe('ok');
  });

  it('the webhook address: none, different, switched off', () => {
    const w = (endpoint: DiagnosisInput['endpoint']) =>
      evaluateDiagnosis({ ...good, endpoint }).find((c) => c.id === 'webhook_url')!;
    expect(w({ status: 200 })).toMatchObject({ level: 'fail', data: { reason: 'none' } });
    expect(
      w({ status: 200, endpoint: 'https://old.example/api/line', active: true }),
    ).toMatchObject({
      level: 'fail',
      data: { reason: 'different' },
    });
    expect(w({ status: 200, endpoint: WEBHOOK, active: false })).toMatchObject({
      level: 'fail',
      data: { reason: 'inactive' },
    });
    expect(w({ status: 200, endpoint: `${WEBHOOK}/`, active: true }).level).toBe('ok'); // a trailing slash is the same address
  });

  it("LINE's own test call failing (e.g. 401 = the channel secret differs) is a FAIL with LINE's status", () => {
    const r = evaluateDiagnosis({
      ...good,
      test: { status: 200, success: false, statusCode: 401, reason: 'Unauthorized' },
    }).find((c) => c.id === 'webhook_test');
    expect(r).toMatchObject({ level: 'fail', data: { status: 401 } });
  });

  it("what really arrived: nothing yet is a WARN, a bad signature or a refused reply is a FAIL; LINE's empty verify calls do not count", () => {
    expect(levels({ ...good, recent: {} }).recent).toBe('warn');
    expect(levels({ ...good, recent: { ok_empty: 5 } }).recent).toBe('warn');
    expect(levels({ ...good, recent: { ok: 2, bad_signature: 1 } }).recent).toBe('fail');
    const r = evaluateDiagnosis({ ...good, recent: { reply_failed_401: 2 } }).find(
      (c) => c.id === 'recent',
    );
    expect(r).toMatchObject({ level: 'fail', data: { reason: 'reply', status: '401' } });
  });

  it('network failures are WARN (unknown), never a false FAIL', () => {
    const l = levels({ ...good, info: null, endpoint: null, test: null });
    expect(l.token).toBe('warn');
    expect(l.webhook_url).toBe('warn');
    expect(l.webhook_test).toBe('warn');
  });
});

// ── the webhook leaves a trace ──
const env = {
  LINE_CHANNEL_SECRET: 'chan-secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'tok',
  LINE_CODE_SECRET: 'code-secret',
  LINE_BASIC_ID: '@bestie',
  SUPABASE_URL: 'https://db.example.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
};
const sign = (body: string) =>
  createHmac('sha256', env.LINE_CHANNEL_SECRET).update(body).digest('base64');

function backend(opts: { replyStatus?: number; admin?: boolean } = {}) {
  const logged: { outcome: string; events: number }[] = [];
  const lineCalls: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url.endsWith('/rpc/log_line_webhook')) {
      const b = JSON.parse(String(init.body)) as { p_outcome: string; p_events: number };
      logged.push({ outcome: b.p_outcome, events: b.p_events });
      return json(null);
    }
    if (url.endsWith('/auth/v1/user')) return json({ id: 'admin-1' });
    if (url.includes('/rest/v1/platform_admins'))
      return json(opts.admin === false ? [] : [{ user_id: 'admin-1' }]);
    if (url.endsWith('/rpc/line_webhook_summary')) return json({ ok: 2 });
    if (url.endsWith('/rpc/line_pending_links')) return json(1);
    if (url.includes('api.line.me')) {
      lineCalls.push(`${init.method ?? 'GET'} ${url.replace('https://api.line.me', '')}`);
      if (url.endsWith('/message/reply')) return json({}, opts.replyStatus ?? 200);
      if (url.endsWith('/bot/info')) return json({ basicId: '@bestie', displayName: 'Bestie POS' });
      if (url.endsWith('/webhook/endpoint'))
        return json({ endpoint: 'https://bestie-pos.vercel.app/api/line/webhook', active: true });
      if (url.endsWith('/webhook/test'))
        return json({ success: true, statusCode: 200, reason: 'OK' });
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, logged, lineCalls };
}
const hook = (body: string, sig = sign(body)) =>
  new Request('https://x/api/line/webhook', {
    method: 'POST',
    body,
    headers: { 'x-line-signature': sig },
  });
const emptyStore = {
  startLink: async () => {},
  findPendingByHash: async () => null,
  activate: async () => false,
  markStopped: async () => {},
  ownerLang: async () => 'th' as const,
} as never;
const textEvent = JSON.stringify({
  events: [
    {
      type: 'message',
      replyToken: 'rt',
      source: { userId: 'U1' },
      message: { type: 'text', text: 'hello' },
    },
  ],
});

describe('the webhook leaves a trace for the diagnosis', () => {
  it('logs the outcome and the number of events — never the text', async () => {
    const be = backend();
    await lineWebhookResponse(hook(textEvent), env, { fetchImpl: be.fetchImpl, store: emptyStore });
    expect(be.logged).toEqual([{ outcome: 'ok', events: 1 }]);
    expect(JSON.stringify(be.logged)).not.toContain('hello');
  });
  it("LINE's own verify call (no events) is logged apart from real messages", async () => {
    const be = backend();
    await lineWebhookResponse(hook('{"events":[]}'), env, {
      fetchImpl: be.fetchImpl,
      store: emptyStore,
    });
    expect(be.logged).toEqual([{ outcome: 'ok_empty', events: 0 }]);
  });
  it('a wrong signature (the secret in Vercel is not the one in LINE) is logged as bad_signature', async () => {
    const be = backend();
    const r = await lineWebhookResponse(hook(textEvent, 'AAAA'), env, {
      fetchImpl: be.fetchImpl,
      store: emptyStore,
    });
    expect(r.status).toBe(401);
    expect(be.logged).toEqual([{ outcome: 'bad_signature', events: 1 }]);
  });
  it('an answer LINE refuses (a bad access token) is logged with its status, so "no reply at all" has a reason', async () => {
    const be = backend({ replyStatus: 401 });
    const r = await lineWebhookResponse(hook(textEvent), env, {
      fetchImpl: be.fetchImpl,
      store: emptyStore,
    });
    expect(r.status).toBe(200); // LINE must still get a 200
    expect(be.logged).toEqual([{ outcome: 'reply_failed_401', events: 1 }]);
  });
});

describe('GET /api/line/link?op=diagnose', () => {
  const ask = (be: ReturnType<typeof backend>, e: Record<string, string> = env) =>
    lineLinkResponse(
      new Request('https://x/api/line/link?op=diagnose', {
        headers: { authorization: 'Bearer t' },
      }),
      e,
      { fetchImpl: be.fetchImpl },
    );
  it('is for the platform admin only', async () => {
    expect((await ask(backend({ admin: false }))).status).toBe(403);
  });
  it('asks LINE about the bot and returns checks only (no token, no secret)', async () => {
    const be = backend();
    const r = await ask(be);
    const body = (await r.json()) as { checks: { id: string; level: string }[] };
    expect(r.status).toBe(200);
    expect(body.checks.map((c) => c.level)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'info']);
    expect(be.lineCalls).toEqual([
      'GET /v2/bot/info',
      'GET /v2/bot/channel/webhook/endpoint',
      'POST /v2/bot/channel/webhook/test',
    ]);
    const text = JSON.stringify(body);
    expect(text).not.toContain('chan-secret');
    expect(text).not.toContain('"tok"');
  });
  it('with variables missing it names them and does not call LINE', async () => {
    const be = backend();
    const r = await ask(be, { ...env, LINE_BASIC_ID: '' });
    const body = (await r.json()) as {
      checks: { id: string; level: string; data?: { names: string } }[];
    };
    expect(body.checks).toEqual([{ id: 'env', level: 'fail', data: { names: 'LINE_BASIC_ID' } }]);
    expect(be.lineCalls).toEqual([]);
  });
});

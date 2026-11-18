import { describe, expect, it, vi } from 'vitest';
import { deliverQueue } from './notify-deliver.js';
import type { NotifyStore, QueueItem } from './notify-deliver.js';
import { bangkokParts, notifyTickResponse } from './notify-handler.js';

const cfg = { channelAccessToken: 'tok', siteUrl: 'https://bestie-pos.vercel.app' };
const item = (id: string, over: Partial<QueueItem> = {}): QueueItem => ({
  id,
  user_id: 'u1',
  kind: 'payment.paid',
  title: 'Payment received ฿180.00',
  body: 'Paid by PromptPay\nBill: A001\nAmount: ฿180.00',
  href: '/receipt/abc',
  urgent: false,
  attempts: 1,
  address: 'Uline1',
  lang: 'en',
  ...over,
});
const fakeStore = (items: QueueItem[]) => {
  const reports: [string, string][] = [];
  const store: NotifyStore = {
    claim: async () => items,
    report: async (id, o) => void reports.push([id, o]),
  };
  return { store, reports };
};
const lineFetch = (statuses: number[]) => {
  const calls: { body: { to: string; messages: { altText: string }[] }; key: string }[] = [];
  const f = vi.fn(async (_url: unknown, init?: RequestInit) => {
    calls.push({
      body: JSON.parse(String(init?.body)),
      key: (init?.headers as Record<string, string>)['X-Line-Retry-Key']!,
    });
    return new Response('{}', { status: statuses[calls.length - 1] ?? 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
};

describe('deliverQueue', () => {
  it('pushes a Flex card to the linked LINE user, using the queue id as the retry key, and reports sent', async () => {
    const { store, reports } = fakeStore([item('11111111-1111-4111-8111-111111111111')]);
    const { f, calls } = lineFetch([200]);
    const r = await deliverQueue({ store, cfg, fetchImpl: f });
    expect(r).toMatchObject({ claimed: 1, sent: 1, failed: 0, halted: false });
    expect(calls[0]!.body.to).toBe('Uline1');
    expect(calls[0]!.key).toBe('11111111-1111-4111-8111-111111111111');
    expect(calls[0]!.body.messages[0]!.altText).toContain('Payment received');
    expect(reports).toEqual([['11111111-1111-4111-8111-111111111111', 'sent']]);
  });

  it('a person without a LINE address is skipped, not pushed', async () => {
    const { store, reports } = fakeStore([item('a', { address: null })]);
    const { f, calls } = lineFetch([]);
    const r = await deliverQueue({ store, cfg, fetchImpl: f });
    expect(calls).toHaveLength(0);
    expect(r.skipped).toBe(1);
    expect(reports).toEqual([['a', 'no_channel']]);
  });

  it('a rejected token stops the loop at once (the rest wait; the database halts the queue)', async () => {
    const { store, reports } = fakeStore([item('a'), item('b'), item('c')]);
    const { f, calls } = lineFetch([401]);
    const r = await deliverQueue({ store, cfg, fetchImpl: f });
    expect(calls).toHaveLength(1);
    expect(r.halted).toBe(true);
    expect(reports).toEqual([['a', 'auth_failed']]);
  });

  it('LINE rate limit stops the run; a block and a server error are reported and the run goes on', async () => {
    const { store, reports } = fakeStore([item('a'), item('b'), item('c'), item('d')]);
    const { f } = lineFetch([400, 500, 429, 200]);
    const r = await deliverQueue({ store, cfg, fetchImpl: f });
    expect(reports.map((x) => x[1])).toEqual(['blocked', 'retry', 'rate_limited']);
    expect(r).toMatchObject({ sent: 0, failed: 3 });
  });

  it('writes the notice in the recipient language (button label)', async () => {
    const { store } = fakeStore([item('a', { lang: 'th', title: 'รับเงินแล้ว ฿180.00' })]);
    let sent = '';
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      sent = String(init?.body);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await deliverQueue({ store, cfg, fetchImpl: f });
    expect(sent).toContain('เปิดแอป');
  });
});

describe('bangkokParts', () => {
  it('is UTC+7', () => {
    expect(bangkokParts(Date.UTC(2026, 10, 18, 14, 30))).toEqual({ date: '2026-11-18', hour: 21 });
    expect(bangkokParts(Date.UTC(2026, 10, 18, 17, 30))).toEqual({ date: '2026-11-19', hour: 0 });
  });
});

describe('POST /api/notify/tick', () => {
  const env = {
    CRON_SECRET: 'cron',
    SUPABASE_URL: 'https://x.supabase.co',
    VITE_SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'svc',
  };
  const call = (
    headers: Record<string, string>,
    over: Record<string, string | undefined> = {},
    now = Date.UTC(2026, 10, 18, 3, 30),
  ) => {
    const rpcs: string[] = [];
    const f = vi.fn(async (url: unknown) => {
      const u = String(url);
      rpcs.push(u.split('/rpc/')[1] ?? u);
      return new Response(
        u.endsWith('notify_daily_summary') ? '2' : u.endsWith('notify_claim') ? '[]' : 'null',
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    return notifyTickResponse(
      new Request('https://x/api/notify/tick', { method: 'POST', headers }),
      { ...env, ...over },
      { fetchImpl: f, now: () => now },
    ).then(async (r) => ({ r, rpcs, body: (await r.json()) as Record<string, unknown> }));
  };

  it('refuses without the cron secret', async () => {
    expect((await call({})).r.status).toBe(403);
    expect((await call({ authorization: 'Bearer nope' })).r.status).toBe(403);
    expect((await call({ authorization: 'Bearer cron' }, { CRON_SECRET: '' })).r.status).toBe(403);
  });

  it('without LINE credentials the tick still works (inbox only) and says so', async () => {
    const { r, body, rpcs } = await call({ authorization: 'Bearer cron' });
    expect(r.status).toBe(200);
    expect(body.line).toBe('not_configured');
    expect(rpcs).not.toContain('notify_claim');
  });

  it('delivers the queue when LINE is configured; the summary only after 21:00 Bangkok', async () => {
    const line = {
      LINE_CHANNEL_SECRET: 's',
      LINE_CHANNEL_ACCESS_TOKEN: 't',
      LINE_CODE_SECRET: 'c',
      LINE_BASIC_ID: '@b',
    };
    const morning = await call(
      { authorization: 'Bearer cron' },
      line,
      Date.UTC(2026, 10, 18, 3, 30),
    );
    expect(morning.rpcs).toContain('notify_claim');
    expect(morning.rpcs).not.toContain('notify_daily_summary');
    const night = await call(
      { authorization: 'Bearer cron' },
      line,
      Date.UTC(2026, 10, 18, 15, 10),
    );
    expect(night.rpcs).toContain('notify_daily_summary');
    expect(night.body.summaries).toBe(2);
  });
});

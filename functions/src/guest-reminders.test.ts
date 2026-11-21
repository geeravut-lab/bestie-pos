import { describe, expect, it, vi } from 'vitest';
import { sendEmail } from './email.js';
import { reminderText, sendGuestReminders } from './guest-reminders.js';
import type { DueReminder } from './guest-reminders.js';
import { handleLineWebhook, parseGuestCode } from './line.js';
import type { LineConfig, LineStore } from './line.js';
import { createHmac } from 'node:crypto';

const due = (over: Partial<DueReminder> = {}): DueReminder => ({
  id: '6a7f3c1e-0000-4000-8000-000000000001',
  starts_at: '2026-12-01T07:00:00Z',
  guest_name: 'Anna',
  service_name: { th: 'นวด', en: 'Massage' },
  shop_name: 'Lotus Spa',
  provider_name: 'Nok',
  guest_email: null,
  guest_line_user_id: null,
  ...over,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const cfg: LineConfig = {
  channelSecret: 'secret',
  channelAccessToken: 'token',
  codeSecret: 'code',
  basicId: '@bestie',
  siteUrl: 'https://example.test',
};

describe('reminderText', () => {
  it('is bilingual and names the shop, the service, the stylist and the Bangkok time', () => {
    const { subject, text } = reminderText(due());
    expect(text).toContain('Lotus Spa');
    expect(text).toContain('Massage');
    expect(text).toContain('นวด');
    expect(text).toContain('Nok');
    expect(text).toMatch(/14:00/); // 07:00Z = 14:00 in Bangkok
    expect(subject).toContain('Lotus Spa');
  });
});

describe('sendEmail', () => {
  it('does nothing without a key and sender', async () => {
    const f = vi.fn();
    expect(await sendEmail({ to: 'a@b.co', subject: 's', text: 't' }, {}, f)).toBe(
      'not_configured',
    );
    expect(f).not.toHaveBeenCalled();
  });
  it('sends through Resend and refuses a malformed address before any call', async () => {
    const f = vi.fn(async () => json({ id: 'x' }));
    const env = { RESEND_API_KEY: 're_test', EMAIL_FROM: 'Bestie <no-reply@example.test>' };
    expect(await sendEmail({ to: 'nope', subject: 's', text: 't' }, env, f as never)).toBe(
      'rejected',
    );
    expect(f).not.toHaveBeenCalled();
    expect(await sendEmail({ to: 'a@b.co', subject: 's', text: 't' }, env, f as never)).toBe(
      'sent',
    );
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test');
  });
  it('tells a refused address from a service that is down', async () => {
    const env = { RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.co' };
    expect(
      await sendEmail({ to: 'a@b.co', subject: 's', text: 't' }, env, (async () =>
        json({}, 422)) as never),
    ).toBe('rejected');
    expect(
      await sendEmail({ to: 'a@b.co', subject: 's', text: 't' }, env, (async () =>
        json({}, 503)) as never),
    ).toBe('failed');
  });
});

describe('sendGuestReminders', () => {
  const run = async (
    rows: DueReminder[],
    over: {
      line?: LineConfig | null;
      env?: Record<string, string>;
      push?: number;
      mail?: number;
    } = {},
  ) => {
    const calls: string[] = [];
    const f = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('guest_reminders_due')) return json(rows);
      if (u.includes('guest_reminder_done')) return json(null);
      if (u.includes('api.line.me')) return new Response('{}', { status: over.push ?? 200 });
      if (u.includes('api.resend.com')) return new Response('{}', { status: over.mail ?? 200 });
      return json(null, 404);
    });
    const out = await sendGuestReminders({
      supabaseUrl: 'https://db.test',
      serviceRoleKey: 'srv',
      env: over.env ?? {},
      line: over.line === undefined ? cfg : over.line,
      fetchImpl: f as never,
    });
    return { out, calls };
  };

  it('pushes by LINE and marks the reminder done', async () => {
    const { out, calls } = await run([due({ guest_line_user_id: 'Uabc123456' })]);
    expect(out).toEqual({ due: 1, sent: 1 });
    expect(calls.some((c) => c.includes('api.line.me/v2/bot/message/push'))).toBe(true);
    expect(calls.some((c) => c.includes('guest_reminder_done'))).toBe(true);
  });

  it('sends the e-mail when configured, and does not mark it done when nothing is configured (it will be retried)', async () => {
    const ok = await run([due({ guest_email: 'a@b.co' })], {
      env: { RESEND_API_KEY: 'k', EMAIL_FROM: 'x@y.co' },
    });
    expect(ok.out.sent).toBe(1);
    const none = await run([due({ guest_email: 'a@b.co' })]);
    expect(none.out.sent).toBe(0);
    expect(none.calls.some((c) => c.includes('guest_reminder_done'))).toBe(false);
  });

  it('LINE that is down is retried; a blocked recipient is given up (marked done, nothing sent)', async () => {
    const down = await run([due({ guest_line_user_id: 'Uabc123456' })], { push: 503 });
    expect(down.calls.some((c) => c.includes('guest_reminder_done'))).toBe(false);
    const blocked = await run([due({ guest_line_user_id: 'Uabc123456' })], { push: 400 });
    expect(blocked.out.sent).toBe(0);
    expect(blocked.calls.some((c) => c.includes('guest_reminder_done'))).toBe(true);
  });

  it('LINE not configured yet: wait, do not mark', async () => {
    const r = await run([due({ guest_line_user_id: 'Uabc123456' })], { line: null });
    expect(r.calls.some((c) => c.includes('guest_reminder_done'))).toBe(false);
  });
});

describe('guest code on the LINE webhook', () => {
  it('parses a booking code in any case, with or without a word in front', () => {
    expect(parseGuestCode('1a2b3c4d')).toBe('1A2B3C4D');
    expect(parseGuestCode('  remind 1A2B3C4D ')).toBe('1A2B3C4D');
    expect(parseGuestCode('hello')).toBeNull();
    expect(parseGuestCode('1A2B3C4')).toBeNull();
  });

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
  const sign = (raw: string) =>
    createHmac('sha256', cfg.channelSecret).update(raw).digest('base64');
  const store = (bind: boolean): LineStore =>
    ({
      bindGuest: vi.fn(async () => bind),
      findPendingByHash: vi.fn(async () => null),
      markStopped: vi.fn(),
    }) as unknown as LineStore;

  it('binds the booking and answers in both languages', async () => {
    const raw = body('1A2B3C4D');
    const reply = vi.fn(async () => {});
    const s = store(true);
    const res = await handleLineWebhook({
      rawBody: raw,
      signature: sign(raw),
      cfg,
      store: s,
      reply,
    });
    expect(res.status).toBe(200);
    expect(s.bindGuest).toHaveBeenCalledWith('1A2B3C4D', 'Uguest12345');
    expect(String((reply.mock.calls[0] as unknown[])[1])).toContain('reminder');
  });

  it('a code that is not a booking falls through to the normal "invalid code" answer', async () => {
    // ABCD2345 is valid in BOTH formats (a staff link code and a hex booking code): the guest path is tried first, then the staff one
    const raw = body('ABCD2345');
    const reply = vi.fn(async () => {});
    await handleLineWebhook({
      rawBody: raw,
      signature: sign(raw),
      cfg,
      store: store(false),
      reply,
    });
    expect(String((reply.mock.calls[0] as unknown[])[1])).toContain('not valid');
  });
});

import { describe, expect, it } from 'vitest';
import {
  CHECKS,
  STEPS,
  checkCancel,
  checkCash,
  checkMismatch,
  checkPreflight,
  checkPromptPay,
  checkShares,
  gapsIn,
  probeSql,
  summarize,
} from '../../tools/stripe-check/checks.mjs';

const levels = (rs: { level: string }[]) => rs.map((r) => r.level);
const att = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  order_id: 'o1',
  device_id: 'd1',
  tender: 'promptpay',
  status: 'succeeded',
  amount: 10000,
  provider_ref: 'pi_1',
  error: null,
  partial: false,
  created_at: '2026-11-19T10:00:00Z',
  order_number: 'A001',
  order_status: 'paid',
  ...over,
});
const rcpt = (number: string, order_id = 'o1', over: Record<string, unknown> = {}) => ({
  order_id,
  number,
  device_id: 'd1',
  payable: 10000,
  issued_at: '2026-11-19T10:01:00Z',
  ...over,
});
const pay = (over: Record<string, unknown> = {}) => ({
  order_id: 'o1',
  tender: 'promptpay',
  amount: 10000,
  reference: 'pi_1',
  status: 'confirmed',
  ...over,
});

describe('preflight', () => {
  const site = 'https://bestie-pos.vercel.app';
  const good = {
    secretKey: 'sk_test_abc',
    siteUrl: site,
    account: {
      country: 'TH',
      charges_enabled: true,
      capabilities: { promptpay_payments: 'active' },
    },
    webhooks: [
      {
        url: `${site}/api/stripe/webhook`,
        status: 'enabled',
        enabled_events: [
          'payment_intent.succeeded',
          'payment_intent.payment_failed',
          'payment_intent.canceled',
        ],
      },
    ],
    readers: [{ id: 'tmr_1' }],
    health: { ok: true },
  };
  it('refuses a live key before anything else', () => {
    const r = checkPreflight({ ...good, secretKey: 'sk_live_abc' });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ level: 'fail', id: 'key' });
    expect(checkPreflight({ ...good, secretKey: 'rk_live_x' })[0]!.level).toBe('fail');
    expect(checkPreflight({ ...good, secretKey: 'nonsense' })[0]!.level).toBe('fail');
  });
  it('all good → no failures', () => {
    expect(levels(checkPreflight(good))).not.toContain('fail');
    expect(levels(checkPreflight(good))).not.toContain('warn');
  });
  it('without a key it only notes it and still checks the site', () => {
    const r = checkPreflight({ siteUrl: site, health: { ok: true } });
    expect(r.map((x) => x.id)).toEqual(['key', 'health']);
    expect(r[0]!.level).toBe('info');
  });
  it('PromptPay not active, wrong country, closed account', () => {
    const r = checkPreflight({
      ...good,
      account: {
        country: 'US',
        charges_enabled: false,
        capabilities: { promptpay_payments: 'inactive' },
      },
    });
    expect(r.find((x) => x.id === 'promptpay')!.level).toBe('fail');
    expect(r.find((x) => x.id === 'country')!.level).toBe('warn');
    expect(r.find((x) => x.id === 'charges')!.level).toBe('fail');
  });
  it('webhook missing, disabled, or listening to too few events', () => {
    expect(checkPreflight({ ...good, webhooks: [] }).find((x) => x.id === 'webhook')!.level).toBe(
      'fail',
    );
    expect(
      checkPreflight({ ...good, webhooks: [{ ...good.webhooks[0]!, status: 'disabled' }] }).some(
        (x) => x.level === 'fail',
      ),
    ).toBe(true);
    const few = checkPreflight({
      ...good,
      webhooks: [{ ...good.webhooks[0]!, enabled_events: ['payment_intent.succeeded'] }],
    });
    expect(few.find((x) => x.id === 'webhook-events')!.text).toContain('payment_intent.canceled');
    // a wildcard endpoint is fine
    expect(
      checkPreflight({ ...good, webhooks: [{ ...good.webhooks[0]!, enabled_events: ['*'] }] }).some(
        (x) => x.level === 'fail',
      ),
    ).toBe(false);
  });
  it('a site that cannot be reached from here is a warning; a bad answer is a failure', () => {
    expect(
      checkPreflight({ ...good, health: { ok: false } }).find((x) => x.id === 'health')!.level,
    ).toBe('warn');
    expect(
      checkPreflight({ ...good, health: { ok: false, status: 500 } }).find(
        (x) => x.id === 'health',
      )!.level,
    ).toBe('fail');
  });
});

describe('the receipt series have no holes', () => {
  it('finds a gap per device', () => {
    expect(
      gapsIn([
        { device_id: 'd', number: 'A+000001' },
        { device_id: 'd', number: 'A+000002' },
      ]),
    ).toEqual([]);
    expect(
      gapsIn([
        { device_id: 'd', number: 'A+000001' },
        { device_id: 'd', number: 'A+000004' },
      ]),
    ).toEqual([{ device: 'd', from: 1, to: 4 }]);
    expect(
      gapsIn([
        { device_id: 'x', number: 'A+000007' },
        { device_id: 'y', number: 'B+000001' },
      ]),
    ).toEqual([]);
  });
});

describe('step 1 · PromptPay paid', () => {
  const good = {
    attempts: [att()],
    receipts: [rcpt('A+000001')],
    payments: [pay()],
    events: [{ type: 'payment_intent.succeeded' }],
  };
  it('passes when the bill closed by itself with the online series and matching money', () => {
    expect(levels(checkPromptPay(good))).toEqual(['ok', 'ok']);
  });
  it('nothing yet is a warning, not a failure', () => {
    expect(levels(checkPromptPay({}))).toEqual(['warn']);
  });
  it('fails when the bill stayed open, the series is wrong, the money differs or the webhook never came', () => {
    expect(checkPromptPay({ ...good, attempts: [att({ order_status: 'open' })] })[0]!.level).toBe(
      'fail',
    );
    expect(checkPromptPay({ ...good, receipts: [rcpt('A-000001')] })[0]!.level).toBe('fail');
    expect(checkPromptPay({ ...good, payments: [pay({ amount: 9000 })] })[0]!.level).toBe('fail');
    expect(checkPromptPay({ ...good, payments: [pay({ reference: 'pi_other' })] })[0]!.level).toBe(
      'fail',
    );
    expect(checkPromptPay({ ...good, receipts: [] })[0]!.level).toBe('fail');
    expect(checkPromptPay({ ...good, events: [] }).at(-1)!.level).toBe('fail');
  });
  it('a share of a split bill is not judged here', () => {
    expect(levels(checkPromptPay({ attempts: [att({ partial: true })] }))).toEqual(['warn']);
  });
});

describe('step 2 · cancel', () => {
  const base = {
    attempts: [
      att({
        id: 'c',
        status: 'canceled',
        order_status: 'open',
        created_at: '2026-11-19T09:00:00Z',
      }),
      att({ id: 'n', created_at: '2026-11-19T09:05:00Z' }),
    ],
    receipts: [rcpt('A+000001'), rcpt('A+000002', 'o2')],
  };
  it('a cancelled QR followed by a new one, numbers in a row', () => {
    expect(levels(checkCancel(base))).toEqual(['ok', 'ok']);
  });
  it('a hole in the online series fails', () => {
    const r = checkCancel({ ...base, receipts: [rcpt('A+000001'), rcpt('A+000003', 'o2')] });
    expect(r.at(-1)).toMatchObject({ level: 'fail', id: 'gaps' });
  });
  it('a cancelled QR with no later attempt is only a warning', () => {
    expect(checkCancel({ attempts: [base.attempts[0]!], receipts: [] })[0]!.level).toBe('warn');
  });
  it('no cancelled QR yet → warn', () => {
    expect(levels(checkCancel({ attempts: [att()] }))).toEqual(['warn']);
  });
});

describe('step 3 · cash after cancel', () => {
  const cancelled = [att({ status: 'canceled', order_status: 'paid' })];
  it('uses the offline A- series', () => {
    expect(
      checkCash({
        attempts: cancelled,
        receipts: [rcpt('A-000005')],
        payments: [pay({ tender: 'cash', reference: null })],
      })[0]!.level,
    ).toBe('ok');
  });
  it('the online series for a cash sale is wrong', () => {
    expect(
      checkCash({
        attempts: cancelled,
        receipts: [rcpt('A+000005')],
        payments: [pay({ tender: 'cash' })],
      })[0]!.level,
    ).toBe('fail');
  });
  it('nothing yet → warn', () => {
    expect(levels(checkCash({ attempts: cancelled, receipts: [], payments: [] }))).toEqual([
      'warn',
    ]);
  });
});

describe('step 4 · mismatch', () => {
  const rev = att({ status: 'needs_review', order_status: 'open', error: 'amount changed' });
  const audit = [{ entity_id: 'a1', action: 'payment.tender', detail: { review: true } }];
  it('parked for review, bill open, audited, managers told', () => {
    const r = checkMismatch({ attempts: [rev], audit, notices: [{ kind: 'payment.review' }] });
    expect(levels(r)).toEqual(['ok', 'ok', 'ok']);
  });
  it('a closed bill or a missing audit line fails', () => {
    expect(
      checkMismatch({
        attempts: [{ ...rev, order_status: 'paid' }],
        audit,
        notices: [{ kind: 'payment.review' }],
      })[0]!.level,
    ).toBe('fail');
    expect(checkMismatch({ attempts: [rev], audit: [], notices: [] })[1]!.level).toBe('fail');
  });
  it('no notice is only a warning', () => {
    expect(checkMismatch({ attempts: [rev], audit, notices: [] }).at(-1)!.level).toBe('warn');
  });
});

describe('optional steps', () => {
  it('several shares: held then one receipt whose payments add up', () => {
    const attempts = [att({ partial: true })];
    expect(
      levels(
        checkShares({
          attempts,
          partials: [{ order_id: 'o1', status: 'held', amount: 5000 }],
          receipts: [],
          payments: [],
        }),
      ),
    ).toEqual(['info']);
    expect(
      levels(
        checkShares({
          attempts,
          partials: [
            { order_id: 'o1', status: 'applied', amount: 5000 },
            { order_id: 'o1', status: 'applied', amount: 5000 },
          ],
          receipts: [rcpt('A+000009')],
          payments: [pay({ amount: 5000 }), pay({ amount: 5000, reference: 'pi_2' })],
        }),
      ),
    ).toEqual(['ok']);
    expect(
      checkShares({
        attempts,
        partials: [{ order_id: 'o1', status: 'applied', amount: 5000 }],
        receipts: [rcpt('A+000009')],
        payments: [pay({ amount: 5000 })],
      })[0]!.level,
    ).toBe('fail');
  });
  it('every listed step has a checker and a Thai instruction', () => {
    for (const s of STEPS) {
      expect(typeof CHECKS[s.id]).toBe('function');
      expect(s.wait.length).toBeGreaterThan(10);
      expect(CHECKS[s.id]!({})[0]!.level).toBe('warn'); // an empty database is "not done yet", never a crash
    }
  });
});

describe('the database question', () => {
  it('is a read-only select with a bounded window', () => {
    const q = probeSql(90);
    expect(q).toMatch(/^\s*with /);
    expect(q).not.toMatch(/\b(insert|update|delete|drop|alter|truncate)\b/i);
    expect(probeSql(999999)).toContain('mins => 1440');
    expect(probeSql(Number.NaN)).toContain('mins => 60');
  });
  it('summarises levels', () => {
    expect(
      summarize([
        { id: 'a', level: 'ok', text: '' },
        { id: 'b', level: 'fail', text: '' },
      ]),
    ).toMatchObject({ ok: 1, fail: 1 });
  });
});

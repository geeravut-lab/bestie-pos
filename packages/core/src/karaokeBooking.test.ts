import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KARAOKE_BOOKING,
  karaokeBookingLink,
  karaokeBookingSettingsPayload,
  karaokeBookingSettingsProblem,
  karaokeBookingTokenFromPath,
  karaokeDepositFor,
  karaokeDepositPaid,
  parseKaraokeBookResult,
  parseKaraokeBookStatus,
  parseKaraokeBookingInfo,
  parseKaraokeBookingSettings,
  parseKaraokeCancelResult,
  parseKaraokeDeposits,
} from './karaokeBooking';

const TOKEN = 'a'.repeat(32);

describe('karaoke online booking', () => {
  it('fills the settings with the same defaults as the database', () => {
    expect(parseKaraokeBookingSettings(null)).toEqual(DEFAULT_KARAOKE_BOOKING);
    expect(
      parseKaraokeBookingSettings({ deposit_pct: 50, open: '10:00', pay_note: ' PromptPay ' }),
    ).toMatchObject({
      depositPct: 50,
      open: '10:00',
      payNote: 'PromptPay',
    });
    expect(parseKaraokeBookingSettings({ open: '25:00' }).open).toBe('12:00');
  });

  it('checks the settings with the database limits', () => {
    const ok = DEFAULT_KARAOKE_BOOKING;
    expect(karaokeBookingSettingsProblem(ok)).toBeNull();
    expect(karaokeBookingSettingsProblem({ ...ok, open: '23:00', close: '12:00' })).toBe('hours');
    expect(karaokeBookingSettingsProblem({ ...ok, stepMin: 2 })).toBe('step');
    expect(karaokeBookingSettingsProblem({ ...ok, leadMin: -1 })).toBe('lead');
    expect(karaokeBookingSettingsProblem({ ...ok, maxDays: 400 })).toBe('days');
    expect(karaokeBookingSettingsProblem({ ...ok, depositPct: 101 })).toBe('deposit');
    expect(karaokeBookingSettingsProblem({ ...ok, holdMin: 5 })).toBe('hold');
    expect(karaokeBookingSettingsPayload(ok)).toMatchObject({ deposit_pct: 30, hold_min: 120 });
  });

  it('works out the deposit half up, never outside 0–100 percent', () => {
    expect(karaokeDepositFor(60000, 30)).toBe(18000);
    expect(karaokeDepositFor(33350, 30)).toBe(10005);
    expect(karaokeDepositFor(33351, 30)).toBe(10005);
    expect(karaokeDepositFor(1, 50)).toBe(1);
    expect(karaokeDepositFor(60000, 0)).toBe(0);
    expect(karaokeDepositFor(60000, 150)).toBe(60000);
    expect(karaokeDepositFor(60000, -5)).toBe(0);
  });

  it('reads the link', () => {
    expect(karaokeBookingTokenFromPath(`/kb/${TOKEN}`)).toBe(TOKEN);
    expect(karaokeBookingTokenFromPath(`/kb/${TOKEN}/`)).toBe(TOKEN);
    expect(karaokeBookingTokenFromPath('/kb/xyz')).toBeNull();
    expect(karaokeBookingTokenFromPath(`/book/${TOKEN}`)).toBeNull();
    expect(karaokeBookingLink('https://x.test/', TOKEN)).toBe(`https://x.test/kb/${TOKEN}`);
  });

  it('reads the page info and drops what is not valid', () => {
    expect(parseKaraokeBookingInfo(null)).toBeNull();
    expect(parseKaraokeBookingInfo({ store_name: 'Sing', open: false })).toEqual({
      open: false,
      storeName: 'Sing',
    });
    const info = parseKaraokeBookingInfo({
      store_name: 'Sing',
      open: true,
      settings: { deposit_pct: 40 },
      rooms: [
        { id: 'r1', name: 'VIP 1', rate_per_hour: 30000, lengths: [60, 90, 'x', 5] },
        { id: 'r2', name: 'No lengths', rate_per_hour: 100, lengths: [] },
        { name: 'No id', lengths: [60] },
      ],
    });
    expect(info).toMatchObject({ open: true, storeName: 'Sing', settings: { depositPct: 40 } });
    expect(info && info.open && info.rooms).toEqual([
      { id: 'r1', name: 'VIP 1', ratePerHour: 30000, lengths: [60, 90] },
    ]);
  });

  it('reads the answers', () => {
    expect(
      parseKaraokeBookResult({
        ok: true,
        id: 'b1',
        code: 'ABCD1234',
        starts_at: '2026-11-23T13:00:00Z',
        minutes: 120,
        room: 'VIP 1',
        price: 60000,
        deposit_due: 18000,
        hold_until: '2026-11-21T10:00:00Z',
      }),
    ).toMatchObject({ ok: true, code: 'ABCD1234', depositDue: 18000, minutes: 120 });
    expect(
      parseKaraokeBookResult({ ok: true, id: 'b1', code: null, starts_at: 'x' }),
    ).toMatchObject({ ok: true, code: null, depositDue: 0, holdUntil: null });
    expect(parseKaraokeBookResult({ ok: false, error: 'taken' })).toEqual({
      ok: false,
      error: 'taken',
    });
    expect(parseKaraokeBookResult({ ok: false, error: 'nonsense' })).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(parseKaraokeBookResult(null)).toEqual({ ok: false, error: 'invalid' });
    expect(
      parseKaraokeBookStatus({
        ok: true,
        status: 'booked',
        starts_at: 'x',
        minutes: 60,
        room: 'A',
        deposit_due: 100,
        deposit_paid: 100,
      }),
    ).toMatchObject({ ok: true, depositPaid: 100 });
    expect(parseKaraokeBookStatus({ ok: false, error: 'invalid' })).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(parseKaraokeCancelResult({ ok: true })).toEqual({ ok: true });
    expect(parseKaraokeCancelResult({ ok: false, error: 'closed' })).toEqual({
      ok: false,
      error: 'closed',
    });
  });

  it('adds up the deposits in hand for a booking', () => {
    const list = parseKaraokeDeposits([
      { id: 'd1', booking_id: 'b1', amount: 9000, method: 'cash', status: 'held' },
      { id: 'd2', booking_id: 'b1', amount: 9000, method: 'promptpay', status: 'on_bill' },
      { id: 'd3', booking_id: 'b1', amount: 5000, method: 'cash', status: 'refunded' },
      { id: 'd4', booking_id: 'b2', amount: 1000, method: 'cash', status: 'held' },
      { id: 'd5', booking_id: 'b1', amount: 1, method: 'bitcoin', status: 'held' },
    ]);
    expect(list).toHaveLength(4);
    expect(karaokeDepositPaid(list, 'b1')).toBe(18000);
    expect(karaokeDepositPaid(list, 'b9')).toBe(0);
  });
});

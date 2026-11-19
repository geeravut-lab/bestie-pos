import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BOOKING,
  bookingDays,
  bookingLink,
  bookingSettingsPayload,
  bookingSettingsProblem,
  bookingTokenFromPath,
  parseBookingInfo,
  parseBookingResult,
  parseBookingSettings,
  parseCancelResult,
  parseSlots,
} from './onlineBooking';

const TOKEN = 'a'.repeat(32);

describe('settings', () => {
  it('fills the defaults the database uses', () => {
    expect(parseBookingSettings({})).toEqual(DEFAULT_BOOKING);
    expect(parseBookingSettings(null)).toEqual(DEFAULT_BOOKING);
    expect(
      parseBookingSettings({
        open: '10:00',
        close: '18:30',
        step_min: 15,
        lead_min: '60',
        max_days: 14,
      }),
    ).toEqual({ open: '10:00', close: '18:30', stepMin: 15, leadMin: 60, maxDays: 14 });
    expect(parseBookingSettings({ open: '9am', step_min: 'x' })).toEqual(DEFAULT_BOOKING);
  });
  it('names what is wrong, with the database limits', () => {
    const ok = DEFAULT_BOOKING;
    expect(bookingSettingsProblem(ok)).toBeNull();
    expect(bookingSettingsProblem({ ...ok, open: '20:00', close: '09:00' })).toBe('hours');
    expect(bookingSettingsProblem({ ...ok, open: '10:00', close: '10:00' })).toBe('hours');
    expect(bookingSettingsProblem({ ...ok, stepMin: 4 })).toBe('step');
    expect(bookingSettingsProblem({ ...ok, stepMin: 121 })).toBe('step');
    expect(bookingSettingsProblem({ ...ok, leadMin: -1 })).toBe('lead');
    expect(bookingSettingsProblem({ ...ok, maxDays: 0 })).toBe('days');
    expect(bookingSettingsProblem({ ...ok, maxDays: 181 })).toBe('days');
  });
  it('sends the snake_case names', () => {
    expect(bookingSettingsPayload(DEFAULT_BOOKING)).toEqual({
      open: '09:00',
      close: '20:00',
      step_min: 30,
      lead_min: 120,
      max_days: 30,
    });
  });
});

describe('the link', () => {
  it('reads the token from /book/<token> only', () => {
    expect(bookingTokenFromPath(`/book/${TOKEN}`)).toBe(TOKEN);
    expect(bookingTokenFromPath(`/book/${TOKEN}/`)).toBe(TOKEN);
    expect(bookingTokenFromPath('/book/short')).toBeNull();
    expect(bookingTokenFromPath(`/t/${TOKEN}`)).toBeNull();
    expect(bookingTokenFromPath(`/book/${TOKEN.toUpperCase()}`)).toBeNull();
  });
  it('builds the address without a double slash', () => {
    expect(bookingLink('https://x.example/', TOKEN)).toBe(`https://x.example/book/${TOKEN}`);
  });
});

describe('what the phone reads', () => {
  it('keeps real services and stylists and drops broken ones', () => {
    const i = parseBookingInfo({
      open: true,
      store_name: 'Salon',
      settings: { open: '10:00' },
      services: [
        { id: 's1', name: { th: 'นวด', en: 'Massage' }, duration_min: 60, price: 100000 },
        { id: 's2', name: { th: 'ไม่มีเวลา' }, duration_min: 0, price: 1 },
        { id: 's3', name: { en: 'No thai' }, duration_min: 30 },
        'nope',
      ],
      providers: [{ id: 'p1', name: 'Nok' }, { id: 'p2' }],
    });
    expect(i).toMatchObject({ open: true, storeName: 'Salon' });
    if (!i || !i.open) throw new Error('open');
    expect(i.settings.open).toBe('10:00');
    expect(i.services).toEqual([
      { id: 's1', name: { th: 'นวด', en: 'Massage' }, durationMin: 60, price: 100000 },
    ]);
    expect(i.providers).toEqual([{ id: 'p1', name: 'Nok' }]);
  });
  it('a closed page and a missing shop', () => {
    expect(parseBookingInfo({ open: false, store_name: 'Salon' })).toEqual({
      open: false,
      storeName: 'Salon',
    });
    expect(parseBookingInfo(null)).toBeNull();
  });
  it('slots must look like HH:MM', () => {
    expect(parseSlots(['09:00', '9:00', 5, '19:30'])).toEqual(['09:00', '19:30']);
    expect(parseSlots('x')).toEqual([]);
  });
  it('reads a booking answer', () => {
    expect(
      parseBookingResult({
        ok: true,
        id: 'a1',
        code: 'ABCD1234',
        starts_at: '2030-01-01T10:00:00+07:00',
        provider: 'Nok',
      }),
    ).toEqual({
      ok: true,
      id: 'a1',
      code: 'ABCD1234',
      startsAt: '2030-01-01T10:00:00+07:00',
      provider: 'Nok',
    });
    expect(parseBookingResult({ ok: false, error: 'taken' })).toEqual({
      ok: false,
      error: 'taken',
    });
    expect(parseBookingResult({ ok: false, error: 'weird' })).toEqual({
      ok: false,
      error: 'failed',
    });
    expect(parseBookingResult(null)).toEqual({ ok: false, error: 'failed' });
  });
  it('reads a cancel answer', () => {
    expect(parseCancelResult({ ok: true })).toEqual({ ok: true });
    expect(parseCancelResult({ ok: false, error: 'closed' })).toEqual({
      ok: false,
      error: 'closed',
    });
    expect(parseCancelResult({ ok: false, error: 'x' })).toEqual({ ok: false, error: 'failed' });
    expect(parseCancelResult(undefined)).toEqual({ ok: false, error: 'failed' });
  });
  it('lists days in a row', () => {
    expect(bookingDays('2026-12-30', 4)).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);
    expect(bookingDays('nope', 3)).toEqual([]);
  });
});

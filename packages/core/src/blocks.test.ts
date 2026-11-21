import { describe, expect, it } from 'vitest';
import { blockRange, groupPayload } from './blocks';

describe('blockRange', () => {
  it('an all-day block runs from the start of the first day to the end of the last (Bangkok time)', () => {
    expect(blockRange({ fromDate: '2026-12-01', toDate: '2026-12-02', allDay: true })).toEqual({
      startsAt: '2026-11-30T17:00:00.000Z',
      endsAt: '2026-12-02T17:00:00.000Z',
    });
  });
  it('a break uses the typed hours', () => {
    expect(
      blockRange({
        fromDate: '2026-12-01',
        toDate: '2026-12-01',
        allDay: false,
        timeFrom: '12:00',
        timeTo: '13:30',
      }),
    ).toEqual({ startsAt: '2026-12-01T05:00:00.000Z', endsAt: '2026-12-01T06:30:00.000Z' });
  });
  it('refuses bad input: reversed, too long, missing hours', () => {
    expect(blockRange({ fromDate: '2026-12-02', toDate: '2026-12-01', allDay: true })).toBeNull();
    expect(blockRange({ fromDate: '2026-12-01', toDate: '2027-03-01', allDay: true })).toBeNull();
    expect(blockRange({ fromDate: '2026-12-01', toDate: '2026-12-01', allDay: false })).toBeNull();
    expect(
      blockRange({
        fromDate: '2026-12-01',
        toDate: '2026-12-01',
        allDay: false,
        timeFrom: '13:00',
        timeTo: '12:00',
      }),
    ).toBeNull();
    expect(blockRange({ fromDate: 'x', toDate: 'y', allDay: true })).toBeNull();
  });
});

describe('groupPayload', () => {
  const part = (s: string, p: string, g = '') => ({ serviceId: s, providerId: p, guestName: g });
  it('builds the book_group body and drops empty parts', () => {
    const body = groupPayload({
      storeId: 'st',
      date: '2026-12-01',
      time: '14:00',
      guestName: ' Lee ',
      guestPhone: '',
      parts: [part('s1', 'p1', 'A'), part('s1', 'p2'), part('', '')],
    });
    expect(body).toMatchObject({
      store_id: 'st',
      starts_at: '2026-12-01T14:00:00+07:00',
      guest_name: 'Lee',
      guest_phone: null,
    });
    expect((body?.parts as unknown[]).length).toBe(2);
  });
  it('needs 2 to 8 parts, a name, a date and a time', () => {
    const base = {
      storeId: 'st',
      date: '2026-12-01',
      time: '14:00',
      guestName: 'Lee',
      guestPhone: '',
    };
    expect(groupPayload({ ...base, parts: [part('s', 'p')] })).toBeNull();
    expect(
      groupPayload({ ...base, guestName: ' ', parts: [part('s', 'p'), part('s', 'q')] }),
    ).toBeNull();
    expect(
      groupPayload({ ...base, time: '25:00', parts: [part('s', 'p'), part('s', 'q')] }),
    ).toBeNull();
    expect(
      groupPayload({ ...base, parts: Array.from({ length: 9 }, () => part('s', 'p')) }),
    ).toBeNull();
  });
});

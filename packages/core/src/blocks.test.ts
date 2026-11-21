import { describe, expect, it } from 'vitest';
import {
  blockRange,
  blockSpan,
  groupPayload,
  isoWeekday,
  parseWeeklyOffs,
  weeklyOffPayload,
  weeklyOffsForDay,
} from './blocks';

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

describe('blockSpan', () => {
  const day = '2026-12-01T00:00:00+07:00'; // the Bangkok day starts at 17:00Z the day before
  it('places a lunch break inside the visible hours', () => {
    // visible 09:00–21:00 (540–1260), break 12:00–13:00 Bangkok
    expect(
      blockSpan(
        { startsAt: '2026-12-01T05:00:00Z', endsAt: '2026-12-01T06:00:00Z' },
        day,
        540,
        1260,
      ),
    ).toEqual({ topPct: 25, heightPct: (60 / 720) * 100 });
  });
  it('clips a block that starts before / ends after the visible hours, and ignores one outside', () => {
    const all = blockSpan(
      { startsAt: '2026-11-30T17:00:00Z', endsAt: '2026-12-01T17:00:00Z' },
      day,
      540,
      1260,
    );
    expect(all).toEqual({ topPct: 0, heightPct: 100 });
    expect(
      blockSpan(
        { startsAt: '2026-12-01T20:00:00Z', endsAt: '2026-12-01T21:00:00Z' },
        day,
        540,
        1260,
      ),
    ).toBeNull();
  });
});

describe('weekly days off', () => {
  it('knows the weekday of a Bangkok date', () => {
    expect(isoWeekday('2030-01-06')).toBe(7); // Sunday
    expect(isoWeekday('2030-01-07')).toBe(1); // Monday
    expect(isoWeekday('2030-02-30')).toBeNull();
    expect(isoWeekday('x')).toBeNull();
  });
  it('reads rows and drops broken ones; times lose their seconds', () => {
    const r = parseWeeklyOffs([
      {
        id: 'a',
        resource_id: 'r1',
        weekday: 1,
        from_time: '00:00:00',
        to_time: null,
        reason: 'rest',
      },
      { id: 'b', resource_id: 'r1', weekday: 3, from_time: '12:00:00', to_time: '13:00:00' },
      { id: 'c', resource_id: 'r1', weekday: 9, from_time: '12:00:00' },
      { nope: 1 },
    ]);
    expect(r.map((x) => x.id)).toEqual(['a', 'b']);
    expect(r[1]).toMatchObject({ from: '12:00', to: '13:00', reason: '' });
  });
  it('draws a weekly off on its day only, as a block', () => {
    const rows = parseWeeklyOffs([
      { id: 'a', resource_id: 'r1', weekday: 7, from_time: '00:00:00', to_time: null },
      {
        id: 'b',
        resource_id: 'r2',
        weekday: 7,
        from_time: '12:00:00',
        to_time: '13:00:00',
        reason: 'lunch',
      },
    ]);
    expect(weeklyOffsForDay('2030-01-07', rows)).toEqual([]);
    expect(weeklyOffsForDay('2030-01-06', rows)).toEqual([
      {
        resourceId: 'r1',
        startsAt: '2030-01-05T17:00:00.000Z',
        endsAt: '2030-01-06T17:00:00.000Z',
        reason: '',
      },
      {
        resourceId: 'r2',
        startsAt: '2030-01-06T05:00:00.000Z',
        endsAt: '2030-01-06T06:00:00.000Z',
        reason: 'lunch',
      },
    ]);
  });
  it('builds the payload and refuses what the database would refuse', () => {
    const base = { storeId: 's', resourceId: 'r', weekdays: [3, 1, 3], allDay: true };
    expect(weeklyOffPayload(base)).toEqual({
      store_id: 's',
      resource_id: 'r',
      weekdays: [1, 3],
      from_time: null,
      to_time: null,
      reason: null,
    });
    expect(weeklyOffPayload({ ...base, weekdays: [] })).toBeNull();
    expect(weeklyOffPayload({ ...base, weekdays: [8] })).toBeNull();
    expect(
      weeklyOffPayload({ ...base, allDay: false, timeFrom: '13:00', timeTo: '12:00' }),
    ).toBeNull();
    expect(
      weeklyOffPayload({
        ...base,
        allDay: false,
        timeFrom: '12:00',
        timeTo: '13:00',
        reason: ' lunch ',
      }),
    ).toMatchObject({
      from_time: '12:00',
      to_time: '13:00',
      reason: 'lunch',
    });
  });
});

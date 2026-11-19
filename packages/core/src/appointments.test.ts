import { describe, expect, it } from 'vitest';
import {
  addDays,
  bangkokDayBounds,
  bangkokParts,
  canMove,
  findConflict,
  layoutColumn,
  nextStatuses,
  overlaps,
  parseAppointments,
  parseResources,
  timeLabel,
  toBangkokIso,
} from './appointments';
import type { Appointment } from './appointments';

const ap = (
  id: string,
  start: string,
  end: string,
  over: Partial<Appointment> = {},
): Appointment => ({
  id,
  providerId: 'nok',
  placeId: null,
  serviceName: { th: 'ตัดผม' },
  price: 30000,
  guestName: 'Anna',
  guestPhone: null,
  startsAt: `2030-01-15T${start}:00+07:00`,
  endsAt: `2030-01-15T${end}:00+07:00`,
  status: 'booked',
  source: 'staff',
  note: null,
  ...over,
});

describe('status flow', () => {
  it('only moves forward, like the database', () => {
    expect(nextStatuses('booked')).toEqual(['confirmed', 'arrived', 'cancelled', 'no_show']);
    expect(nextStatuses('arrived')).toEqual(['in_service', 'cancelled']);
    expect(nextStatuses('in_service')).toEqual(['done']);
    for (const s of ['done', 'cancelled', 'no_show'] as const) expect(nextStatuses(s)).toEqual([]);
  });
  it('only a booked or confirmed appointment can be moved', () => {
    expect(canMove('booked') && canMove('confirmed')).toBe(true);
    expect(canMove('arrived') || canMove('done')).toBe(false);
  });
});

describe('overlaps and conflicts', () => {
  it('back to back is not an overlap', () => {
    expect(
      overlaps(
        '2030-01-15T10:00:00+07:00',
        '2030-01-15T11:00:00+07:00',
        '2030-01-15T11:00:00+07:00',
        '2030-01-15T12:00:00+07:00',
      ),
    ).toBe(false);
    expect(
      overlaps(
        '2030-01-15T10:00:00+07:00',
        '2030-01-15T11:01:00+07:00',
        '2030-01-15T11:00:00+07:00',
        '2030-01-15T12:00:00+07:00',
      ),
    ).toBe(true);
  });
  const existing = [
    ap('a', '10:00', '11:30', { placeId: 'room1' }),
    ap('b', '12:00', '13:00', { providerId: 'mai', placeId: 'bed2', status: 'cancelled' }),
  ];
  const cand = (over = {}) => ({
    providerId: 'nok',
    placeId: null,
    startsAt: '2030-01-15T11:00:00+07:00',
    endsAt: '2030-01-15T12:00:00+07:00',
    ...over,
  });
  it('finds the same provider, and the same room even with another provider', () => {
    expect(findConflict(existing, cand())?.id).toBe('a');
    expect(findConflict(existing, cand({ providerId: 'mai', placeId: 'room1' }))?.id).toBe('a');
    expect(findConflict(existing, cand({ providerId: 'mai' }))).toBeNull();
  });
  it('a cancelled appointment holds nothing, and an appointment does not clash with itself', () => {
    expect(
      findConflict(
        existing,
        cand({
          providerId: 'mai',
          placeId: 'bed2',
          startsAt: '2030-01-15T12:00:00+07:00',
          endsAt: '2030-01-15T12:30:00+07:00',
        }),
      ),
    ).toBeNull();
    expect(findConflict(existing, cand({ ignoreId: 'a' }))).toBeNull();
  });
});

describe('Bangkok time', () => {
  it('builds and reads Bangkok instants', () => {
    expect(toBangkokIso('2026-11-19', '14:30')).toBe('2026-11-19T14:30:00+07:00');
    expect(toBangkokIso('2026-02-30', '10:00')).toBeNull();
    expect(toBangkokIso('2026-11-19', '24:00')).toBeNull();
    expect(bangkokParts('2026-11-19T17:30:00Z')).toEqual({ date: '2026-11-20', minutes: 30 }); // 00:30 next day in Bangkok
    expect(timeLabel(14 * 60 + 5)).toBe('14:05');
  });
  it('a Bangkok day runs from midnight to the next midnight', () => {
    expect(bangkokDayBounds('2026-12-31')).toEqual({
      from: '2026-12-31T00:00:00+07:00',
      to: '2027-01-01T00:00:00+07:00',
    });
    expect(bangkokDayBounds('nope')).toBeNull();
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('day layout', () => {
  it('places appointments in percent of the visible window', () => {
    // window 09:00–21:00 (720 min); 10:00–11:30 = starts 60 min in, lasts 90 min
    const [p] = layoutColumn([ap('a', '10:00', '11:30')], '2030-01-15', 540, 1260);
    expect(p!.topPct).toBeCloseTo((60 / 720) * 100);
    expect(p!.heightPct).toBeCloseTo((90 / 720) * 100);
    expect(p).toMatchObject({ lane: 0, lanes: 1 });
  });
  it('clips what sticks out of the window and drops what is outside', () => {
    const r = layoutColumn(
      [ap('early', '08:00', '09:30'), ap('late', '20:30', '22:00'), ap('gone', '06:00', '07:00')],
      '2030-01-15',
      540,
      1260,
    );
    expect(r.map((x) => x.id)).toEqual(['early', 'late']);
    expect(r[0]!.topPct).toBe(0);
    expect(r[1]!.topPct + r[1]!.heightPct).toBeCloseTo(100);
  });
  it('overlapping appointments share the column side by side', () => {
    const r = layoutColumn(
      [ap('a', '10:00', '11:00'), ap('b', '10:30', '11:30'), ap('c', '11:00', '12:00')],
      '2030-01-15',
      540,
      1260,
    );
    expect(r.find((x) => x.id === 'a')).toMatchObject({ lane: 0, lanes: 2 });
    expect(r.find((x) => x.id === 'b')).toMatchObject({ lane: 1, lanes: 2 });
    expect(r.find((x) => x.id === 'c')).toMatchObject({ lane: 0, lanes: 2 }); // lane 0 is free again at 11:00
  });
});

describe('reading rows', () => {
  it('keeps good appointments only, sorted by start', () => {
    const r = parseAppointments([
      {
        id: 'b',
        starts_at: '2030-01-15T12:00:00Z',
        ends_at: '2030-01-15T13:00:00Z',
        service_name: { th: 'นวด', en: 'Massage' },
        status: 'booked',
        price: '80000',
        guest_name: 'Ben',
        provider_id: 'nok',
        source: 'online',
      },
      {
        id: 'a',
        starts_at: '2030-01-15T10:00:00Z',
        ends_at: '2030-01-15T11:00:00Z',
        service_name: { th: 'ตัดผม' },
        status: 'done',
        guest_name: 'Anna',
      },
      { id: 'x', starts_at: 'x', ends_at: 'y', service_name: { th: 'z' }, status: 'weird' },
      'nope',
    ]);
    expect(r.map((x) => x.id)).toEqual(['a', 'b']);
    expect(r[1]).toMatchObject({
      price: 80000,
      providerId: 'nok',
      source: 'online',
      serviceName: { th: 'นวด', en: 'Massage' },
    });
  });
  it('keeps real resources, ordered', () => {
    const r = parseResources([
      { id: 'r2', name: 'Room 2', kind: 'room', sort: 2 },
      { id: 'r1', name: 'Nok', kind: 'stylist', sort: 1, active: false },
      { id: 'r3', name: 'Alien', kind: 'spaceship' },
    ]);
    expect(r.map((x) => x.id)).toEqual(['r1', 'r2']);
    expect(r[0]!.active).toBe(false);
  });
});

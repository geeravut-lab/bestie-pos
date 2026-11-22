import { describe, expect, it } from 'vitest';
import { unverifiedNumbers } from './askShop';
import { buildOpsFigures, parseToursFigures } from './askOps';

const full = {
  kpi: {
    bills: 40,
    sales: 1000000,
    order_to_kitchen_sec: 150,
    prep_sec: 600,
    waste_cost: 80000,
    stockouts: 2,
    noshow_rate_bps: 1250,
    repeat_rate_bps: 3000,
    feedback_resolution_sec: 5400,
  },
  promotions: [{ promo_id: 'p1', name: 'Happy hour', bills: 6, lines: 9, given: 45000 }],
  stamps: {
    stamps_given: 14,
    rewards_used: 2,
    reward_value: 18000,
    passes_sold: 1,
    passes_active: 3,
  },
  turnover: [
    {
      table_id: 't1',
      name: 'T1',
      seats: 4,
      bills: 12,
      avg_min: 55,
      revenue: 360000,
      per_hour: 39000,
    },
  ],
  delivery: [
    {
      platform_id: 'd1',
      name: 'LINE MAN',
      code: 'lineman',
      commission_bps: 3000,
      bills: 3,
      gross: 90000,
      commission: 27000,
      net: 63000,
      paid_out: 0,
      owed: 63000,
    },
  ],
  tours: [
    { status: 'booked', source: 'online', seats: 2, deposit: 72000, deposit_due: 72000 },
    { status: 'booked', source: 'staff', seats: 3, deposit: 0, deposit_due: 0 },
    { status: 'cancelled', source: 'online', seats: 1, deposit: 0, deposit_due: 0 },
    { status: 'no_show', source: 'staff', seats: 1, deposit: 0, deposit_due: 0 },
  ],
};

describe('buildOpsFigures', () => {
  it('writes every module as plain facts and lists the numbers it holds', () => {
    const f = buildOpsFigures(full);
    expect(f.text).toContain('waste cost 800 THB');
    expect(f.text).toContain('no-show rate 12.5%');
    expect(f.text).toContain('Happy hour: 6 bills, 9 lines, 450 THB given');
    expect(f.text).toContain('14 stamps given');
    expect(f.text).toContain('T1 (4 seats): 12 bills, 55 minutes each, 3,600 THB');
    expect(f.text).toContain(
      'LINE MAN: 3 bills, sold 900 THB, platform kept 270 THB (30% commission)',
    );
    expect(f.text).toContain(
      'Tour bookings made in this period: 3 bookings with 6 seats (1 of them online)',
    );
    expect(f.text).toContain('1 cancelled, 1 no-shows; deposits due 720 THB, received 720 THB');
    // an answer that quotes these figures passes the checker; an invented number does not
    expect(
      unverifiedNumbers(
        'Happy hour gave away 450 THB and the waste was 800 THB (12.5% no-shows).',
        f.allowed,
      ),
    ).toEqual([]);
    expect(unverifiedNumbers('Happy hour gave away 4,500 THB.', f.allowed)).toEqual(['4,500']);
  });
  it('leaves a section out when its report could not be read (module off, no right)', () => {
    const f = buildOpsFigures({
      kpi: null,
      promotions: [],
      stamps: null,
      turnover: null,
      delivery: [],
      tours: [],
    });
    expect(f.text).toBe('Promotions: none used in this period.');
    expect(buildOpsFigures({}).text).toBe('');
  });
  it('tours: a cancelled booking does not count as a booking or its deposit', () => {
    expect(
      parseToursFigures([{ status: 'cancelled', seats: 4, deposit: 100, deposit_due: 100 }]),
    ).toMatchObject({
      bookings: 0,
      seats: 0,
      cancelled: 1,
      depositDue: 0,
    });
    expect(parseToursFigures(null).bookings).toBe(0);
  });
});

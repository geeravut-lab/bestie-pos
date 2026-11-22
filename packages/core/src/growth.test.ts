import { describe, expect, it } from 'vitest';
import {
  accountingCsv,
  isStopMessage,
  marketingText,
  parseAccountingRows,
  parseCampaigns,
  parsePassPartners,
  parseStampPrograms,
  parseStampStatus,
  parseTourBookings,
  parseTourSlots,
  parseWebhooks,
  satangDecimal,
  seatsLeft,
  stampsToNext,
  webhookUrlOk,
} from './growth';

describe('stamp cards', () => {
  it('reads programs and statuses and ignores damaged rows', () => {
    expect(
      parseStampPrograms([
        {
          id: 'a',
          kind: 'stamps',
          name: { th: 'บัตร' },
          reward_item_id: 'i',
          stamps_needed: 5,
          min_spend: 5000,
          active: true,
        },
        { id: 'b', kind: 'weird' },
        null,
      ]),
    ).toEqual([
      {
        id: 'a',
        kind: 'stamps',
        name: { th: 'บัตร' },
        rewardItemId: 'i',
        stampsNeeded: 5,
        minSpend: 5000,
        passPrice: null,
        passDays: null,
        active: true,
      },
    ]);
    const s = parseStampStatus([
      {
        program_id: 'a',
        kind: 'stamps',
        name: { th: 'x' },
        stamps: 7,
        stamps_needed: 5,
        rewards_ready: 1,
        pass_used_today: null,
      },
    ]);
    expect(s[0]).toMatchObject({ stamps: 7, rewardsReady: 1, passUsedToday: null });
  });
  it('says how many stamps are missing for the next reward', () => {
    expect(stampsToNext({ stamps: 0, stampsNeeded: 5 })).toBe(5);
    expect(stampsToNext({ stamps: 4, stampsNeeded: 5 })).toBe(1);
    expect(stampsToNext({ stamps: 5, stampsNeeded: 5 })).toBe(5);
    expect(stampsToNext({ stamps: 7, stampsNeeded: 5 })).toBe(3);
    expect(stampsToNext({ stamps: 3, stampsNeeded: null })).toBeNull();
  });
});

describe('tours', () => {
  it('reads slots and bookings', () => {
    const slots = parseTourSlots([
      {
        id: 's',
        title: { th: 'ดำน้ำ', en: 'Snorkel' },
        starts_at: '2026-11-25T02:00:00Z',
        duration_min: 240,
        capacity: 6,
        price: 150000,
        status: 'cancelled',
      },
      { id: 'x' },
    ]);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ status: 'cancelled', capacity: 6, guideStaffId: null });
    expect(
      parseTourBookings([
        { id: 'b', guest_name: 'Anna', seats: 4, status: 'checked_in', deposit: 200000 },
      ])[0],
    ).toMatchObject({
      seats: 4,
      status: 'checked_in',
    });
  });
  it('counts only live bookings against the capacity', () => {
    expect(
      seatsLeft(6, [
        { seats: 4, status: 'booked' },
        { seats: 2, status: 'cancelled' },
        { seats: 1, status: 'no_show' },
      ]),
    ).toBe(2);
    expect(seatsLeft(2, [{ seats: 3, status: 'checked_in' }])).toBe(0);
  });
});

describe('marketing', () => {
  it('always ends with the way to stop, in both languages', () => {
    const t = marketingText({ th: 'คิดถึง', en: 'We miss you' });
    expect(t).toContain('คิดถึง\n\nWe miss you');
    expect(t).toMatch(/STOP/);
    expect(marketingText({ th: 'คิดถึง' })).toMatch(/Reply STOP/);
  });
  it('knows the words that withdraw the consent', () => {
    for (const w of ['STOP', ' stop ', 'Unsubscribe', 'หยุด']) expect(isStopMessage(w)).toBe(true);
    for (const w of ['stop it please', 'hello', '1A2B3C4D', ''])
      expect(isStopMessage(w)).toBe(false);
  });
  it('reads campaigns and skips deleted ones', () => {
    const c = parseCampaigns([
      { id: 'a', name: 'Back', kind: 'rebook', idle_days: 45, message: { th: 'x' }, active: true },
      { id: 'b', name: 'Gone', kind: 'winback', deleted_at: '2026-01-01' },
    ]);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ kind: 'rebook', idleDays: 45, active: true });
  });
});

describe('integration hub', () => {
  it('accepts only real https addresses', () => {
    expect(webhookUrlOk('https://hooks.example.com/bestie')).toBe(true);
    for (const u of [
      'http://example.com/x',
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://192.168.1.5/x',
      'https://[::1]/x',
      'https://printer.local/x',
      'https://user:pw@example.com/x',
      'https://intranet/x',
      'not a url',
    ])
      expect(webhookUrlOk(u)).toBe(false);
  });
  it('reads webhook rows', () => {
    expect(
      parseWebhooks([
        {
          id: 'w',
          url: 'https://a.example.com',
          events: ['order.paid'],
          active: false,
          fail_count: 20,
          queued: 3,
          last_status: 502,
        },
      ])[0],
    ).toMatchObject({
      active: false,
      failCount: 20,
      lastStatus: 502,
    });
  });
  it('writes the accountant file as plain decimals with a header', () => {
    expect(satangDecimal(123456)).toBe('1234.56');
    expect(satangDecimal(-5)).toBe('-0.05');
    expect(satangDecimal(0)).toBe('0.00');
    const rows = parseAccountingRows([
      {
        date: '2026-11-20',
        receipt: 'A-000001',
        store: '=cmd',
        branch: '00000',
        seller_tax_id: '1234567890123',
        net_before_vat: 5607,
        service_charge: 0,
        vat: 393,
        total: 6000,
        rounding: 0,
        payable: 6000,
        cash: 6000,
      },
      { nothing: true },
    ]);
    expect(rows).toHaveLength(1);
    const csv = accountingCsv(rows);
    const lines = csv.replace('﻿', '').trim().split('\r\n');
    expect(lines[0]).toMatch(/^date,receipt,store,branch,seller_tax_id,net_before_vat/);
    expect(lines[1]).toContain(
      "A-000001,'=cmd,00000,1234567890123,56.07,0.00,3.93,60.00,0.00,60.00,60.00,0.00",
    );
  });
});

describe('network consents', () => {
  it('reads the partner list', () => {
    expect(
      parsePassPartners([{ org_id: 'o', name: 'Cafe', blocked: true }, { name: 'x' }]),
    ).toEqual([{ orgId: 'o', name: 'Cafe', blocked: true }]);
  });
});

import {
  discountAmount,
  hoursMinutes,
  parseReceiptSend,
  parseTimesheet,
  parseTurnover,
  parseWaitlist,
  receiptText,
  rowsToCsv,
  timesheetCsv,
  waitedMinutes,
} from './growth';

describe('waitlist and table turnover', () => {
  it('reads entries and counts the minutes waited', () => {
    const w = parseWaitlist([
      {
        id: 'a',
        name: 'Anna',
        party: 2,
        status: 'called',
        quoted_min: 25,
        created_at: '2026-11-22T10:00:00Z',
      },
      { name: 'x' },
    ]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ status: 'called', quotedMin: 25 });
    expect(waitedMinutes('2026-11-22T10:00:00Z', Date.parse('2026-11-22T10:17:30Z'))).toBe(17);
    expect(waitedMinutes('2026-11-22T10:00:00Z', Date.parse('2026-11-22T09:00:00Z'))).toBe(0);
  });
  it('reads the turnover rows', () => {
    expect(
      parseTurnover([
        {
          table_id: 't',
          name: 'T1',
          seats: 4,
          bills: 3,
          avg_min: 52,
          revenue: 90000,
          per_hour: 34615,
        },
      ])[0],
    ).toMatchObject({ avgMin: 52, perHour: 34615 });
  });
});

describe('time clock', () => {
  it('shows hours as h:mm and writes the timesheet CSV', () => {
    expect(hoursMinutes(485)).toBe('8:05');
    expect(hoursMinutes(0)).toBe('0:00');
    const rows = parseTimesheet([
      { staff_id: 's', name: 'Pim', worked_min: 485, days: 2, planned_min: 540 },
    ]);
    expect(timesheetCsv(rows).replace('﻿', '').trim().split('\r\n')).toEqual([
      'name,days_worked,hours_worked,hours_planned',
      'Pim,2,8:05,9:00',
    ]);
  });
});

describe('discount arithmetic', () => {
  it('matches the database: a percentage in basis points or an amount, never above the bill', () => {
    expect(discountAmount('percent', 1000, 10000)).toBe(1000);
    expect(discountAmount('percent', 333, 10000)).toBe(333);
    expect(discountAmount('percent', 99999, 10000)).toBe(10000);
    expect(discountAmount('amount', 500, 10000)).toBe(500);
    expect(discountAmount('amount', 50000, 10000)).toBe(10000);
    expect(discountAmount('amount', 0, 10000)).toBe(0);
    expect(discountAmount('percent', 1000, 0)).toBe(0);
  });
});

describe('e-receipt text', () => {
  const data = parseReceiptSend({
    receipt: {
      number: 'A+000012',
      issued_at: '2026-11-22T05:30:00Z',
      seller_name: 'Acme Co',
      seller_tax_id: '1234567890123',
      branch: '00000',
      pos_id: 'POS-1',
      vat_registered: true,
      subtotal: 10000,
      service_charge: 0,
      vat: 654,
      total: 10000,
      rounding: 0,
      payable: 10000,
    },
    lines: [{ name: { th: 'ผัดไทย', en: 'Pad Thai' }, qty: 2, unit_price: 5000 }],
    payments: [{ tender: 'cash', amount: 10000 }],
    member_line: true,
  })!;
  it('prints the frozen figures in the chosen language', () => {
    const en = receiptText(data, 'en');
    expect(en).toContain('Receipt no. A+000012');
    expect(en).toContain('Tax ID: 1234567890123 (branch 00000)');
    expect(en).toContain('2 x Pad Thai  100.00 THB');
    expect(en).toContain('VAT: 6.54 THB');
    expect(en).toContain('Cash: 100.00 THB');
    expect(en).toContain('Abbreviated tax invoice');
    const th = receiptText(data, 'th');
    expect(th).toContain('ผัดไทย');
    expect(th).toContain('ใบเสร็จเลขที่ A+000012');
  });
  it('leaves out the tax lines for a shop that is not VAT registered and rejects data without a receipt', () => {
    const plain = receiptText({ ...data, vatRegistered: false, sellerTaxId: null }, 'en');
    expect(plain).not.toMatch(/VAT|Tax ID|Abbreviated/);
    expect(parseReceiptSend({ lines: [] })).toBeNull();
    expect(data.memberLine).toBe(true);
  });
});

describe('data export', () => {
  it('writes the union of the keys as the header and guards formulas', () => {
    const csv = rowsToCsv([
      { name: 'Noi', phone: '081' },
      { name: '=1+1', extra: 'x' },
    ])
      .replace('﻿', '')
      .trim()
      .split('\r\n');
    expect(csv).toEqual(['name,phone,extra', 'Noi,081,', "'=1+1,,x"]);
    expect(rowsToCsv([]).replace('﻿', '').trim()).toBe('');
  });
});

import {
  parseTourBookResult,
  parseTourDeposits,
  parseTourLink,
  parseTourOnlineInfo,
  parseTourStatus,
  tourDepositFor,
  tourLink,
  tourTokenFromPath,
} from './growth';

describe('tours online', () => {
  const T = 'a'.repeat(32);
  it('finds the link token in a path and builds the link', () => {
    expect(tourTokenFromPath(`/tour/${T}`)).toBe(T);
    expect(tourTokenFromPath(`/tour/${T}/`)).toBe(T);
    expect(tourTokenFromPath('/tour/xyz')).toBeNull();
    expect(tourTokenFromPath(`/tours/${T}`)).toBeNull();
    expect(tourLink('https://x.app/', T)).toBe(`https://x.app/tour/${T}`);
  });
  it('rounds the deposit half up like the database', () => {
    expect(tourDepositFor(150000, 2, 40)).toBe(120000);
    expect(tourDepositFor(99900, 1, 30)).toBe(29970);
    expect(tourDepositFor(1001, 1, 50)).toBe(501);
    expect(tourDepositFor(1000, 3, 0)).toBe(0);
  });
  it('reads the page data, the answer to a booking, the status and the owner link', () => {
    const info = parseTourOnlineInfo({
      open: true,
      store_name: 'Dive',
      settings: { deposit_pct: 40, hold_min: 60, pay_note: 'PromptPay 081' },
      slots: [
        {
          id: 's',
          title: { th: 'ดำน้ำ', en: 'Snorkel' },
          starts_at: '2026-11-25T02:00:00Z',
          duration_min: 240,
          price: 150000,
          seats_left: 4,
          deposit_per_seat: 60000,
        },
        { x: 1 },
      ],
    });
    expect(info).toMatchObject({
      open: true,
      depositPct: 40,
      holdMin: 60,
      payNote: 'PromptPay 081',
    });
    expect(info!.slots).toHaveLength(1);
    expect(parseTourOnlineInfo({ nothing: true })).toBeNull();
    expect(
      parseTourBookResult({ ok: true, id: 'b', code: 'ABCD1234', deposit_due: 120000 }),
    ).toEqual({ ok: true, id: 'b', code: 'ABCD1234', depositDue: 120000, holdUntil: null });
    expect(parseTourBookResult({ ok: false, error: 'full' })).toEqual({ ok: false, error: 'full' });
    expect(parseTourBookResult({ ok: false, error: 'something odd' })).toEqual({
      ok: false,
      error: 'failed',
    });
    expect(parseTourBookResult(null)).toEqual({ ok: false, error: 'failed' });
    expect(
      parseTourStatus({
        status: 'booked',
        seats: 2,
        deposit_due: 100,
        deposit_received: 0,
        starts_at: 'x',
        title: { th: 'a' },
      }),
    ).toMatchObject({ status: 'booked', depositDue: 100 });
    expect(parseTourStatus(null)).toBeNull();
    expect(
      parseTourLink({ token: T, enabled: true, settings: { deposit_pct: 30, days_ahead: 60 } }),
    ).toMatchObject({ token: T, enabled: true, settings: { depositPct: 30, daysAhead: 60 } });
    expect(parseTourLink({ token: 'short' })).toBeNull();
    expect(
      parseTourDeposits([
        { id: 'd', booking_id: 'b', amount: 5000, method: 'cash', status: 'refunded' },
        { amount: 1 },
      ]),
    ).toEqual([{ id: 'd', bookingId: 'b', amount: 5000, method: 'cash', status: 'refunded' }]);
  });
});

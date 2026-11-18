import { describe, expect, it } from 'vitest';
import { parseSalesReport, presetRange, reportCsv } from './reports';

const raw = {
  range: { from: '2026-11-16', to: '2026-11-17' },
  totals: {
    bills: 4,
    subtotal: 53500,
    service_charge: 0,
    vat: 3501,
    rounding: 0,
    payable: 53500,
    average: 13375,
  },
  by_day: [{ date: '2026-11-16', bills: 2, payable: 39000 }],
  by_hour: [{ hour: 9, bills: 1, payable: 100 }],
  by_tender: [{ tender: 'cash', amount: '30000', bills: 2 }],
  by_item: [{ name_th: '=ผัดไทย', name_en: 'Pad Thai', quantity: 3, revenue: 27000 }],
  by_staff: [{ staff_id: null, name: 'Cashier, A', bills: 1, payable: 5 }],
  by_store: [{ store_id: 's1', name: 'Acme', bills: 4, payable: 53500 }],
};

describe('parseSalesReport', () => {
  it('maps the database answer', () => {
    const r = parseSalesReport(raw);
    expect(r.totals.payable).toBe(53500);
    expect(r.totals.serviceCharge).toBe(0);
    expect(r.byTender[0]!.amount).toBe(30000); // numeric strings are accepted
    expect(r.byStaff[0]!.staffId).toBeNull();
  });
  it('survives junk', () => {
    const r = parseSalesReport(null);
    expect(r.totals.bills).toBe(0);
    expect(r.byDay).toEqual([]);
    expect(parseSalesReport({ by_day: 'x', totals: { bills: 'NaN' } }).totals.bills).toBe(0);
  });
});

describe('presetRange', () => {
  // 2026-11-17 18:30 UTC is already 18 Nov 01:30 in Bangkok
  const now = Date.parse('2026-11-17T18:30:00Z');
  it('uses the Bangkok calendar', () => {
    expect(presetRange('today', now)).toEqual({ from: '2026-11-18', to: '2026-11-18' });
    expect(presetRange('yesterday', now)).toEqual({ from: '2026-11-17', to: '2026-11-17' });
    expect(presetRange('last7', now)).toEqual({ from: '2026-11-12', to: '2026-11-18' });
    expect(presetRange('last30', now)).toEqual({ from: '2026-10-20', to: '2026-11-18' });
    expect(presetRange('month', now)).toEqual({ from: '2026-11-01', to: '2026-11-18' });
  });
});

describe('reportCsv', () => {
  const r = parseSalesReport(raw);
  it('writes baht with two decimals and a header', () => {
    const csv = reportCsv(r, 'tenders');
    expect(csv).toContain('tender,bills,amount_thb');
    expect(csv).toContain('cash,2,300.00');
  });
  it('quotes commas and neutralises formulas', () => {
    expect(reportCsv(r, 'staff')).toContain('"Cashier, A"');
    expect(reportCsv(r, 'items')).toContain("'=ผัดไทย");
  });
  it('formats the hour column', () => {
    expect(reportCsv(r, 'hours')).toContain('09:00,1,1.00');
  });
});

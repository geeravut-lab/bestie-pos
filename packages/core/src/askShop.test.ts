import { describe, expect, it } from 'vitest';
import { buildFiguresPack, previousRange, unverifiedNumbers } from './askShop';
import { parseSalesReport } from './reports';

const report = (from: string, to: string, payable: number, bills: number) =>
  parseSalesReport({
    range: { from, to },
    totals: {
      bills,
      subtotal: payable,
      service_charge: 0,
      vat: 0,
      rounding: 0,
      payable,
      average: Math.round(payable / bills),
    },
    by_day: [{ date: to, bills, payable }],
    by_hour: [
      { hour: 12, bills: 5, payable: 150000 },
      { hour: 19, bills: 7, payable: 250000 },
    ],
    by_tender: [
      { tender: 'cash', amount: 300000, bills: 8 },
      { tender: 'promptpay', amount: 100000, bills: 4 },
    ],
    by_item: [{ name_th: 'ผัดไทย', name_en: 'Pad Thai', quantity: 40, revenue: 320000 }],
    by_staff: [{ staff_id: null, name: 'Nok', bills, payable }],
    by_store: [],
  });

describe('previousRange', () => {
  it('is the same number of days right before', () => {
    expect(previousRange({ from: '2026-11-13', to: '2026-11-19' })).toEqual({
      from: '2026-11-06',
      to: '2026-11-12',
    });
    expect(previousRange({ from: '2026-11-19', to: '2026-11-19' })).toEqual({
      from: '2026-11-18',
      to: '2026-11-18',
    });
    expect(previousRange({ from: '2026-03-01', to: '2026-03-31' }).to).toBe('2026-02-28');
  });
});

describe('the figures pack', () => {
  const pack = buildFiguresPack({
    shopName: 'Acme',
    current: report('2026-11-13', '2026-11-19', 1200000, 12),
    previous: report('2026-11-06', '2026-11-12', 1000000, 10),
  });
  it('holds the totals, the change and the lists in baht', () => {
    expect(pack.text).toContain('total 12,000 THB from 12 bills');
    expect(pack.text).toContain('Change vs previous period: sales +2,000 THB (+20.0%)');
    expect(pack.text).toContain('Pad Thai (ผัดไทย): 40 sold, 3,200 THB');
    expect(pack.text).toContain('cash: 3,000 THB (75.0%)');
    expect(pack.text).toContain('19:00-20:00: 2,500 THB');
  });
  it('accepts an answer built only from those figures', () => {
    const ok =
      'Sales were 12,000 THB from 12 bills, up 2,000 THB (20.0%, about 20%) on 10,000 THB before. Pad Thai sold 40 for 3,200 THB. Cash was 75.0%. Busiest 19:00.';
    expect(unverifiedNumbers(ok, pack.allowed)).toEqual([]);
  });
  it('flags an invented or mistaken number but not counting words', () => {
    const bad =
      'Sales were 13,500 THB, top 3 dishes, 35% more than before, with 1,234.50 THB of tips.';
    expect(unverifiedNumbers(bad, pack.allowed)).toEqual(['13,500', '35%', '1,234.50']);
  });
  it('no previous period is said plainly', () => {
    const p = buildFiguresPack({
      shopName: 'A',
      current: report('2026-11-19', '2026-11-19', 100000, 2),
      previous: null,
    });
    expect(p.text).toContain('Previous period: no data.');
    expect(p.text).not.toContain('Change vs previous');
  });

  it('names every shop when the report spans several', () => {
    const cur = report('2026-11-13', '2026-11-19', 1200000, 12);
    cur.byStore = [
      { storeId: 'a', name: 'Beach', bills: 7, payable: 800000 },
      { storeId: 'b', name: 'Town', bills: 5, payable: 400000 },
    ];
    const p = buildFiguresPack({ shopName: 'All 2 shops together', current: cur, previous: null });
    expect(p.text).toContain('Beach: 8,000 THB, 7 bills');
    expect(unverifiedNumbers('Beach made 8,000 THB and Town 4,000 THB.', p.allowed)).toEqual([]);
  });
});

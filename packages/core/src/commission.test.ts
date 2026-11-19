import { describe, expect, it } from 'vitest';
import {
  bpsToPct,
  commissionCsv,
  commissionTotals,
  parseCommissionRates,
  parseCommissionReport,
  parseTips,
  pctToBps,
  tipsOwed,
} from './commission';

describe('percentages', () => {
  it('reads what a person types as basis points (no floats), at most 2 decimals, 0–100', () => {
    expect(pctToBps('10')).toBe(1000);
    expect(pctToBps('7.5')).toBe(750);
    expect(pctToBps(' 7,25 ')).toBe(725);
    expect(pctToBps('0')).toBe(0);
    expect(pctToBps('100')).toBe(10000);
    expect(pctToBps('100.01')).toBeNull();
    expect(pctToBps('101')).toBeNull();
    expect(pctToBps('7.255')).toBeNull();
    expect(pctToBps('-5')).toBeNull();
    expect(pctToBps('ten')).toBeNull();
  });
  it('shows them back without trailing zeros', () => {
    expect([1000, 750, 725, 0, 10000, 5].map(bpsToPct)).toEqual([
      '10',
      '7.5',
      '7.25',
      '0',
      '100',
      '0.05',
    ]);
  });
});

describe('the report', () => {
  const raw = {
    range: { from: '2026-11-01', to: '2026-11-30' },
    rows: [
      {
        staff_id: 'a',
        name: 'Nok',
        store_id: 's1',
        service_sales: '100000',
        product_sales: 20000,
        service_bps: 2000,
        product_bps: 500,
        commission: 21000,
      },
      {
        staff_id: 'b',
        name: 'Mai',
        store_id: 's1',
        service_sales: 50000,
        product_sales: 0,
        service_bps: 1000,
        product_bps: 0,
        commission: 5000,
      },
      { name: 'broken' },
    ],
  };
  it('reads good rows and drops broken ones', () => {
    const r = parseCommissionReport(raw);
    expect(r.map((x) => x.name)).toEqual(['Nok', 'Mai']);
    expect(r[0]).toMatchObject({ serviceSales: 100000, productSales: 20000, commission: 21000 });
    expect(parseCommissionReport(null)).toEqual([]);
  });
  it('adds up', () => {
    expect(commissionTotals(parseCommissionReport(raw))).toEqual({
      serviceSales: 150000,
      productSales: 20000,
      commission: 26000,
    });
  });
  it('writes a payroll CSV in plain baht, with the formula-injection guard', () => {
    const rows = parseCommissionReport({
      rows: [
        {
          staff_id: 'a',
          name: '=Nok',
          store_id: 's',
          service_sales: 100050,
          product_sales: 0,
          service_bps: 750,
          product_bps: 0,
          commission: 7504,
        },
      ],
    });
    const csv = commissionCsv(rows, {
      name: 'Name',
      services: 'Services',
      products: 'Products',
      serviceRate: 'Service %',
      productRate: 'Product %',
      commission: 'Commission',
    });
    expect(csv).toContain("'=Nok,1000.50,0.00,7.5,0,75.04");
  });
  it('reads rates', () => {
    expect(
      parseCommissionRates([
        { staff_id: null, service_bps: 1000, product_bps: 500 },
        { staff_id: 'a', service_bps: 2000, product_bps: 500 },
        'x',
      ]),
    ).toEqual([
      { staffId: null, serviceBps: 1000, productBps: 500 },
      { staffId: 'a', serviceBps: 2000, productBps: 500 },
    ]);
  });
});

describe('tips', () => {
  it('adds up only what is still owed, per person', () => {
    const tips = parseTips([
      { id: '1', staff_id: 'a', amount: 5000, method: 'cash', status: 'owed', created_at: 'x' },
      { id: '2', staff_id: 'a', amount: 3000, method: 'promptpay', status: 'owed' },
      { id: '3', staff_id: 'a', amount: 9000, method: 'cash', status: 'paid' },
      { id: '4', staff_id: 'b', amount: 1000, method: 'gateway', status: 'owed' },
      { id: '5', staff_id: 'b', amount: 0, method: 'cash', status: 'owed' },
      { id: '6', staff_id: 'b', amount: 100, method: 'barter', status: 'owed' },
    ]);
    expect(tips).toHaveLength(4);
    expect(Object.fromEntries(tipsOwed(tips))).toEqual({ a: 8000, b: 1000 });
  });
});

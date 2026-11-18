import { describe, expect, it } from 'vitest';
import { equalShares, planSplit } from './splitTender';

describe('equalShares', () => {
  it('adds up exactly, the odd satang go first', () => {
    expect(equalShares(10000, 3)).toEqual([3334, 3333, 3333]);
    expect(equalShares(10000, 4)).toEqual([2500, 2500, 2500, 2500]);
    expect(equalShares(10000, 3).reduce((a, b) => a + b)).toBe(10000);
  });
  it('wants 2 to 20 payers', () => {
    expect(() => equalShares(100, 1)).toThrow();
    expect(() => equalShares(100, 21)).toThrow();
  });
});

describe('planSplit', () => {
  const base = { total: 21000, rule: 'none' as const, creditBalance: null as number | null };
  it('credit + cash with change', () => {
    const plan = planSplit({
      ...base,
      creditBalance: 90000,
      legs: [
        { tender: 'credit', amount: 10000 },
        { tender: 'cash', amount: 11000, tendered: 12000 },
      ],
    });
    expect(plan.problems).toEqual([]);
    expect(plan.payable).toBe(21000);
    expect(plan.payments).toEqual([
      { tender: 'credit', amount: 10000 },
      { tender: 'cash', amount: 11000, tendered: 12000, change: 1000 },
    ]);
  });
  it('rounds only the cash portion; the last cash leg carries the difference', () => {
    // total 100.10: 40.00 credit + 60.10 cash split into two cash payers; nearest-25 rule → cash portion 60.00
    const plan = planSplit({
      total: 10010,
      rule: 'nearest-25',
      creditBalance: 5000,
      legs: [
        { tender: 'credit', amount: 4000 },
        { tender: 'cash', amount: 3005 },
        { tender: 'cash', amount: 3005 },
      ],
    });
    expect(plan.problems).toEqual([]);
    expect(plan.cashDue).toBe(6000);
    expect(plan.rounding).toBe(-10);
    expect(plan.payable).toBe(10000);
    expect(plan.payments.reduce((a, p) => a + p.amount, 0)).toBe(plan.payable);
    expect(plan.payments[1]!.amount).toBe(3005);
    expect(plan.payments[2]!.amount).toBe(2995);
  });
  it('names every rule that is broken and sends nothing', () => {
    expect(planSplit({ ...base, legs: [] }).problems).toContain('empty');
    expect(planSplit({ ...base, legs: [{ tender: 'cash', amount: 20000 }] }).problems).toEqual([
      'not_whole_bill',
    ]);
    expect(
      planSplit({
        ...base,
        legs: [
          { tender: 'cash', amount: 21000 },
          { tender: 'cash', amount: 0 },
        ],
      }).problems,
    ).toContain('zero_leg');
    expect(planSplit({ ...base, legs: [{ tender: 'credit', amount: 21000 }] }).problems).toEqual([
      'credit_needs_customer',
    ]);
    expect(
      planSplit({ ...base, creditBalance: 5000, legs: [{ tender: 'credit', amount: 21000 }] })
        .problems,
    ).toEqual(['credit_over_balance']);
    const short = planSplit({
      ...base,
      legs: [{ tender: 'cash', amount: 21000, tendered: 20000 }],
    });
    expect(short.problems).toEqual(['cash_short']);
    expect(short.payments).toEqual([]);
  });
  it('three payers, all cash, equal shares', () => {
    const shares = equalShares(21000, 3);
    const plan = planSplit({
      ...base,
      legs: shares.map((amount) => ({ tender: 'cash' as const, amount })),
    });
    expect(plan.problems).toEqual([]);
    expect(plan.payments.map((p) => p.amount)).toEqual([7000, 7000, 7000]);
  });
});

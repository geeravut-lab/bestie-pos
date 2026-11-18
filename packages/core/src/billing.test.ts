import { describe, expect, it } from 'vitest';
import { DEFAULT_BILL_OPTIONS } from './tax';
import {
  billOptionsToColumn,
  parseBillOptions,
  parseRoundingConfig,
  roundingToColumn,
} from './billing';
import {
  DEFAULT_POINTS_RULE,
  eligibleSpend,
  parsePointsRule,
  pointsRuleProblems,
  pointsRuleToColumn,
} from './points';

describe('bill options', () => {
  it('parse leniently and fall back to the defaults', () => {
    expect(parseBillOptions(null)).toEqual(DEFAULT_BILL_OPTIONS);
    expect(
      parseBillOptions({ serviceChargeVat: 'maybe', serviceChargeBase: 'before_discounts' }),
    ).toEqual({ serviceChargeVat: 'taxable', serviceChargeBase: 'before_discounts' });
  });
  it('store only what differs and round-trip', () => {
    expect(billOptionsToColumn(DEFAULT_BILL_OPTIONS)).toEqual({});
    const o = { serviceChargeVat: 'not_taxable', serviceChargeBase: 'before_discounts' } as const;
    expect(parseBillOptions(billOptionsToColumn(o))).toEqual(o);
  });
});

describe('cash rounding config', () => {
  it('keeps only known tenders and rules', () => {
    expect(
      parseRoundingConfig({ cash: 'nearest-25', promptpay: 'whatever', crypto: 'nearest-baht' }),
    ).toEqual({ cash: 'nearest-25' });
    expect(parseRoundingConfig([1])).toEqual({});
  });
  it('stores only non-default rules', () => {
    expect(roundingToColumn({ cash: 'none', promptpay: 'none' })).toEqual({});
    expect(roundingToColumn({ cash: 'nearest-baht' })).toEqual({ cash: 'nearest-baht' });
  });
});

describe('points rule (owner-editable)', () => {
  it('falls back to defaults per field when missing or out of range', () => {
    expect(parsePointsRule(null)).toEqual(DEFAULT_POINTS_RULE);
    expect(
      parsePointsRule({
        earnSatangPerPoint: 5000,
        redeemSatangPerPoint: 0,
        maxRedeemBps: 99999,
        creditEarnsPoints: 'yes',
      }),
    ).toEqual({ ...DEFAULT_POINTS_RULE, earnSatangPerPoint: 5000 });
  });
  it('validates form input and stores only differences', () => {
    expect(pointsRuleProblems(DEFAULT_POINTS_RULE)).toEqual([]);
    expect(
      pointsRuleProblems({ ...DEFAULT_POINTS_RULE, earnSatangPerPoint: 0, maxRedeemBps: 20000 }),
    ).toEqual(['earnSatangPerPoint', 'maxRedeemBps']);
    expect(pointsRuleToColumn(DEFAULT_POINTS_RULE)).toEqual({});
    expect(
      parsePointsRule(
        pointsRuleToColumn({
          ...DEFAULT_POINTS_RULE,
          creditEarnsPoints: false,
          maxRedeemBps: 3000,
        }),
      ),
    ).toEqual({ ...DEFAULT_POINTS_RULE, creditEarnsPoints: false, maxRedeemBps: 3000 });
  });
  it('the owner can decide that spending Credit does not earn points', () => {
    const pay = [
      { tender: 'cash' as const, amount: 10000, status: 'confirmed' },
      { tender: 'credit' as const, amount: 5000, status: 'confirmed' },
    ];
    expect(eligibleSpend(pay)).toBe(15000);
    expect(eligibleSpend(pay, { creditEarnsPoints: false })).toBe(10000);
  });
});

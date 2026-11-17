import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POINTS_RULE,
  POINTS_ENTRY_KINDS,
  eligibleSpend,
  pointsBalance,
  pointsEarned,
  redeemAsDiscount,
  validatePointsEntry,
} from './points';

const pay = (
  tender: 'cash' | 'promptpay' | 'gateway' | 'credit' | 'points',
  amount: number,
  status = 'confirmed',
) => ({ tender, amount, status });

describe('earning — from THB spend only', () => {
  it('counts cash / PromptPay / gateway / Credit spend and never the Points portion', () => {
    expect(eligibleSpend([pay('cash', 10000), pay('points', 5000), pay('credit', 2500)])).toBe(
      12500,
    );
  });

  it('ignores unconfirmed payments', () => {
    expect(
      eligibleSpend([pay('promptpay', 10000, 'pending'), pay('gateway', 10000, 'failed')]),
    ).toBe(0);
  });

  it('1 point per ฿25 by default, rounded down', () => {
    expect(pointsEarned(2499)).toBe(0);
    expect(pointsEarned(2500)).toBe(1);
    expect(pointsEarned(12599)).toBe(5);
  });
});

describe('redeeming — only as a discount, capped', () => {
  it('converts points to discount at the rule value', () => {
    expect(redeemAsDiscount(10, 50, 100000)).toEqual({ pointsUsed: 10, discount: 1000 });
  });

  it('is limited by balance and by the share of the bill points may cover', () => {
    expect(redeemAsDiscount(100, 20, 100000).pointsUsed).toBe(20);
    // bill ฿100, cap 50 % → ฿50 → 50 points at ฿1/point
    expect(redeemAsDiscount(999, 999, 10000)).toEqual({ pointsUsed: 50, discount: 5000 });
  });

  it('never exceeds the cap even when the rule is generous', () => {
    const rule = { ...DEFAULT_POINTS_RULE, maxRedeemBps: 10000 };
    expect(redeemAsDiscount(999, 999, 3000, rule).discount).toBe(3000);
  });
});

describe('ledger — purchase and cash-out cannot exist', () => {
  it('has a closed set of kinds', () => {
    expect(POINTS_ENTRY_KINDS).not.toContain('purchase');
    expect(POINTS_ENTRY_KINDS).not.toContain('cash_out');
  });

  it.each(['purchase', 'buy', 'cash_out', 'cashout', 'topup', 'transfer', 'refund_cash'])(
    'rejects kind "%s" at runtime',
    (kind) => {
      expect(validatePointsEntry({ kind: kind as never, points: 10, orderId: 'o1' }, 100)).toEqual([
        'unknown_kind',
      ]);
    },
  );

  it('earn needs an order and a positive amount', () => {
    expect(validatePointsEntry({ kind: 'earn', points: 5, orderId: 'o1' }, 0)).toEqual([]);
    expect(validatePointsEntry({ kind: 'earn', points: 5 }, 0)).toContain('order_required');
    expect(validatePointsEntry({ kind: 'earn', points: -5, orderId: 'o1' }, 10)).toContain(
      'wrong_sign',
    );
  });

  it('redeem is negative, needs an order and cannot overdraw', () => {
    expect(validatePointsEntry({ kind: 'redeem', points: -10, orderId: 'o1' }, 10)).toEqual([]);
    expect(validatePointsEntry({ kind: 'redeem', points: -11, orderId: 'o1' }, 10)).toContain(
      'insufficient_balance',
    );
    expect(validatePointsEntry({ kind: 'redeem', points: 10, orderId: 'o1' }, 10)).toContain(
      'wrong_sign',
    );
  });

  it('adjustments need a reason and whole numbers', () => {
    expect(validatePointsEntry({ kind: 'adjust', points: 3 }, 0)).toContain('reason_required');
    expect(validatePointsEntry({ kind: 'adjust', points: 3, reason: 'goodwill' }, 0)).toEqual([]);
    expect(validatePointsEntry({ kind: 'adjust', points: 1.5, reason: 'x' }, 0)).toContain(
      'not_integer',
    );
  });

  it('balance is the sum of signed entries', () => {
    expect(pointsBalance([{ points: 10 }, { points: -4 }, { points: 2 }])).toBe(8);
  });
});

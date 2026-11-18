import { BPS, MoneyError, assertNonNegative, mulBps } from './money';
import type { Satang } from './money';
import type { TenderKind } from './rounding';
import type { Id, IsoDateTime, Scope } from './types';

/**
 * Bestie POINTS = rewards. Rules enforced here (CLAUDE.md rule 2, PRODUCT_SPEC §2):
 *  - earned ONLY from THB spend on a paid order — never purchasable, never a top-up side effect;
 *  - redeemed ONLY as a discount on a bill — never cashed out;
 *  - kept in a ledger that is separate from Bestie Credit.
 * The ledger entry `kind` is a closed set; any other value (e.g. "purchase", "cash_out") is rejected at runtime too,
 * because rows come from the database / network, not just from typed code.
 */
export type PointsRule = {
  /** Spend needed for 1 point, in satang (e.g. 2500 = 1 point per THB 25). */
  earnSatangPerPoint: number;
  /** Discount value of 1 point, in satang (e.g. 100 = THB 1). */
  redeemSatangPerPoint: number;
  /** Max share of a bill that points may cover, in bps (e.g. 5000 = 50 %). */
  maxRedeemBps: number;
  /** Does paying with Bestie Credit earn points? (Credit is prepaid money: the spend happens when it is used.) */
  creditEarnsPoints: boolean;
};

export const DEFAULT_POINTS_RULE: PointsRule = {
  earnSatangPerPoint: 2500,
  redeemSatangPerPoint: 100,
  maxRedeemBps: 5000,
  creditEarnsPoints: true,
};

/**
 * Tenders whose money counts as "spend". Points paid bills do not earn points on the points portion
 * (no earning on a discount), and nothing is earned from buying Credit — only from spending it on goods.
 */
const EARNING_TENDERS: ReadonlySet<TenderKind> = new Set([
  'cash',
  'promptpay',
  'gateway',
  'credit',
]);

export function eligibleSpend(
  payments: readonly { tender: TenderKind; amount: Satang; status: string }[],
  rule: Pick<PointsRule, 'creditEarnsPoints'> = DEFAULT_POINTS_RULE,
): Satang {
  return payments
    .filter(
      (p) =>
        p.status === 'confirmed' &&
        EARNING_TENDERS.has(p.tender) &&
        (rule.creditEarnsPoints || p.tender !== 'credit'),
    )
    .reduce((sum, p) => {
      assertNonNegative(p.amount, 'payment amount');
      return sum + p.amount;
    }, 0);
}

export function pointsEarned(spend: Satang, rule: PointsRule = DEFAULT_POINTS_RULE): number {
  assertNonNegative(spend, 'spend');
  if (rule.earnSatangPerPoint <= 0) throw new MoneyError('earnSatangPerPoint must be positive');
  return Math.floor(spend / rule.earnSatangPerPoint);
}

export type Redemption = { pointsUsed: number; discount: Satang };

/** How much of `wanted` points can be applied to a bill with `billAmount` payable. Never more than the cap. */
export function redeemAsDiscount(
  wanted: number,
  balance: number,
  billAmount: Satang,
  rule: PointsRule = DEFAULT_POINTS_RULE,
): Redemption {
  if (!Number.isSafeInteger(wanted) || wanted < 0)
    throw new MoneyError('points must be a non-negative integer');
  if (!Number.isSafeInteger(balance) || balance < 0)
    throw new MoneyError('balance must be a non-negative integer');
  assertNonNegative(billAmount, 'bill');
  const capDiscount = mulBps(billAmount, Math.min(rule.maxRedeemBps, BPS), 'floor');
  const capPoints = Math.floor(capDiscount / rule.redeemSatangPerPoint);
  const pointsUsed = Math.min(wanted, balance, capPoints);
  return { pointsUsed, discount: pointsUsed * rule.redeemSatangPerPoint };
}

// ── ledger ──────────────────────────────────────────────────────────────────
export const POINTS_ENTRY_KINDS = [
  'earn', // from a paid order
  'redeem', // as a discount on an order
  'reverse_earn', // order voided / refunded
  'reverse_redeem', // redemption voided
  'expire',
  'adjust', // manager correction (audited, permission-gated elsewhere)
] as const;
export type PointsEntryKind = (typeof POINTS_ENTRY_KINDS)[number];

export type PointsLedgerEntry = Scope & {
  id: Id;
  customerId: Id;
  kind: PointsEntryKind;
  /** Signed: earn/reverse_redeem > 0, redeem/reverse_earn/expire < 0. */
  points: number;
  orderId?: Id;
  reason?: string;
  createdAt: IsoDateTime;
};

const POSITIVE: ReadonlySet<string> = new Set(['earn', 'reverse_redeem']);
const NEGATIVE: ReadonlySet<string> = new Set(['redeem', 'reverse_earn', 'expire']);
const NEEDS_ORDER: ReadonlySet<string> = new Set([
  'earn',
  'redeem',
  'reverse_earn',
  'reverse_redeem',
]);

export type LedgerProblem =
  | 'unknown_kind'
  | 'not_integer'
  | 'wrong_sign'
  | 'order_required'
  | 'reason_required'
  | 'insufficient_balance';

/** Returns every rule the entry breaks (empty = OK). `balance` is the balance BEFORE this entry. */
export function validatePointsEntry(
  entry: Pick<PointsLedgerEntry, 'kind' | 'points' | 'orderId' | 'reason'>,
  balance: number,
): LedgerProblem[] {
  const problems: LedgerProblem[] = [];
  if (!(POINTS_ENTRY_KINDS as readonly string[]).includes(entry.kind)) {
    // "purchase", "cash_out", "topup", "transfer"… are exactly what must never exist.
    return ['unknown_kind'];
  }
  if (!Number.isSafeInteger(entry.points) || entry.points === 0) problems.push('not_integer');
  if (POSITIVE.has(entry.kind) && entry.points <= 0) problems.push('wrong_sign');
  if (NEGATIVE.has(entry.kind) && entry.points >= 0) problems.push('wrong_sign');
  if (NEEDS_ORDER.has(entry.kind) && !entry.orderId) problems.push('order_required');
  if (entry.kind === 'adjust' && !entry.reason?.trim()) problems.push('reason_required');
  if (balance + entry.points < 0) problems.push('insufficient_balance');
  return problems;
}

export const pointsBalance = (entries: readonly Pick<PointsLedgerEntry, 'points'>[]): number =>
  entries.reduce((sum, e) => sum + e.points, 0);

// ── owner-editable rule ─────────────────────────────────────────────────────
export const POINTS_RULE_LIMITS = {
  earnSatangPerPoint: { min: 100, max: 1_000_000 }, // THB 1 … THB 10,000 per point
  redeemSatangPerPoint: { min: 1, max: 10_000 }, // THB 0.01 … THB 100 per point
  maxRedeemBps: { min: 0, max: 10_000 },
} as const;

const inRange = (v: unknown, r: { min: number; max: number }): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= r.min && v <= r.max;

/** Lenient: any field that is missing or out of range falls back to the default (a bad row never stops a sale). */
export function parsePointsRule(raw: unknown): PointsRule {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >;
  return {
    earnSatangPerPoint: inRange(o.earnSatangPerPoint, POINTS_RULE_LIMITS.earnSatangPerPoint)
      ? o.earnSatangPerPoint
      : DEFAULT_POINTS_RULE.earnSatangPerPoint,
    redeemSatangPerPoint: inRange(o.redeemSatangPerPoint, POINTS_RULE_LIMITS.redeemSatangPerPoint)
      ? o.redeemSatangPerPoint
      : DEFAULT_POINTS_RULE.redeemSatangPerPoint,
    maxRedeemBps: inRange(o.maxRedeemBps, POINTS_RULE_LIMITS.maxRedeemBps)
      ? o.maxRedeemBps
      : DEFAULT_POINTS_RULE.maxRedeemBps,
    creditEarnsPoints:
      typeof o.creditEarnsPoints === 'boolean'
        ? o.creditEarnsPoints
        : DEFAULT_POINTS_RULE.creditEarnsPoints,
  };
}

/** Strict check for the settings form: returns the field names that are out of range. */
export function pointsRuleProblems(rule: PointsRule): (keyof PointsRule)[] {
  const bad: (keyof PointsRule)[] = [];
  if (!inRange(rule.earnSatangPerPoint, POINTS_RULE_LIMITS.earnSatangPerPoint))
    bad.push('earnSatangPerPoint');
  if (!inRange(rule.redeemSatangPerPoint, POINTS_RULE_LIMITS.redeemSatangPerPoint))
    bad.push('redeemSatangPerPoint');
  if (!inRange(rule.maxRedeemBps, POINTS_RULE_LIMITS.maxRedeemBps)) bad.push('maxRedeemBps');
  return bad;
}

/** Store only what differs from the default. */
export function pointsRuleToColumn(rule: PointsRule): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  (Object.keys(DEFAULT_POINTS_RULE) as (keyof PointsRule)[]).forEach((k) => {
    if (rule[k] !== DEFAULT_POINTS_RULE[k]) out[k] = rule[k];
  });
  return out;
}

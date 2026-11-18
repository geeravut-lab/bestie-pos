import { SATANG_PER_BAHT, assertNonNegative } from './money.js';
import type { Satang } from './money.js';

/**
 * Rounding is a per-payment-method concern (Thai cash has no 1-satang coin in practice; digital
 * tenders settle to the satang). The adjustment is shown on the bill as its own line and never
 * changes the VAT breakdown.
 */
export type RoundingRule = 'none' | 'nearest-25' | 'nearest-50' | 'nearest-baht' | 'floor-baht';

export type TenderKind = 'cash' | 'promptpay' | 'gateway' | 'credit' | 'points';

/** Store-configurable; defaults keep digital tenders exact and cash exact until the owner opts in. */
export type RoundingConfig = Partial<Record<TenderKind, RoundingRule>>;

export const DEFAULT_ROUNDING: Required<RoundingConfig> = {
  cash: 'none',
  promptpay: 'none',
  gateway: 'none',
  credit: 'none',
  points: 'none',
};

const STEP: Record<Exclude<RoundingRule, 'none' | 'floor-baht'>, number> = {
  'nearest-25': 25,
  'nearest-50': 50,
  'nearest-baht': SATANG_PER_BAHT,
};

export type Rounded = { rounded: Satang; adjustment: Satang };

export function applyRounding(total: Satang, rule: RoundingRule): Rounded {
  assertNonNegative(total, 'total');
  if (rule === 'none') return { rounded: total, adjustment: 0 };
  if (rule === 'floor-baht') {
    const rounded = Math.floor(total / SATANG_PER_BAHT) * SATANG_PER_BAHT;
    return { rounded, adjustment: rounded - total };
  }
  const step = STEP[rule];
  const rounded = Math.floor((total + step / 2) / step) * step; // half-up
  return { rounded, adjustment: rounded - total };
}

export const roundingFor = (tender: TenderKind, config: RoundingConfig = {}): RoundingRule =>
  config[tender] ?? DEFAULT_ROUNDING[tender];

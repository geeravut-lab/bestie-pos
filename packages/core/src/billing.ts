import { DEFAULT_BILL_OPTIONS } from './tax';
import type { BillOptions } from './tax';
import { DEFAULT_ROUNDING } from './rounding';
import type { RoundingConfig, RoundingRule, TenderKind } from './rounding';

/**
 * Owner-editable billing choices (the accountant confirms them; they are NOT hard-coded). Stored per store as
 * `stores.bill_options` and `stores.rounding`, only what differs from the defaults. Parsing is lenient: a bad row falls
 * back to the defaults instead of breaking the till.
 */
export const SERVICE_CHARGE_VAT_OPTIONS = ['taxable', 'not_taxable'] as const;
export const SERVICE_CHARGE_BASE_OPTIONS = ['after_discounts', 'before_discounts'] as const;
export const ROUNDING_RULES = [
  'none',
  'nearest-25',
  'nearest-50',
  'nearest-baht',
  'floor-baht',
] as const;
const TENDERS: readonly TenderKind[] = ['cash', 'promptpay', 'gateway', 'credit', 'points'];

export function parseBillOptions(raw: unknown): BillOptions {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >;
  return {
    serviceChargeVat: (SERVICE_CHARGE_VAT_OPTIONS as readonly unknown[]).includes(
      o.serviceChargeVat,
    )
      ? (o.serviceChargeVat as BillOptions['serviceChargeVat'])
      : DEFAULT_BILL_OPTIONS.serviceChargeVat,
    serviceChargeBase: (SERVICE_CHARGE_BASE_OPTIONS as readonly unknown[]).includes(
      o.serviceChargeBase,
    )
      ? (o.serviceChargeBase as BillOptions['serviceChargeBase'])
      : DEFAULT_BILL_OPTIONS.serviceChargeBase,
  };
}

export function billOptionsToColumn(o: BillOptions): Record<string, string> {
  const out: Record<string, string> = {};
  if (o.serviceChargeVat !== DEFAULT_BILL_OPTIONS.serviceChargeVat)
    out.serviceChargeVat = o.serviceChargeVat;
  if (o.serviceChargeBase !== DEFAULT_BILL_OPTIONS.serviceChargeBase)
    out.serviceChargeBase = o.serviceChargeBase;
  return out;
}

export function parseRoundingConfig(raw: unknown): RoundingConfig {
  const out: RoundingConfig = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const t of TENDERS) {
      const v = (raw as Record<string, unknown>)[t];
      if ((ROUNDING_RULES as readonly unknown[]).includes(v)) out[t] = v as RoundingRule;
    }
  }
  return out;
}

export function roundingToColumn(c: RoundingConfig): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of TENDERS) if (c[t] && c[t] !== DEFAULT_ROUNDING[t]) out[t] = c[t]!;
  return out;
}

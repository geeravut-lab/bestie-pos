import { BPS, MoneyError, assertNonNegative, assertSatang, mulBps, sum } from './money.js';
import type { Satang } from './money.js';

/** Thai VAT is 7 % (700 bps). Kept as a parameter: the rate belongs to the store, not to the code. */
export const THAI_VAT_BPS = 700;
/** Typical restaurant service charge (10 %). Only a default; configurable per store. */
export const DEFAULT_SERVICE_CHARGE_BPS = 1000;

export type PriceMode = 'inclusive' | 'exclusive';

export type Discount = { type: 'amount'; satang: Satang } | { type: 'percent'; bps: number };

export type BillLineInput = {
  unitPrice: Satang;
  quantity: number;
  /** Fixed discount on this line (total, not per unit). */
  discount?: Satang;
};

/** Accounting choices the OWNER makes (and the accountant confirms) — see billing.ts. */
export type BillOptions = {
  /** Is the service charge part of the VAT base? */
  serviceChargeVat: 'taxable' | 'not_taxable';
  /** Is the service charge computed on the discounted subtotal or on the full subtotal? */
  serviceChargeBase: 'after_discounts' | 'before_discounts';
};

export const DEFAULT_BILL_OPTIONS: BillOptions = {
  serviceChargeVat: 'taxable',
  serviceChargeBase: 'after_discounts',
};

export type BillInput = {
  /** Omitted = DEFAULT_BILL_OPTIONS. */
  options?: Partial<BillOptions>;
  lines: readonly BillLineInput[];
  /** Whole-bill discount applied after line discounts. */
  billDiscount?: Discount;
  /** Bestie Points redeemed as a discount (already converted to satang). Applied last, capped. */
  pointsDiscount?: Satang;
  priceMode: PriceMode;
  /** 0 for shops that are not VAT-registered. */
  vatBps: number;
  serviceChargeBps: number;
};

export type BillBreakdown = {
  /** Σ unitPrice × quantity, before any discount. */
  subtotal: Satang;
  lineDiscounts: Satang;
  billDiscount: Satang;
  pointsDiscount: Satang;
  /** subtotal − all discounts (what the service charge is computed on). */
  discountedSubtotal: Satang;
  serviceCharge: Satang;
  /** VAT contained in / added to the bill. */
  vat: Satang;
  /** Amount before VAT (net of VAT, includes service charge net). For the tax-invoice breakdown. */
  netBeforeVat: Satang;
  /** What the customer owes before tender rounding. */
  total: Satang;
};

/** VAT contained in a VAT-inclusive gross amount: gross × rate / (1 + rate). */
export function vatFromInclusive(gross: Satang, vatBps: number): { net: Satang; vat: Satang } {
  assertNonNegative(gross, 'gross');
  if (vatBps === 0) return { net: gross, vat: 0 };
  const vat = Math.floor((gross * vatBps + (BPS + vatBps) / 2) / (BPS + vatBps));
  return { net: gross - vat, vat };
}

export function vatOnExclusive(net: Satang, vatBps: number): Satang {
  return mulBps(net, vatBps, 'half-up');
}

/**
 * Compute a bill. Order of operations (the owner/accountant can choose the two marked options, see
 * `BillOptions`):
 *   1. line discounts → 2. whole-bill discount → 3. Points discount (capped at what is left)
 *   4. service charge on the discounted subtotal [or the full subtotal], 5. VAT on (discounted subtotal
 *   + service charge) [or on the goods only when the service charge is not taxable].
 * `inclusive`: shelf prices already contain VAT, the service charge is added on top and carries VAT
 * itself, so VAT is extracted from the gross. `exclusive`: VAT is added on top.
 */
export function computeBill(input: BillInput): BillBreakdown {
  if (input.vatBps < 0 || input.serviceChargeBps < 0)
    throw new MoneyError('rates must not be negative');

  const lineTotals = input.lines.map((l) => {
    assertNonNegative(l.unitPrice, 'unitPrice');
    if (!Number.isSafeInteger(l.quantity) || l.quantity < 1)
      throw new MoneyError('quantity must be a positive integer');
    const gross = l.unitPrice * l.quantity;
    const discount = l.discount ?? 0;
    assertNonNegative(discount, 'line discount');
    if (discount > gross) throw new MoneyError('line discount exceeds line total');
    return { gross, discount };
  });

  const subtotal = sum(lineTotals.map((l) => l.gross));
  const lineDiscounts = sum(lineTotals.map((l) => l.discount));
  const afterLines = subtotal - lineDiscounts;

  let billDiscount = 0;
  if (input.billDiscount) {
    billDiscount =
      input.billDiscount.type === 'amount'
        ? input.billDiscount.satang
        : mulBps(afterLines, input.billDiscount.bps, 'half-up');
    assertNonNegative(billDiscount, 'bill discount');
    billDiscount = Math.min(billDiscount, afterLines);
  }
  const afterBill = afterLines - billDiscount;

  const requestedPoints = input.pointsDiscount ?? 0;
  assertNonNegative(requestedPoints, 'points discount');
  const pointsDiscount = Math.min(requestedPoints, afterBill);

  const discountedSubtotal = afterBill - pointsDiscount;
  const opts = { ...DEFAULT_BILL_OPTIONS, ...input.options };
  const serviceCharge = mulBps(
    opts.serviceChargeBase === 'before_discounts' ? subtotal : discountedSubtotal,
    input.serviceChargeBps,
    'half-up',
  );
  const base = discountedSubtotal + serviceCharge;
  // The amount VAT is calculated on: with a non-taxable service charge it is only the goods.
  const vatBase = opts.serviceChargeVat === 'taxable' ? base : discountedSubtotal;

  if (input.priceMode === 'inclusive') {
    const { vat } = vatFromInclusive(vatBase, input.vatBps);
    const net = base - vat;
    return {
      subtotal,
      lineDiscounts,
      billDiscount,
      pointsDiscount,
      discountedSubtotal,
      serviceCharge,
      vat,
      netBeforeVat: net,
      total: base,
    };
  }
  const vat = vatOnExclusive(vatBase, input.vatBps);
  return {
    subtotal,
    lineDiscounts,
    billDiscount,
    pointsDiscount,
    discountedSubtotal,
    serviceCharge,
    vat,
    netBeforeVat: base,
    total: base + vat,
  };
}

/** Validate a store-supplied rate. */
export function assertBps(bps: number, what = 'rate'): void {
  assertSatang(bps, what);
  if (bps < 0 || bps > BPS) throw new MoneyError(`${what} must be between 0 and ${BPS} bps`);
}

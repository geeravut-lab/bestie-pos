// Product returns: how much money goes back, which routes may carry it, what can still come back.
// The database computes the same numbers (`create_return`); this mirror lets the screen show the amount before the manager confirms,
// and a test keeps the two honest.

export const RETURN_REASONS = ['wrong_item', 'defective', 'changed_mind', 'other'] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

/** cash = out of the till's drawer · credit = back onto the member's Bestie Credit · manual = PromptPay / card refunded by hand. */
export const RETURN_METHODS = ['cash', 'credit', 'manual'] as const;
export type ReturnMethod = (typeof RETURN_METHODS)[number];

export type ReturnLine = {
  /** Satang per unit, as sold. */
  unitPrice: number;
  /** Units on the bill. */
  quantity: number;
  /** Units already returned earlier. */
  returned: number;
  /** Units coming back now. */
  now: number;
};

/** Units of a line that can still come back. */
export const returnableQty = (quantity: number, returned: number): number =>
  Math.max(0, Math.trunc(quantity) - Math.trunc(returned));

/**
 * The money for one return, in satang. Proportional to what the bill really took (`payable`: service charge, VAT, discounts and
 * rounding come back in proportion) and cumulative, so several partial returns add up to exactly what was paid and returning
 * everything refunds exactly `payable`.
 */
export function returnAmount(input: {
  payable: number;
  lines: readonly ReturnLine[];
  /** What earlier returns of this bill already paid back. */
  refundedBefore: number;
}): number {
  const sold = input.lines.reduce((n, l) => n + l.unitPrice * l.quantity, 0);
  const before = input.lines.reduce((n, l) => n + l.unitPrice * l.returned, 0);
  const now = input.lines.reduce((n, l) => n + l.unitPrice * l.now, 0);
  let cumulative: number;
  if (sold <= 0) cumulative = input.refundedBefore;
  else if (before + now >= sold) cumulative = input.payable;
  else cumulative = Math.round((input.payable * (before + now)) / sold);
  return Math.max(0, cumulative - input.refundedBefore);
}

export type PaidByTender = { tender: string; amount: number };

/**
 * What a route can still carry: cash ≤ cash paid, credit ≤ Credit paid, manual ≤ PromptPay + card paid — each minus what was already
 * returned that way.
 */
export function routeAvailable(
  method: ReturnMethod,
  payments: readonly PaidByTender[],
  returns: readonly { method: ReturnMethod; amount: number }[],
): number {
  const tenders: Record<ReturnMethod, readonly string[]> = {
    cash: ['cash'],
    credit: ['credit'],
    manual: ['promptpay', 'gateway'],
  };
  const paid = payments
    .filter((p) => tenders[method].includes(p.tender))
    .reduce((n, p) => n + p.amount, 0);
  const back = returns.filter((r) => r.method === method).reduce((n, r) => n + r.amount, 0);
  return Math.max(0, paid - back);
}

/** The routes that can carry `amount` right now, in the order the screen offers them (what the customer paid with first). */
export function usableRoutes(
  amount: number,
  payments: readonly PaidByTender[],
  returns: readonly { method: ReturnMethod; amount: number }[],
  creditAllowed: boolean,
): ReturnMethod[] {
  return RETURN_METHODS.filter(
    (m) => (m !== 'credit' || creditAllowed) && routeAvailable(m, payments, returns) >= amount,
  );
}

export type ReturnsReport = {
  totals: { returns: number; refunded: number; units: number };
  rows: {
    number: string;
    bill: string;
    amount: number;
    method: string;
    reason: string;
    at: string;
  }[];
};

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const s = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The server's `returns_report` document, read defensively (anything missing counts as zero / empty). */
export function parseReturnsReport(raw: unknown): ReturnsReport {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const tot = (o.totals && typeof o.totals === 'object' ? o.totals : {}) as Record<string, unknown>;
  const rows = Array.isArray(o.rows) ? (o.rows as Record<string, unknown>[]) : [];
  return {
    totals: { returns: n(tot.returns), refunded: n(tot.refunded), units: n(tot.units) },
    rows: rows.map((r) => ({
      number: s(r.number),
      bill: s(r.bill),
      amount: n(r.amount),
      method: s(r.method),
      reason: s(r.reason),
      at: s(r.at),
    })),
  };
}

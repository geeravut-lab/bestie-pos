import { splitEvenly } from './money';
import type { Satang } from './money';
import { applyRounding } from './rounding';
import type { RoundingRule } from './rounding';

/**
 * Split tender: one bill paid by several people with a mix of cash and Bestie Credit.
 * The nominal legs add up to the bill total. Cash rounding (the shop's rule) applies to the CASH portion only, so the
 * rounding difference is carried by the last cash leg and the bill's `rounding` line; Credit is always exact.
 * Any number of legs may be PromptPay or card: each is charged to the satang through the payment provider (`plan.digitals`, paid one
 * after the other). The earlier ones are HELD on the bill when the provider confirms them; the LAST one carries the cash / Credit legs
 * (`plan.payments`) and its confirmation closes the bill. `held` = what is already held on the bill from an earlier round.
 */
export type SplitLeg = {
  tender: 'cash' | 'credit' | 'promptpay' | 'gateway';
  /** The share this payer owes, before cash rounding. */
  amount: Satang;
  /** Cash only: what the payer handed over (defaults to exactly what is due). */
  tendered?: Satang;
};

export type SplitProblem =
  | 'empty'
  | 'not_whole_bill' // the shares do not add up to the bill total
  | 'zero_leg'
  | 'credit_over_balance'
  | 'credit_needs_customer'
  | 'cash_short' // a payer handed over less than they owe
  | 'too_many_digital'; // at most 6 PromptPay / card shares per bill

export type SplitPayment = {
  tender: 'cash' | 'credit';
  amount: Satang;
  tendered?: Satang;
  change?: Satang;
};

export type SplitPlan = {
  problems: SplitProblem[];
  /** The bill total plus the cash rounding. */
  payable: Satang;
  rounding: Satang;
  cashDue: Satang;
  creditDue: Satang;
  /** The cash / Credit legs, ready for the server (empty when there are problems). */
  payments: SplitPayment[];
  /** The PromptPay / card shares in the order they are charged (each exactly, no rounding). */
  digitals: { tender: 'promptpay' | 'gateway'; amount: Satang }[];
};

export function planSplit(p: {
  total: Satang;
  /** PromptPay / card shares already held on the bill (paid, waiting for the bill to close). */
  held?: Satang;
  rule: RoundingRule;
  legs: readonly SplitLeg[];
  /** Credit available to this customer in this shop's company; null = no customer or Credit off. */
  creditBalance: Satang | null;
}): SplitPlan {
  const problems: SplitProblem[] = [];
  const legs = p.legs;
  if (legs.length === 0) problems.push('empty');
  if (legs.some((l) => !Number.isSafeInteger(l.amount) || l.amount <= 0)) problems.push('zero_leg');
  const nominal = legs.reduce((a, l) => a + l.amount, 0);
  const held = p.held ?? 0;
  if (legs.length > 0 && nominal !== p.total - held) problems.push('not_whole_bill');

  const digitalLegs = legs.filter((l) => l.tender === 'promptpay' || l.tender === 'gateway');
  if (digitalLegs.length > 6) problems.push('too_many_digital');

  const creditDue = legs.filter((l) => l.tender === 'credit').reduce((a, l) => a + l.amount, 0);
  if (creditDue > 0) {
    if (p.creditBalance === null) problems.push('credit_needs_customer');
    else if (creditDue > p.creditBalance) problems.push('credit_over_balance');
  }

  const cashNominal = legs.filter((l) => l.tender === 'cash').reduce((a, l) => a + l.amount, 0);
  const { rounded, adjustment } = applyRounding(Math.max(0, cashNominal), p.rule);
  const cashLegs = legs.filter((l) => l.tender === 'cash');
  const lastCash = cashLegs.length - 1;

  const payments: SplitPayment[] = [];
  let cashIdx = 0;
  for (const l of legs) {
    if (l.tender === 'promptpay' || l.tender === 'gateway') continue;
    if (l.tender === 'credit') {
      payments.push({ tender: 'credit', amount: l.amount });
      continue;
    }
    const amount = l.amount + (cashIdx === lastCash ? adjustment : 0);
    cashIdx += 1;
    const tendered = l.tendered ?? amount;
    if (tendered < amount) problems.push('cash_short');
    payments.push({ tender: 'cash', amount, tendered, change: Math.max(0, tendered - amount) });
  }
  return {
    problems: [...new Set(problems)],
    payable: p.total + adjustment,
    rounding: adjustment,
    cashDue: rounded,
    creditDue,
    payments: problems.length === 0 ? payments : [],
    digitals:
      problems.length === 0
        ? digitalLegs.map((l) => ({
            tender: l.tender as 'promptpay' | 'gateway',
            amount: l.amount,
          }))
        : [],
  };
}

/** N equal shares of a bill; the extra satang go to the first payers so the shares add up exactly. */
export function equalShares(total: Satang, people: number): Satang[] {
  if (!Number.isInteger(people) || people < 2 || people > 20)
    throw new RangeError('2 to 20 payers');
  return splitEvenly(total, people);
}

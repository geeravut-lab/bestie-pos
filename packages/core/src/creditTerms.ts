// Bestie Credit for real customers: the terms version, the single-entity check and the liability per company. Pure helpers (docs/LEGAL-DRAFTS.md §7).
import { toCsv } from './csv';
import type { Satang } from './money';

/** The version of the Credit terms shown at the counter. Mirrors `credit_terms_version()` (a test keeps them equal); a new version needs a new acceptance. */
export const CREDIT_TERMS_VERSION = 1;

const isRec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const s = (v: unknown): string => (typeof v === 'string' ? v : '');

export type CreditEntityRow = {
  storeId: string;
  store: string;
  entityId: string;
  entity: string;
  taxIdSet: boolean;
  creditOn: boolean;
};

/** Read `credit_entity_check()`: which company's Credit each shop sells. */
export function parseCreditEntities(raw: unknown): CreditEntityRow[] {
  return (Array.isArray(raw) ? raw : []).flatMap((r): CreditEntityRow[] => {
    if (!isRec(r) || typeof r.store_id !== 'string' || typeof r.entity_id !== 'string') return [];
    return [
      {
        storeId: r.store_id,
        store: s(r.store),
        entityId: r.entity_id,
        entity: s(r.entity),
        taxIdSet: r.tax_id_set === true,
        creditOn: r.credit_on === true,
      },
    ];
  });
}

/** Companies whose Credit is sold by shops with Credit on: a customer's Credit works only at the shops of ONE company. */
export function creditGroups(
  rows: readonly CreditEntityRow[],
): { entity: string; taxIdSet: boolean; shops: string[] }[] {
  const map = new Map<string, { entity: string; taxIdSet: boolean; shops: string[] }>();
  for (const r of rows) {
    if (!r.creditOn) continue;
    const g = map.get(r.entityId) ?? { entity: r.entity, taxIdSet: r.taxIdSet, shops: [] };
    g.shops.push(r.store);
    map.set(r.entityId, g);
  }
  return [...map.values()].sort((a, b) => a.entity.localeCompare(b.entity));
}

export type CreditLiabilityRow = {
  entityId: string;
  name: string;
  taxId: string;
  toppedUp: Satang;
  cash: Satang;
  psp: Satang;
  crypto: Satang;
  spent: Satang;
  adjusted: Satang;
  outstanding: Satang;
  customers: number;
};

/** Read `credit_liability_detail()`. */
export function parseCreditLiability(raw: unknown): CreditLiabilityRow[] {
  return (Array.isArray(raw) ? raw : []).flatMap((r): CreditLiabilityRow[] => {
    if (!isRec(r) || typeof r.legal_entity_id !== 'string') return [];
    return [
      {
        entityId: r.legal_entity_id,
        name: s(r.name),
        taxId: s(r.tax_id),
        toppedUp: n(r.topped_up),
        cash: n(r.topped_up_cash),
        psp: n(r.topped_up_psp),
        crypto: n(r.topped_up_crypto),
        spent: n(r.spent),
        adjusted: n(r.adjusted),
        outstanding: n(r.outstanding),
        customers: n(r.customers),
      },
    ];
  });
}

/** Integer satang as plain baht ("1090.00"): no float arithmetic, a spreadsheet can add the column up. */
const baht = (satang: number): string => {
  const sign = satang < 0 ? '-' : '';
  const abs = Math.abs(satang);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

/** The liability as a CSV for the accountant (amounts in plain baht, formula-injection guarded). */
export function creditLiabilityCsv(rows: readonly CreditLiabilityRow[], asOf: string): string {
  return toCsv(
    [
      'as_of',
      'company',
      'tax_id',
      'topped_up_cash',
      'topped_up_promptpay_card',
      'topped_up_crypto',
      'topped_up_total',
      'spent',
      'corrections',
      'outstanding_owed_to_customers',
      'customers_with_balance',
    ],
    rows.map((r) => [
      asOf,
      r.name,
      r.taxId,
      baht(r.cash),
      baht(r.psp),
      baht(r.crypto),
      baht(r.toppedUp),
      baht(r.spent),
      baht(r.adjusted),
      baht(r.outstanding),
      String(r.customers),
    ]),
  );
}

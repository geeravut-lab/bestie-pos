// The accounting choices of a service shop (salon / spa / massage), owner decisions 2026-11-21 (docs/ACCOUNTANT-BRIEF.md). Pure helpers.
import type { Satang } from './money';

export type CommissionBase = 'net' | 'as_sold';
export type PackageRevenue = 'deferred' | 'at_sale';
export type ServicePolicy = {
  /** `net` = before VAT and after ALL discounts (default); `as_sold` = the line amount as sold. */
  commissionBase: CommissionBase;
  /** A deposit for a service gets a receipt / tax-invoice number the day it is received. */
  depositInvoice: boolean;
  /** A kept no-show fee is revenue with VAT. */
  noshowFeeVat: boolean;
  /** `deferred` = income received in advance released with each visit and at expiry (default). */
  packageRevenue: PackageRevenue;
};

export const DEFAULT_SERVICE_POLICY: ServicePolicy = {
  commissionBase: 'net',
  depositInvoice: true,
  noshowFeeVat: true,
  packageRevenue: 'deferred',
};

const isRec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Read what `service_policy()` returns (the owner's choices over the defaults); anything unknown falls back to the default. */
export function parseServicePolicy(raw: unknown): ServicePolicy {
  const o = isRec(raw) ? raw : {};
  return {
    commissionBase: o.commission_base === 'as_sold' ? 'as_sold' : 'net',
    depositInvoice: typeof o.deposit_invoice === 'boolean' ? o.deposit_invoice : true,
    noshowFeeVat: typeof o.noshow_fee_vat === 'boolean' ? o.noshow_fee_vat : true,
    packageRevenue: o.package_revenue === 'at_sale' ? 'at_sale' : 'deferred',
  };
}

/** The body of `save_service_policy`. */
export const servicePolicyPayload = (p: ServicePolicy) => ({
  commission_base: p.commissionBase,
  deposit_invoice: p.depositInvoice,
  noshow_fee_vat: p.noshowFeeVat,
  package_revenue: p.packageRevenue,
});

export type PackageDeferredRow = {
  id: string;
  name: { th: string; en?: string };
  member: string;
  price: Satang;
  used: Satang;
  validUntil: string | null;
  expired: boolean;
  releasedByExpiry: Satang;
  deferred: Satang;
};
export type PackageDeferred = {
  asOf: string;
  policy: PackageRevenue | null;
  sold: Satang;
  releasedByVisits: Satang;
  releasedByExpiry: Satang;
  deferred: Satang;
  rows: PackageDeferredRow[];
};

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const s = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Read `package_deferred_report()`; null when it is not one. */
export function parsePackageDeferred(raw: unknown): PackageDeferred | null {
  if (!isRec(raw) || typeof raw.as_of !== 'string') return null;
  const rows = (Array.isArray(raw.rows) ? raw.rows : []).flatMap((r): PackageDeferredRow[] => {
    if (!isRec(r) || typeof r.id !== 'string') return [];
    const name = isRec(r.name) ? r.name : {};
    return [
      {
        id: r.id,
        name: { th: s(name.th), ...(s(name.en) ? { en: s(name.en) } : {}) },
        member: s(r.member),
        price: n(r.price),
        used: n(r.used),
        validUntil: typeof r.valid_until === 'string' ? r.valid_until : null,
        expired: r.expired === true,
        releasedByExpiry: n(r.released_by_expiry),
        deferred: n(r.deferred),
      },
    ];
  });
  return {
    asOf: raw.as_of,
    policy: raw.policy === 'at_sale' ? 'at_sale' : raw.policy === 'deferred' ? 'deferred' : null,
    sold: n(raw.sold),
    releasedByVisits: n(raw.released_by_visits),
    releasedByExpiry: n(raw.released_by_expiry),
    deferred: n(raw.deferred),
    rows,
  };
}

export type TipLogRow = {
  staffId: string;
  name: string;
  amount: Satang;
  status: 'owed' | 'paid';
  createdAt: string;
};
export type TipsPersonMonth = {
  month: string;
  staffId: string;
  name: string;
  taken: Satang;
  paidOut: Satang;
  owed: Satang;
};

/** Tips per person per Bangkok month: what was taken, what was already paid out, what is still owed. Not revenue, no VAT. */
export function tipsByPersonMonth(rows: readonly TipLogRow[]): TipsPersonMonth[] {
  const map = new Map<string, TipsPersonMonth>();
  for (const r of rows) {
    const d = new Date(r.createdAt);
    if (Number.isNaN(d.getTime())) continue;
    const month = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: '2-digit',
    })
      .format(d)
      .slice(0, 7);
    const key = `${month}|${r.staffId}`;
    const m = map.get(key) ?? {
      month,
      staffId: r.staffId,
      name: r.name,
      taken: 0,
      paidOut: 0,
      owed: 0,
    };
    m.taken += r.amount;
    if (r.status === 'paid') m.paidOut += r.amount;
    else m.owed += r.amount;
    map.set(key, m);
  }
  return [...map.values()].sort((a, b) =>
    a.month === b.month ? a.name.localeCompare(b.name) : b.month.localeCompare(a.month),
  );
}

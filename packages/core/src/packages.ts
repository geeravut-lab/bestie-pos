import type { LocalizedText } from './types';
import type { Satang } from './money';

/** Packages / memberships ("10 visits for the price of 8") — the pure part. The database does the selling and the counting. */
export type ServicePackage = {
  id: string;
  name: LocalizedText;
  price: Satang;
  visits: number;
  validDays: number | null;
  active: boolean;
};
export type PackageStatus = 'pending' | 'active' | 'used_up' | 'cancelled';
export type CustomerPackage = {
  id: string;
  customerId: string;
  name: LocalizedText;
  price: Satang;
  visitsTotal: number;
  visitsLeft: number;
  /** the last day it can be used (Bangkok date, "YYYY-MM-DD"), or null for no expiry */
  validUntil: string | null;
  status: PackageStatus;
};
/** What a person sees: the stored status plus "expired" (a date that has passed). */
export type PackageState = PackageStatus | 'expired';

export const packageState = (
  p: Pick<CustomerPackage, 'status' | 'validUntil'>,
  today: string,
): PackageState =>
  p.status === 'active' && p.validUntil !== null && p.validUntil < today ? 'expired' : p.status;

/** A package can pay for a visit when it is active, in date and has a visit left (the database checks the same). */
export const usablePackage = (p: CustomerPackage, today: string): boolean =>
  packageState(p, today) === 'active' && p.visitsLeft > 0;

/** What one visit is worth (price ÷ visits, rounded to the satang) — the same rounding as the database. */
export const visitValue = (price: Satang, visits: number): Satang =>
  visits > 0 ? Math.floor((price + Math.floor(visits / 2)) / visits) : 0;

/** What a package saves compared with paying per visit at `singlePrice` (never negative). */
export const packageSaving = (
  pkg: Pick<ServicePackage, 'price' | 'visits'>,
  singlePrice: Satang,
): Satang => Math.max(0, singlePrice * pkg.visits - pkg.price);

const isRec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const int = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 0;
};
const name = (v: unknown): LocalizedText | null =>
  isRec(v) && typeof v.th === 'string' && v.th
    ? { th: v.th, ...(typeof v.en === 'string' && v.en ? { en: v.en } : {}) }
    : null;

export function parseServicePackages(raw: unknown): ServicePackage[] {
  if (!Array.isArray(raw)) return [];
  const out: ServicePackage[] = [];
  for (const r of raw) {
    const n = isRec(r) ? name(r.name) : null;
    if (!isRec(r) || typeof r.id !== 'string' || !n) continue;
    out.push({
      id: r.id,
      name: n,
      price: int(r.price),
      visits: int(r.visits),
      validDays: r.valid_days === null || r.valid_days === undefined ? null : int(r.valid_days),
      active: r.active !== false,
    });
  }
  return out;
}

const STATUSES: readonly unknown[] = ['pending', 'active', 'used_up', 'cancelled'];
export function parseCustomerPackages(raw: unknown): CustomerPackage[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomerPackage[] = [];
  for (const r of raw) {
    const n = isRec(r) ? name(r.name) : null;
    if (
      !isRec(r) ||
      typeof r.id !== 'string' ||
      typeof r.customer_id !== 'string' ||
      !n ||
      !STATUSES.includes(r.status)
    )
      continue;
    out.push({
      id: r.id,
      customerId: r.customer_id,
      name: n,
      price: int(r.price),
      visitsTotal: int(r.visits_total),
      visitsLeft: int(r.visits_left),
      validUntil: typeof r.valid_until === 'string' ? r.valid_until.slice(0, 10) : null,
      status: r.status as PackageStatus,
    });
  }
  return out;
}

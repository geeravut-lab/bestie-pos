import { toCsv } from './csv';
import type { Satang } from './money';

/**
 * Commission and tips per staff — the pure part. The database computes the report from the frozen history
 * (`commission_report`); this reads it, formats percentages and builds the CSV.
 */
export type CommissionRow = {
  staffId: string;
  name: string;
  storeId: string;
  serviceSales: Satang;
  productSales: Satang;
  /** percent × 100 (basis points): 1000 = 10 % */
  serviceBps: number;
  productBps: number;
  commission: Satang;
};
export type CommissionRate = { staffId: string | null; serviceBps: number; productBps: number };
export type TipRow = {
  id: string;
  staffId: string;
  amount: Satang;
  method: 'cash' | 'promptpay' | 'gateway';
  status: 'owed' | 'paid';
  createdAt: string;
};

const isRec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const int = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 0;
};

export function parseCommissionReport(raw: unknown): CommissionRow[] {
  const rows = isRec(raw) && Array.isArray(raw.rows) ? raw.rows : [];
  const out: CommissionRow[] = [];
  for (const r of rows) {
    if (!isRec(r) || typeof r.staff_id !== 'string' || typeof r.name !== 'string') continue;
    out.push({
      staffId: r.staff_id,
      name: r.name,
      storeId: typeof r.store_id === 'string' ? r.store_id : '',
      serviceSales: int(r.service_sales),
      productSales: int(r.product_sales),
      serviceBps: int(r.service_bps),
      productBps: int(r.product_bps),
      commission: int(r.commission),
    });
  }
  return out;
}

export function parseCommissionRates(raw: unknown): CommissionRate[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRec).map((r) => ({
    staffId: typeof r.staff_id === 'string' ? r.staff_id : null,
    serviceBps: int(r.service_bps),
    productBps: int(r.product_bps),
  }));
}

export function parseTips(raw: unknown): TipRow[] {
  if (!Array.isArray(raw)) return [];
  const out: TipRow[] = [];
  for (const r of raw) {
    if (
      !isRec(r) ||
      typeof r.id !== 'string' ||
      typeof r.staff_id !== 'string' ||
      !['cash', 'promptpay', 'gateway'].includes(String(r.method)) ||
      !['owed', 'paid'].includes(String(r.status))
    )
      continue;
    const amount = int(r.amount);
    if (amount <= 0) continue;
    out.push({
      id: r.id,
      staffId: r.staff_id,
      amount,
      method: r.method as TipRow['method'],
      status: r.status as TipRow['status'],
      createdAt: typeof r.created_at === 'string' ? r.created_at : '',
    });
  }
  return out;
}

/** "10" → 1000, "7.5" → 750, "7,25" → 725; at most two decimals, 0–100; anything else → null. */
export function pctToBps(text: string): number | null {
  const m = /^\s*(\d{1,3})(?:[.,](\d{1,2}))?\s*$/.exec(text);
  if (!m) return null;
  const bps = Number(m[1]) * 100 + (m[2] ? Number(m[2].padEnd(2, '0')) : 0);
  return bps <= 10_000 ? bps : null;
}
/** 1000 → "10", 750 → "7.5", 725 → "7.25". */
export function bpsToPct(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = String(bps % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

export function commissionTotals(rows: readonly CommissionRow[]): {
  serviceSales: Satang;
  productSales: Satang;
  commission: Satang;
} {
  return rows.reduce(
    (a, r) => ({
      serviceSales: a.serviceSales + r.serviceSales,
      productSales: a.productSales + r.productSales,
      commission: a.commission + r.commission,
    }),
    { serviceSales: 0, productSales: 0, commission: 0 },
  );
}

/** What each person is owed in tips (money the guests gave for them that has not been paid out yet). */
export function tipsOwed(tips: readonly TipRow[]): Map<string, Satang> {
  const out = new Map<string, Satang>();
  for (const t of tips)
    if (t.status === 'owed') out.set(t.staffId, (out.get(t.staffId) ?? 0) + t.amount);
  return out;
}

/** The payroll CSV: amounts in plain baht (spreadsheet-friendly), the same numbers as the screen. */
export function commissionCsv(
  rows: readonly CommissionRow[],
  head: {
    name: string;
    services: string;
    products: string;
    serviceRate: string;
    productRate: string;
    commission: string;
  },
): string {
  // plain baht with two decimals by integer arithmetic (never a float for money)
  const baht = (n: Satang) =>
    `${n < 0 ? '-' : ''}${Math.floor(Math.abs(n) / 100)}.${String(Math.abs(n) % 100).padStart(2, '0')}`;
  return toCsv(
    [head.name, head.services, head.products, head.serviceRate, head.productRate, head.commission],
    rows.map((r) => [
      r.name,
      baht(r.serviceSales),
      baht(r.productSales),
      bpsToPct(r.serviceBps),
      bpsToPct(r.productBps),
      baht(r.commission),
    ]),
  );
}

// Delivery (LINE MAN / Grab / own riders): platforms, the commission they keep and what the screens read (module `delivery`, migration 77).
// Pure helpers only; the database decides (intake, the platform tender, the report).

export const DELIVERY_CODES = ['lineman', 'grab', 'own', 'other'] as const;
export type DeliveryCode = (typeof DELIVERY_CODES)[number];
/** The most a platform may keep, in basis points (the database refuses more). */
export const MAX_COMMISSION_BPS = 5000;

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => {
  const n = typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};

/** What the platform keeps of a bill, half up — the same arithmetic as `close_delivery_order`. */
export const deliveryCommission = (payable: number, bps: number): number =>
  Math.floor((payable * Math.max(0, Math.min(MAX_COMMISSION_BPS, bps)) + 5000) / 10000);

export type DeliveryPlatform = {
  id: string;
  code: DeliveryCode;
  name: string;
  commissionBps: number;
  active: boolean;
  /** The last 4 characters of the intake token (the token itself is never readable). */
  tokenHint: string | null;
};
export function parseDeliveryPlatforms(v: unknown): DeliveryPlatform[] {
  if (!Array.isArray(v)) return [];
  const out: DeliveryPlatform[] = [];
  for (const x of v) {
    const o = obj(x);
    const code = (DELIVERY_CODES as readonly string[]).includes(str(o.code))
      ? (str(o.code) as DeliveryCode)
      : null;
    if (!str(o.id) || !str(o.name) || !code) continue;
    out.push({
      id: str(o.id),
      code,
      name: str(o.name),
      commissionBps: Math.max(0, Math.min(MAX_COMMISSION_BPS, num(o.commission_bps))),
      active: o.active !== false,
      tokenHint: str(o.token_hint) || null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export type DeliveryReportRow = {
  platformId: string;
  name: string;
  code: DeliveryCode;
  commissionBps: number;
  bills: number;
  gross: number;
  commission: number;
  net: number;
  paidOut: number;
  owed: number;
};
export function parseDeliveryReport(v: unknown): DeliveryReportRow[] {
  if (!Array.isArray(v)) return [];
  const out: DeliveryReportRow[] = [];
  for (const x of v) {
    const o = obj(x);
    const code = (DELIVERY_CODES as readonly string[]).includes(str(o.code))
      ? (str(o.code) as DeliveryCode)
      : null;
    if (!str(o.platform_id) || !code) continue;
    out.push({
      platformId: str(o.platform_id),
      name: str(o.name),
      code,
      commissionBps: num(o.commission_bps),
      bills: num(o.bills),
      gross: num(o.gross),
      commission: num(o.commission),
      net: num(o.net),
      paidOut: num(o.paid_out),
      owed: num(o.owed),
    });
  }
  return out;
}

/** The totals of a report (every platform together). */
export function deliveryTotals(
  rows: readonly DeliveryReportRow[],
): Omit<DeliveryReportRow, 'platformId' | 'name' | 'code' | 'commissionBps'> {
  return rows.reduce(
    (t, r) => ({
      bills: t.bills + r.bills,
      gross: t.gross + r.gross,
      commission: t.commission + r.commission,
      net: t.net + r.net,
      paidOut: t.paidOut + r.paidOut,
      owed: t.owed + r.owed,
    }),
    { bills: 0, gross: 0, commission: 0, net: 0, paidOut: 0, owed: 0 },
  );
}

/** What a bill carries about its delivery (platform, the platform's own number, the customer). */
export type DeliveryInfo = {
  platformId: string | null;
  ref: string | null;
  name: string | null;
  phone: string | null;
  address: string | null;
};
export function parseDeliveryInfo(row: unknown): DeliveryInfo {
  const o = obj(row);
  const d = obj(o.delivery_info);
  return {
    platformId: str(o.delivery_platform_id) || null,
    ref: str(o.external_ref) || null,
    name: str(d.name) || null,
    phone: str(d.phone) || null,
    address: str(d.address) || null,
  };
}

/** The sample an integrator posts to `/api/delivery/intake` (shown on the screen next to the token). */
export const DELIVERY_INTAKE_SAMPLE = {
  ref: 'LM-240101-0007',
  name: 'Somchai',
  phone: '0812345678',
  address: 'Bungalow 4, Haad Rin',
  note: 'Please call at the gate',
  items: [
    { barcode: 'RICE-001', quantity: 2, note: 'extra spicy' },
    { sku: 'TEA-1', quantity: 1 },
  ],
} as const;

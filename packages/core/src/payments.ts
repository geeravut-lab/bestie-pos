/**
 * Paying a bill — the pure rules for CASH (the till may take cash with no signal) and the receipt that records it.
 * PromptPay / card / Credit / Points are confirmed by the server, never by this file.
 */
import { SATANG_PER_BAHT } from './money';
import type { Satang } from './money';
import { applyRounding } from './rounding';
import type { RoundingRule, TenderKind } from './rounding';
import { liveLines } from './orders';
import type { BillConfig, LineDoc, OrderDoc } from './orders';
import type { BillBreakdown } from './tax';
import type { Lang, LocalizedText } from './types';

export type PaymentDoc = {
  id: string;
  tender: TenderKind;
  /** Applied to the bill. */
  amount: Satang;
  /** Cash handed over (cash only). */
  tendered: Satang | null;
  change: Satang;
  createdAt: string;
};

export type ReceiptDoc = {
  /** Series of this device, consecutive: A-000123. */
  number: string;
  issuedAt: string;
  lang: Lang;
  sellerName: string;
  sellerTaxId: string | null;
  /** "00000" = head office. */
  branchCode: string;
  posId: string | null;
  vatRegistered: boolean;
  vatBps: number;
  serviceBps: number;
  priceMode: 'inclusive' | 'exclusive';
  subtotal: Satang;
  /** Bestie Points used as a discount on this bill (satang) and how many points that was. */
  pointsDiscount?: Satang;
  pointsUsed?: number;
  serviceCharge: Satang;
  vat: Satang;
  netBeforeVat: Satang;
  total: Satang;
  /** Cash rounding to the baht / 25 satang … (own line on the receipt). */
  rounding: Satang;
  payable: Satang;
  staffName: string | null;
  payments: PaymentDoc[];
};

// ── cash ────────────────────────────────────────────────────────────────────
export type CashSettlement = {
  /** What the guest owes in cash after the shop's cash rounding rule. */
  payable: Satang;
  /** payable − total: positive when rounded up, negative when rounded down. */
  rounding: Satang;
  change: Satang;
  /** > 0 while the cash handed over does not cover the bill. */
  short: Satang;
};

export function cashSettlement(
  total: Satang,
  rule: RoundingRule,
  tendered: Satang,
): CashSettlement {
  const { rounded, adjustment } = applyRounding(total, rule);
  return {
    payable: rounded,
    rounding: adjustment,
    change: Math.max(0, tendered - rounded),
    short: Math.max(0, rounded - tendered),
  };
}

const NOTES = [20, 50, 100, 500, 1000].map((b) => b * SATANG_PER_BAHT);

/** The buttons a cashier taps: the exact amount, then the next note combinations that cover it (at most 5). */
export function quickCashAmounts(payable: Satang): Satang[] {
  const out = new Set<Satang>([payable]);
  for (const note of NOTES) {
    const up = Math.ceil(payable / note) * note;
    if (up > payable) out.add(up);
  }
  return [...out].sort((a, b) => a - b).slice(0, 5);
}

// ── receipt ─────────────────────────────────────────────────────────────────
export type ReceiptSeller = {
  sellerName: string;
  sellerTaxId: string | null;
  branchCode: string;
  posId: string | null;
  vatRegistered: boolean;
  staffName: string | null;
};

/** The receipt of a cash payment, built from the bill that was ON SCREEN (what the guest agreed to pay). */
export function buildCashReceipt(p: {
  order: OrderDoc;
  bill: BillBreakdown;
  billConfig: BillConfig;
  roundingRule: RoundingRule;
  tendered: Satang;
  number: string;
  paymentId: string;
  seller: ReceiptSeller;
  lang: Lang;
  now: number;
}): ReceiptDoc {
  const s = cashSettlement(p.bill.total, p.roundingRule, p.tendered);
  if (s.short > 0) throw new Error('cash does not cover the bill');
  const at = new Date(p.now).toISOString();
  return {
    number: p.number,
    issuedAt: at,
    lang: p.lang,
    ...p.seller,
    vatBps: p.billConfig.vatBps,
    serviceBps: p.billConfig.serviceChargeBps,
    priceMode: p.billConfig.priceMode,
    subtotal: p.bill.subtotal,
    pointsDiscount: p.bill.pointsDiscount,
    pointsUsed: p.order.pointsUsed ?? 0,
    serviceCharge: p.bill.serviceCharge,
    vat: p.bill.vat,
    netBeforeVat: p.bill.netBeforeVat,
    total: p.bill.total,
    rounding: s.rounding,
    payable: s.payable,
    payments: [
      {
        id: p.paymentId,
        tender: 'cash',
        amount: s.payable,
        tendered: p.tendered,
        change: s.change,
        createdAt: at,
      },
    ],
  };
}

export const formatReceiptNumber = (deviceCode: string, seq: number): string =>
  `${deviceCode}-${String(seq).padStart(6, '0')}`;

/** The numeric part of a receipt number of one device series, or null for another series / a malformed number. */
export function receiptSeq(deviceCode: string, number: string): number | null {
  const m = new RegExp(`^${deviceCode}-(\\d{6,9})$`).exec(number);
  return m ? Number(m[1]) : null;
}

/** Branch 00000 is the head office; the label itself comes from the dictionary. */
export const isHeadOffice = (branchCode: string): boolean => branchCode === '00000';

/** Why a bill cannot be paid yet, if any. */
export function payBlockers(o: OrderDoc): ('closed' | 'empty' | 'unsent')[] {
  const out: ('closed' | 'empty' | 'unsent')[] = [];
  if (o.status === 'paid' || o.status === 'void') out.push('closed');
  const lines = liveLines(o);
  if (lines.length === 0) out.push('empty');
  if (lines.some((l) => l.status === 'new')) out.push('unsent');
  return out;
}

/** The order after it is paid: closed, with its receipt. (The server write is `closePayload`.) */
export function closeOrder(o: OrderDoc, r: ReceiptDoc): OrderDoc {
  return { ...o, status: 'paid', closedAt: r.issuedAt, receipt: r };
}

/** The one server call that closes a cash bill (RPC `close_order`). */
export function closePayload(
  o: OrderDoc,
  r: ReceiptDoc,
  p: { deviceId: string; staffId: string | null },
): Record<string, unknown> {
  return {
    order_id: o.id,
    receipt_number: r.number,
    device_id: p.deviceId,
    staff_id: p.staffId,
    issued_at: r.issuedAt,
    lang: r.lang,
    subtotal: r.subtotal,
    points_discount: r.pointsDiscount ?? 0,
    service_charge: r.serviceCharge,
    vat: r.vat,
    net_before_vat: r.netBeforeVat,
    total: r.total,
    rounding: r.rounding,
    payable: r.payable,
    vat_bps: r.vatBps,
    service_bps: r.serviceBps,
    price_mode: r.priceMode,
    payments: r.payments.map((x) => ({
      id: x.id,
      tender: x.tender,
      amount: x.amount,
      tendered: x.tendered,
      change: x.change,
      created_at: x.createdAt,
    })),
  };
}

/** What a receipt prints for each sold line (voided lines never appear). */
export type ReceiptLine = {
  name: LocalizedText;
  quantity: number;
  unitPrice: Satang;
  lineTotal: Satang;
  options: LocalizedText[];
};
export const receiptLines = (o: OrderDoc): ReceiptLine[] =>
  liveLines(o).map((l: LineDoc) => ({
    name: l.name,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    lineTotal: l.unitPrice * l.quantity,
    options: l.modifiers.map((m) => m.name),
  }));

/** Digital tenders the till may ASK for (the server confirms them; the till never closes these bills itself). */
export type OnlineTender = 'promptpay' | 'gateway';

/**
 * What the till shows the guest and sends with "start an online payment": the bill exactly as on screen, no cash rounding
 * (a QR or card payment is charged to the satang). The server re-checks it against the order's lines.
 */
export function onlineSnapshot(p: {
  order: OrderDoc;
  bill: BillBreakdown;
  billConfig: BillConfig;
  tender: OnlineTender;
  deviceId: string;
  staffId: string | null;
  lang: Lang;
  /**
   * A split bill: the cash / Credit legs that wait with this PromptPay / card share (each with a client id) and the cash
   * rounding that goes with them. The server charges the digital share only (amount due minus these legs).
   */
  split?: { rounding: number; legs: Record<string, unknown>[] };
}): Record<string, unknown> {
  const rounding = p.split?.rounding ?? 0;
  return {
    order_id: p.order.id,
    device_id: p.deviceId,
    staff_id: p.staffId,
    tender: p.tender,
    lang: p.lang,
    subtotal: p.bill.subtotal,
    points_discount: p.bill.pointsDiscount,
    service_charge: p.bill.serviceCharge,
    vat: p.bill.vat,
    net_before_vat: p.bill.netBeforeVat,
    total: p.bill.total,
    rounding,
    payable: p.bill.total + rounding,
    vat_bps: p.billConfig.vatBps,
    service_bps: p.billConfig.serviceChargeBps,
    price_mode: p.billConfig.priceMode,
    ...(p.split ? { legs: p.split.legs } : {}),
  };
}

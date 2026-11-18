import type { PaymentDoc, ReceiptDoc } from './payments';
import type { TenderKind } from './rounding';

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
/** Postgres bigint may arrive as a number or a numeric string. */
const int = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) ? n : null;
};
const TENDERS: readonly string[] = ['cash', 'promptpay', 'gateway', 'credit', 'points'];

/** Lenient read of a receipt + its payments as the server stores them (so any tablet can show / reprint it). */
export function receiptFromRows(r: Row, payments: readonly Row[]): ReceiptDoc | null {
  const number = str(r.number);
  const issuedAt = str(r.issued_at);
  const seller = str(r.seller_name);
  const branch = str(r.branch_code);
  const nums = [
    'subtotal',
    'service_charge',
    'vat',
    'net_before_vat',
    'total',
    'rounding',
    'payable',
    'vat_bps',
    'service_bps',
  ].map((k) => int(r[k]));
  if (!number || !issuedAt || !seller || !branch || nums.some((n) => n === null)) return null;
  const [subtotal, serviceCharge, vat, netBeforeVat, total, rounding, payable, vatBps, serviceBps] =
    nums as number[];
  const pays: PaymentDoc[] = [];
  for (const p of payments) {
    const id = str(p.id);
    const tender = str(p.tender);
    const amount = int(p.amount);
    if (
      !id ||
      !tender ||
      !TENDERS.includes(tender) ||
      amount === null ||
      str(p.status) === 'failed' ||
      str(p.status) === 'voided'
    )
      continue;
    pays.push({
      id,
      tender: tender as TenderKind,
      amount,
      tendered: int(p.tendered),
      change: int(p.change) ?? 0,
      createdAt: str(p.created_at) ?? issuedAt,
    });
  }
  return {
    number,
    issuedAt,
    lang: r.lang === 'en' ? 'en' : 'th',
    sellerName: seller,
    sellerTaxId: str(r.seller_tax_id),
    branchCode: branch,
    posId: str(r.pos_id),
    vatRegistered: r.vat_registered === true,
    vatBps: vatBps!,
    serviceBps: serviceBps!,
    priceMode: r.price_mode === 'exclusive' ? 'exclusive' : 'inclusive',
    subtotal: subtotal!,
    pointsDiscount: int(r.points_discount) ?? 0,
    pointsUsed: int(r.points_used) ?? 0,
    serviceCharge: serviceCharge!,
    vat: vat!,
    netBeforeVat: netBeforeVat!,
    total: total!,
    rounding: rounding!,
    payable: payable!,
    staffName: null,
    payments: pays,
  };
}

import { formatTHB, isHeadOffice, localizedName, receiptLines } from '@bestie/core';
import type { Lang, OrderDoc, ReceiptDoc } from '@bestie/core';
import { dict, fmt, formatDateTime } from '@bestie/i18n';

/** What a printed receipt is made of; the same facts as `ReceiptView`, as plain rows a canvas or a text printer can draw. */
export type ReceiptRow =
  | { kind: 'center'; text: string; strong?: boolean; big?: boolean }
  | { kind: 'row'; left: string; right: string; strong?: boolean; sub?: string }
  | { kind: 'note'; text: string }
  | { kind: 'rule' };

/** Rows of one receipt in the language the GUEST wants. Pure: nothing here touches the DOM or a device. */
export function buildReceiptRows(order: OrderDoc, receipt: ReceiptDoc, lang: Lang): ReceiptRow[] {
  const d = dict[lang];
  const locale = lang === 'th' ? ('th-TH' as const) : ('en-GB' as const);
  const money = (n: number) => formatTHB(n, locale);
  const cash = receipt.payments.filter((p) => p.tender === 'cash');
  const cashPaid = cash.reduce((a, p) => a + (p.tendered ?? p.amount), 0);
  const change = cash.reduce((a, p) => a + p.change, 0);

  const rows: ReceiptRow[] = [
    { kind: 'center', text: receipt.sellerName, strong: true, big: true },
  ];
  if (receipt.sellerTaxId)
    rows.push({ kind: 'center', text: fmt(d.receiptTaxId, { id: receipt.sellerTaxId }) });
  rows.push({
    kind: 'center',
    text: isHeadOffice(receipt.branchCode)
      ? d.receiptHeadOffice
      : fmt(d.receiptBranch, { code: receipt.branchCode }),
  });
  if (receipt.posId)
    rows.push({ kind: 'center', text: fmt(d.receiptPosId, { id: receipt.posId }) });
  rows.push({
    kind: 'center',
    text: receipt.vatRegistered ? d.receiptTitleTax : d.receiptTitle,
    strong: true,
  });
  rows.push({ kind: 'center', text: fmt(d.receiptNumber, { number: receipt.number }) });
  rows.push({ kind: 'center', text: formatDateTime(lang, receipt.issuedAt) });
  rows.push({ kind: 'center', text: fmt(d.receiptOrder, { number: order.number }) });
  if (receipt.staffName)
    rows.push({ kind: 'center', text: fmt(d.receiptCashier, { name: receipt.staffName }) });
  rows.push({ kind: 'rule' });

  for (const l of receiptLines(order)) {
    rows.push({
      kind: 'row',
      left: `${l.quantity} × ${localizedName(l.name, lang)}`,
      right: money(l.lineTotal),
      ...(l.options.length > 0
        ? { sub: `(${l.options.map((o) => localizedName(o, lang)).join(', ')})` }
        : {}),
    });
  }
  rows.push({ kind: 'rule' });

  rows.push({ kind: 'row', left: d.receiptSubtotal, right: money(receipt.subtotal) });
  if ((receipt.pointsDiscount ?? 0) > 0)
    rows.push({
      kind: 'row',
      left: fmt(d.receiptPointsDiscount, { n: receipt.pointsUsed ?? 0 }),
      right: `−${money(receipt.pointsDiscount ?? 0)}`,
    });
  if (receipt.serviceCharge > 0)
    rows.push({ kind: 'row', left: d.receiptService, right: money(receipt.serviceCharge) });
  if (receipt.rounding !== 0)
    rows.push({
      kind: 'row',
      left: d.receiptRounding,
      right: `${receipt.rounding > 0 ? '+' : '−'}${money(Math.abs(receipt.rounding))}`,
    });
  rows.push({ kind: 'row', left: d.receiptTotal, right: money(receipt.payable), strong: true });
  if (receipt.vatRegistered) {
    rows.push({ kind: 'row', left: d.receiptNet, right: money(receipt.netBeforeVat) });
    rows.push({
      kind: 'row',
      left: fmt(d.receiptVat, { rate: receipt.vatBps / 100 }),
      right: money(receipt.vat),
    });
  }
  for (const p of receipt.payments.filter(
    (x) => x.tender === 'promptpay' || x.tender === 'gateway',
  ))
    rows.push({
      kind: 'row',
      left: p.tender === 'promptpay' ? d.receiptPromptPay : d.receiptCard,
      right: money(p.amount),
    });
  if (cash.length > 0) {
    rows.push({ kind: 'row', left: d.receiptCash, right: money(cashPaid) });
    rows.push({ kind: 'row', left: d.receiptChange, right: money(change) });
  }
  rows.push({ kind: 'rule' });
  if (receipt.vatRegistered && receipt.priceMode === 'inclusive')
    rows.push({ kind: 'note', text: d.receiptVatIncluded });
  rows.push({ kind: 'note', text: d.receiptThanks });
  return rows;
}

/** A fixed example receipt for "Test print" (no real sale, clearly marked). */
export function sampleReceiptRows(lang: Lang): ReceiptRow[] {
  const d = dict[lang];
  return [
    { kind: 'center', text: 'Bestie POS', strong: true, big: true },
    { kind: 'center', text: d.printTestTitle, strong: true },
    { kind: 'rule' },
    {
      kind: 'row',
      left: '2 × Pad Thai',
      right: formatTHB(36000, lang === 'th' ? 'th-TH' : 'en-GB'),
    },
    {
      kind: 'row',
      left: '1 × Iced latte',
      right: formatTHB(8500, lang === 'th' ? 'th-TH' : 'en-GB'),
    },
    { kind: 'rule' },
    {
      kind: 'row',
      left: d.receiptTotal,
      right: formatTHB(44500, lang === 'th' ? 'th-TH' : 'en-GB'),
      strong: true,
    },
    { kind: 'rule' },
    { kind: 'note', text: d.printTestNote },
  ];
}

import { formatTHB, isHeadOffice, localizedName, receiptLines } from '@bestie/core';
import type { Lang, OrderDoc, ReceiptDoc } from '@bestie/core';
import { dict, fmt, formatDateTime } from '@bestie/i18n';

/**
 * The receipt as a guest gets it, in the language the GUEST wants (not the staff's screen language). It carries what the
 * Revenue Department asks of an abbreviated tax invoice: seller, tax id, branch, POS ID, number, date, VAT breakdown.
 * The same facts will feed the ESC/POS printer.
 */
export function ReceiptView({
  order,
  receipt,
  lang,
}: {
  order: OrderDoc;
  receipt: ReceiptDoc;
  lang: Lang;
}) {
  const d = dict[lang];
  const locale = lang === 'th' ? ('th-TH' as const) : ('en-GB' as const);
  const money = (n: number) => formatTHB(n, locale);
  const cash = receipt.payments.filter((p) => p.tender === 'cash');
  const cashPaid = cash.reduce((a, p) => a + (p.tendered ?? p.amount), 0);
  const change = cash.reduce((a, p) => a + p.change, 0);

  return (
    <article className="receipt receipt-print" lang={lang} aria-label={d.receiptTitle}>
      <header>
        <h2>{receipt.sellerName}</h2>
        {receipt.sellerTaxId ? <p>{fmt(d.receiptTaxId, { id: receipt.sellerTaxId })}</p> : null}
        <p>
          {isHeadOffice(receipt.branchCode)
            ? d.receiptHeadOffice
            : fmt(d.receiptBranch, { code: receipt.branchCode })}
        </p>
        {receipt.posId ? <p>{fmt(d.receiptPosId, { id: receipt.posId })}</p> : null}
        <p>
          <strong>{receipt.vatRegistered ? d.receiptTitleTax : d.receiptTitle}</strong>
        </p>
        <p>{fmt(d.receiptNumber, { number: receipt.number })}</p>
        <p>{formatDateTime(lang, receipt.issuedAt)}</p>
        <p>{fmt(d.receiptOrder, { number: order.number })}</p>
        {receipt.staffName ? <p>{fmt(d.receiptCashier, { name: receipt.staffName })}</p> : null}
      </header>
      <hr />
      <ul className="receipt-lines">
        {receiptLines(order).map((l, i) => (
          <li key={i}>
            <span>
              {l.quantity} × {localizedName(l.name, lang)}
              {l.options.length > 0 ? (
                <small> ({l.options.map((o) => localizedName(o, lang)).join(', ')})</small>
              ) : null}
            </span>
            <span className="tabular">{money(l.lineTotal)}</span>
          </li>
        ))}
      </ul>
      <hr />
      <dl className="receipt-totals tabular">
        <div>
          <dt>{d.receiptSubtotal}</dt>
          <dd>{money(receipt.subtotal)}</dd>
        </div>
        {(receipt.pointsDiscount ?? 0) > 0 ? (
          <div>
            <dt>{fmt(d.receiptPointsDiscount, { n: receipt.pointsUsed ?? 0 })}</dt>
            <dd>−{money(receipt.pointsDiscount ?? 0)}</dd>
          </div>
        ) : null}
        {receipt.serviceCharge > 0 ? (
          <div>
            <dt>{d.receiptService}</dt>
            <dd>{money(receipt.serviceCharge)}</dd>
          </div>
        ) : null}
        {receipt.rounding !== 0 ? (
          <div>
            <dt>{d.receiptRounding}</dt>
            <dd>
              {receipt.rounding > 0 ? '+' : '−'}
              {money(Math.abs(receipt.rounding))}
            </dd>
          </div>
        ) : null}
        <div className="receipt-grand">
          <dt>{d.receiptTotal}</dt>
          <dd>{money(receipt.payable)}</dd>
        </div>
        {receipt.vatRegistered ? (
          <>
            <div>
              <dt>{d.receiptNet}</dt>
              <dd>{money(receipt.netBeforeVat)}</dd>
            </div>
            <div>
              <dt>{fmt(d.receiptVat, { rate: receipt.vatBps / 100 })}</dt>
              <dd>{money(receipt.vat)}</dd>
            </div>
          </>
        ) : null}
        {receipt.payments
          .filter((p) => p.tender === 'promptpay' || p.tender === 'gateway')
          .map((p) => (
            <div key={p.id}>
              <dt>{p.tender === 'promptpay' ? d.receiptPromptPay : d.receiptCard}</dt>
              <dd>{money(p.amount)}</dd>
            </div>
          ))}
        {cash.length > 0 ? (
          <>
            <div>
              <dt>{d.receiptCash}</dt>
              <dd>{money(cashPaid)}</dd>
            </div>
            <div>
              <dt>{d.receiptChange}</dt>
              <dd>{money(change)}</dd>
            </div>
          </>
        ) : null}
      </dl>
      {receipt.vatRegistered && receipt.priceMode === 'inclusive' ? (
        <p className="receipt-note">{d.receiptVatIncluded}</p>
      ) : null}
      <p className="receipt-note">{d.receiptThanks}</p>
    </article>
  );
}

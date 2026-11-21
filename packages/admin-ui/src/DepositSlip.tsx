import { useEffect, useState } from 'react';
import { formatTHB } from '@bestie/core';
import type { Deposit } from '@bestie/core';
import { fmt, formatDateTime, useI18n } from '@bestie/i18n';
import type { Dict } from '@bestie/i18n';
import type { PageContext } from '@bestie/auth';
import { PrintPortal } from './PrintPortal';

type Seller = { shop: string; name: string; taxId: string; branch: string; vatBps: number };
const tx = (t: Dict, key: string): string => (t as Record<string, string>)[key] ?? key;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** What the slip needs about the seller: read the moment the person asks to print (the shop's own rows, nothing the guest typed). */
export async function loadSeller(ctx: PageContext, storeId: string): Promise<Seller | null> {
  const s = await ctx.client
    .from('stores')
    .select('name, branch_code, vat_registered, vat_bps, legal_entity_id')
    .eq('id', storeId)
    .maybeSingle();
  if (s.error || !s.data) return null;
  const r = s.data as Record<string, unknown>;
  const le = r.legal_entity_id
    ? await ctx.client
        .from('legal_entities')
        .select('name, tax_id')
        .eq('id', str(r.legal_entity_id))
        .maybeSingle()
    : { data: null };
  const l = (le.data ?? {}) as Record<string, unknown>;
  return {
    shop: str(r.name),
    name: str(l.name),
    taxId: str(l.tax_id),
    branch: str(r.branch_code),
    vatBps: r.vat_registered === true && typeof r.vat_bps === 'number' ? r.vat_bps : 0,
  };
}

/**
 * A deposit receipt (the day the money came in) or a kept no-show fee receipt, on 80 mm paper, with the VAT shown for a VAT shop.
 * Prints once when mounted and tells the parent when it is done. The FORM of the document is the accountant's to confirm.
 */
export function DepositSlip({
  deposit,
  fee,
  seller,
  service,
  guest,
  onDone,
}: {
  deposit: Deposit;
  fee: boolean;
  seller: Seller;
  service: string;
  guest: string;
  onDone: () => void;
}) {
  const { t, lang } = useI18n();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- wait one paint so the slip is in #print-root before the dialog opens
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    const id = window.setTimeout(() => {
      window.print();
      onDone();
    }, 80);
    return () => window.clearTimeout(id);
  }, [ready, onDone]);

  const no = fee ? deposit.feeInvoiceNo : deposit.invoiceNo;
  const vat = (fee ? deposit.feeVat : deposit.invoiceVat) ?? 0;
  const when = fee ? deposit.resolvedAt : deposit.createdAt;
  return (
    <PrintPortal pageCss="@page { size: 80mm auto; margin: 4mm; }">
      <div className="return-slip">
        <h1>{seller.name || seller.shop}</h1>
        <p>{seller.shop}</p>
        {seller.taxId ? (
          <p>
            {t.depSlipTaxId}: {seller.taxId}
            {seller.branch ? ` · ${t.depSlipBranch} ${seller.branch}` : ''}
          </p>
        ) : null}
        <h2>{fee ? t.depSlipFeeTitle : t.depSlipTitle}</h2>
        <p>
          {t.depSlipNo}: {no ?? '—'}
        </p>
        {when ? (
          <p>
            {t.depSlipDate}: {formatDateTime(lang, when)}
          </p>
        ) : null}
        <p>
          {t.depSlipFor}: {service}
          {guest ? ` · ${guest}` : ''}
        </p>
        {!fee ? (
          <p>
            {t.depSlipMethod}: {tx(t, `calDepMethod_${deposit.method}`)}
          </p>
        ) : null}
        <table>
          <tbody>
            {seller.vatBps > 0 ? (
              <>
                <tr>
                  <td>{t.depSlipNet}</td>
                  <td>{formatTHB(deposit.amount - vat)}</td>
                </tr>
                <tr>
                  <td>{fmt(t.depSlipVat, { rate: seller.vatBps / 100 })}</td>
                  <td>{formatTHB(vat)}</td>
                </tr>
              </>
            ) : null}
            <tr>
              <td>
                <strong>{t.depSlipTotal}</strong>
              </td>
              <td>
                <strong>{formatTHB(deposit.amount)}</strong>
              </td>
            </tr>
          </tbody>
        </table>
        {seller.vatBps === 0 ? <p className="return-slip-note">{t.depSlipNoVat}</p> : null}
        <p className="return-slip-note">{fee ? t.depSlipNoteFee : t.depSlipNoteDeposit}</p>
        <p className="return-slip-note">{t.depSlipDraft}</p>
      </div>
    </PrintPortal>
  );
}
